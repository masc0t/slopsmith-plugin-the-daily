# Prompt 08 — Passport endpoint

## Goal

Backend endpoint that returns the user's full local Daily history as a list of one-row-per-day records, plus stamp earn dates. Frontend (prompt 12) will render this as the passport grid + stamp shelf.

## Read first

- `plans/03-tokens-shop-passport.md` (Passport section)
- `plans/adr/0001-recovery-code-identity-and-local-primary-mirror.md` (passport reach decisions)
- `plans/adr/0004-lane-streak-semantics.md` (committed_lane / mixed / NULL handling)

## Files allowed to touch

- `routes.py`

## Spec

```python
@app.get("/api/plugins/the_daily/passport")
def get_passport(request: Request):
    install_id = _get_install_id_from_request(request)

    # Past days: every daily_setlists row with at least one completion for this install,
    # plus today (whether complete or not, so the cell exists for the in-progress day).
    rows = _conn.execute("""
        SELECT
            ds.date,
            ds.day_name,
            ds.modifier,
            dc.committed_lane,
            COUNT(dcomp.cf_id)        AS done_count,
            ds.song_count
        FROM daily_setlists ds
        LEFT JOIN daily_completions dc ON dc.date = ds.date AND dc.install_id = ?
        LEFT JOIN daily_completions dcomp ON dcomp.date = ds.date AND dcomp.install_id = ?
        WHERE ds.date <= ?
        GROUP BY ds.date
        ORDER BY ds.date ASC
    """, (install_id, install_id, date.today().isoformat())).fetchall()

    days = []
    for r in rows:
        d, day_name, modifier, lane, done, total = r
        days.append({
            "date": d,
            "day_name": day_name,
            "modifier": modifier,
            "lane": lane,                              # may be NULL on legacy rows (ADR-0004)
            "boss_done": done >= total if total else False,
            "full_clear": False,                       # tighten when full-clear tracking lands
            "streak_at": None,                         # populated below
        })

    # Compute streak_at for each day by walking forward (cheap — just counts consecutive completions)
    streak = 0
    for d in days:
        if d["boss_done"]:
            streak += 1
        else:
            streak = 0
        d["streak_at"] = streak

    # Stamps earned by this install
    stamp_rows = _conn.execute(
        "SELECT stamp_id, earned_date FROM daily_stamps WHERE install_id = ? ORDER BY earned_date ASC",
        (install_id,)
    ).fetchall()
    stamps_earned = [{"id": s[0], "earned_date": s[1]} for s in stamp_rows]

    # Stamp progress for unearned stamps (per V1 catalog — see stamps prompt 04 + plan 03)
    agg = _compute_stamp_aggregates(_conn, install_id)
    earned_ids = {s["id"] for s in stamps_earned}
    progress = []
    for stamp_id, definition in V1_STAMPS.items():
        if stamp_id in earned_ids:
            continue
        progress.append({
            "id": stamp_id,
            "current": definition["progress_fn"](agg) if "progress_fn" in definition else 0,
            "target": definition.get("target", 1),
        })

    # Lifetime totals for the top-strip of the passport
    totals = {
        "total_dailies": sum(1 for d in days if d["boss_done"]),
        "longest_streak": max((d["streak_at"] for d in days), default=0),
        "current_streak": days[-1]["streak_at"] if days else 0,
        "lifetime_tokens_earned": _conn.execute(
            "SELECT COALESCE(SUM(delta), 0) FROM daily_token_ledger WHERE install_id = ? AND delta > 0",
            (install_id,)
        ).fetchone()[0],
    }

    return {
        "days": days,
        "stamps_earned": stamps_earned,
        "stamps_progress": progress,
        "totals": totals,
    }
```

`V1_STAMPS` is a small dict shadowing the stamp catalog from prompt 04 (you may need to mirror it server-side). Each entry needs:

- `target` — the threshold count (e.g. 10 for `lane_sprint_10`).
- `progress_fn(agg)` — returns the user's current count toward the target. Use the existing `_compute_stamp_aggregates` output.

If you don't want to duplicate the catalog, expose only `stamps_earned` from this endpoint and let the frontend compute progress from the same `agg` it queries via a separate `/stamps/aggregate` endpoint. Either is acceptable — pick the simpler one.

### Backfill behavior

Per ADR-0001 / Q6 grill: passport reach is full local history. Lane glyph is NULL/blank for pre-feature rows (no committed_lane backfill). No stamp backfill — stamps earn forward only.

The endpoint as written naturally produces blank lane on legacy rows because `daily_completions.committed_lane` was added later and is NULL for old completions. No special handling needed.

## Verification

```bash
python -c "import ast; ast.parse(open('routes.py', encoding='utf-8').read())"
pytest tests/ -v
grep -n "/passport" routes.py

# Manual:
curl http://localhost:PORT/api/plugins/the_daily/passport -H "X-Install-Id: t" | python -m json.tool
```

The output should have keys `days`, `stamps_earned`, `stamps_progress`, `totals`. `days` length equals number of `daily_setlists` rows up to today.

## Out of scope

- Frontend passport screen is prompt 12.
- Do not implement passport export (PNG/SVG share card). Out of V1.
- Do not retroactively fill `committed_lane` on legacy rows. ADR-0004 says don't.
- Do not implement Supabase pull of historic passport entries — V1 mirror is push-only for current-day rows. Restoring full history from another install is a V2 feature.
