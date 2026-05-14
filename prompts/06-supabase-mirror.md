# Prompt 06 — Supabase mirror push/pull

## Goal

Implement the local→Supabase mirror push and the one-time pull on code adoption, per ADR-0001. Mirror is keyed by `recovery_code`, not `install_id`. Push triggers fire on five hook points (boss clear, shop purchase, equip change, stamp earn, app close); pull only on first paste of a code.

## Read first

- `plans/adr/0001-recovery-code-identity-and-local-primary-mirror.md`
- `routes.py` — find existing Supabase calls (anon key + URL constants at top); imitate the request pattern

## Files allowed to touch

- `routes.py`

## Pre-reqs

Prompt 05 must have landed. This prompt assumes `_get_or_create_recovery_code` exists.

## Spec

### 1. Supabase tables (run manually in Supabase dashboard before deploying)

Document required schema in a comment at the top of the new mirror section:

```python
# Mirror schema (create manually in Supabase SQL editor):
#
# CREATE TABLE inventory (
#     recovery_code TEXT PRIMARY KEY,
#     tokens INTEGER NOT NULL DEFAULT 0,
#     cosmetics JSONB NOT NULL DEFAULT '[]',
#     equipped JSONB NOT NULL DEFAULT '{}',
#     stamps JSONB NOT NULL DEFAULT '[]',
#     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
# );
#
# CREATE TABLE passport_entries (
#     recovery_code TEXT NOT NULL,
#     date TEXT NOT NULL,
#     day_name TEXT,
#     modifier TEXT,
#     lane TEXT,
#     boss_done BOOLEAN NOT NULL DEFAULT FALSE,
#     full_clear BOOLEAN NOT NULL DEFAULT FALSE,
#     streak_at INTEGER,
#     PRIMARY KEY (recovery_code, date)
# );
#
# Both tables should allow public insert/update via anon key (RLS off, or
# permissive policy). Same trust model as the existing leaderboard table.
```

### 2. Push function

```python
def _mirror_push(install_id: str) -> bool:
    """Best-effort push of local inventory + recent passport entries to Supabase.
    Returns True on success, False on any failure (logged but not raised)."""
    if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
        return False
    code = _get_or_create_recovery_code(_conn, install_id)
    inv = _conn.execute(
        "SELECT tokens, cosmetics, equipped FROM daily_inventory WHERE install_id = ?",
        (install_id,)
    ).fetchone()
    if not inv:
        return False
    stamps = [r[0] for r in _conn.execute(
        "SELECT stamp_id FROM daily_stamps WHERE install_id = ?", (install_id,)
    ).fetchall()]
    payload = {
        "recovery_code": code,
        "tokens": inv[0],
        "cosmetics": json.loads(inv[1] or "[]"),
        "equipped": json.loads(inv[2] or "{}"),
        "stamps": stamps,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/inventory",
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",  # upsert on PK
            },
            json=payload,
            timeout=4,
        )
        if r.status_code >= 400:
            logger.warning("mirror push failed: %s %s", r.status_code, r.text[:200])
            return False
    except Exception as e:
        logger.warning("mirror push exception: %s", e)
        return False

    # Passport entries: push today's row only (idempotent upsert)
    today = date.today().isoformat()
    today_row = _conn.execute("""
        SELECT day_name, modifier, committed_lane,
               (SELECT COUNT(*) FROM daily_completions WHERE date = ds.date AND install_id = ?) AS done_count,
               song_count
        FROM daily_setlists ds WHERE date = ?
    """, (install_id, today)).fetchone()
    if today_row and today_row[3] > 0:
        passport_payload = {
            "recovery_code": code,
            "date": today,
            "day_name": today_row[0],
            "modifier": today_row[1],
            "lane": today_row[2],
            "boss_done": today_row[3] >= today_row[4],
            "full_clear": False,  # tighten later
            "streak_at": _compute_streak(_conn, install_id, today),
        }
        try:
            requests.post(
                f"{SUPABASE_URL}/rest/v1/passport_entries",
                headers={
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                    "Content-Type": "application/json",
                    "Prefer": "resolution=merge-duplicates",
                },
                json=passport_payload,
                timeout=4,
            )
        except Exception as e:
            logger.warning("passport push exception: %s", e)
    return True
```

### 3. Debounced trigger

Single coalescing trigger with 2s debounce:

```python
import threading
_mirror_timer = None
_mirror_timer_lock = threading.Lock()

def _mirror_push_debounced(install_id: str):
    global _mirror_timer
    with _mirror_timer_lock:
        if _mirror_timer is not None:
            _mirror_timer.cancel()
        _mirror_timer = threading.Timer(2.0, _mirror_push, args=[install_id])
        _mirror_timer.daemon = True
        _mirror_timer.start()
```

### 4. Hook points

Wire `_mirror_push_debounced(install_id)` into the existing five points:

1. Boss clear — find the path in `/mark` where the day reconcile happens (hint: where token grants are written). After the reconcile, call the debouncer.
2. Shop purchase — prompt 07's POST `/shop/buy` will call this. For now, leave a TODO comment in the existing inventory-mutating endpoints.
3. Equip change — same.
4. Stamp earn — find `_check_stamps`; after a new stamp is inserted, debounce.
5. App close — there is no explicit "app close" event, but `/api/plugins/the_daily/sync-now` (a new endpoint) lets the frontend signal it. Implement:

```python
@app.post("/api/plugins/the_daily/sync-now")
async def sync_now(request: Request):
    install_id = _get_install_id_from_request(request)
    ok = _mirror_push(install_id)  # synchronous, not debounced
    return {"ok": ok}
```

### 5. Pull on adopt

Update `adopt_recovery_code` (from prompt 05) to attempt a pull from Supabase before overwriting local:

```python
def _mirror_pull(code: str) -> dict | None:
    """Fetch inventory row for a recovery code. Returns None on failure or 404."""
    if not SUPABASE_URL or SUPABASE_URL.startswith("https://YOURPROJECT"):
        return None
    try:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/inventory?recovery_code=eq.{code}",
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            },
            timeout=4,
        )
        if r.status_code != 200:
            return None
        rows = r.json()
        return rows[0] if rows else None
    except Exception:
        return None
```

In `adopt_recovery_code`:

```python
remote = _mirror_pull(new_code)
if remote:
    # Overwrite local inventory with remote row
    with _write_lock:
        _conn.execute("""
            INSERT INTO daily_inventory (install_id, recovery_code, tokens, cosmetics, equipped)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(install_id) DO UPDATE SET
              recovery_code = excluded.recovery_code,
              tokens = excluded.tokens,
              cosmetics = excluded.cosmetics,
              equipped = excluded.equipped
        """, (
            install_id, new_code,
            remote.get("tokens", 0),
            json.dumps(remote.get("cosmetics", [])),
            json.dumps(remote.get("equipped", {})),
        ))
        # Replace stamps too
        _conn.execute("DELETE FROM daily_stamps WHERE install_id = ?", (install_id,))
        for sid in remote.get("stamps", []):
            _conn.execute(
                "INSERT INTO daily_stamps (install_id, stamp_id, earned_date) VALUES (?, ?, ?)",
                (install_id, sid, date.today().isoformat())
            )
        _conn.commit()
    return {"code": new_code, "adopted": True, "restored": True}
# else: no remote row, just adopt the code locally as in prompt 05
```

## Verification

```bash
python -c "import ast; ast.parse(open('routes.py', encoding='utf-8').read())"
pytest tests/ -v
grep -n "_mirror_push\|_mirror_pull\|_mirror_push_debounced" routes.py
grep -n "/sync-now" routes.py
```

Manual smoke test (requires real Supabase URL configured):

```bash
curl -X POST http://localhost:PORT/api/plugins/the_daily/sync-now -H "X-Install-Id: testid"
# {"ok": true}
```

## Out of scope

- Do not implement the recovery-code modal — prompt 10.
- Do not implement multi-device merge logic. ADR-0001 explicitly chose single-identity LWW; pulling on adopt overwrites local, period.
- Do not periodically poll Supabase. Pull is exclusively on code adoption.
- Do not push the token ledger. Per Q12 grill it is local-only.
- Do not error if Supabase is not configured; the `if not SUPABASE_URL` guards make all mirror calls no-op.
