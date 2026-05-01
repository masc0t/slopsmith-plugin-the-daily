# Plan: Lanes as Stations

> **Status: amended by ADR-0004 (lane streak semantics).** See ADR for the canonical contract on membership, forced-modifier days, and mixed-day storage. Inline corrections below mark where the plan's recommendations were superseded.

Make the lane (`standard` / `drop` / `flat` / `sprint` / `marathon` / `decade_*`) a meaningful identity choice, not decoration. The path you walk through the map *is* the kind of run you signed up for, and the leaderboard reflects that.

## Goal

- Lanes feel like radio stations — pick a vibe (Sprint, Marathon, Drop) and the run is shaped accordingly.
- Per-lane streaks and leaderboards exist alongside the global ones.
- Picking a lane does not modify how songs play; it only constrains which nodes are on your path.

## What "committed lane" means

A user's **committed lane for a day** = the lane of the last node they cleared on the path that includes the boss. Equivalently: the lane label of the path they actually walked. If a user walked a mixed path (jumped lanes mid-map), their committed lane is `mixed` and that day does not contribute to any per-lane streak (but still contributes to the global streak).

**Lane membership is song-nodes-only.** `lane_paths` lists only forced/elite/boss/mystery/choice nodes. Rest, treasure, and shop are excluded — they are economy/info surfaces (plans 02 and 03), not genre commitments. Mystery nodes inherit the lane they are planted on regardless of which song the event delivers. See ADR-0004.

For days where the modifier overrides lane structure (e.g. `identity:decade` produces a single decade lane for everyone), the committed lane is whatever the map exposes. Per-lane streak math handles these via the **frozen-skip rule**: streak walk for lane X skips days where X was unavailable (`X not in lane_paths`) rather than breaking on them. See ADR-0004.

## Data model

### Local SQLite (`the_daily.db`)

Add one column to `daily_completions`:

```sql
ALTER TABLE daily_completions ADD COLUMN committed_lane TEXT;
```

Backfill on first connection: leave NULL for existing rows. `_ensure_column` already exists in routes.py — reuse it.

Optionally add a small lookup row to `daily_setlists` so we can compute the committed lane server-side without recomputing from the graph each time:

```sql
ALTER TABLE daily_setlists ADD COLUMN lane_paths TEXT;  -- JSON: { "sprint": ["n1","n3","n5"], ... }
```

Populated at setlist generation time from the existing map graph.

### Supabase (`leaderboard` table)

Add columns:

- `lane TEXT` — e.g. `"sprint"`, `"marathon"`, `"mixed"`, `null` (legacy rows).
- Existing `streak INTEGER` stays as the global streak.
- New `lane_streak INTEGER` — sent by client at sign time, computed locally.

No RLS change needed; the anon key already has insert permission.

## Backend

### `routes.py` — `_compute_committed_lane(conn, date_str, install_id)`

Read `daily_completions` for the date+install_id, plus `lane_paths` from `daily_setlists`. Return the lane whose path is fully covered by completions, or `"mixed"` if completions span multiple lanes, or `None` if the day isn't complete.

### `_compute_lane_streak(conn, today_str, lane)`

Walk backwards day-by-day like `_compute_streak`, but only count days whose `committed_lane` equals `lane`. Stop at the first day that's either missing or has a different lane.

### `/mark` and `/sign`

- `/mark` doesn't change. Lane is computed from completions, not stored per node.
- `/sign` computes `committed_lane` and `lane_streak` server-side, sends both to Supabase along with the existing payload. **Always include lane fields, no conditional rejection.** Mixed-path days store `lane = 'mixed'` and `lane_streak = 0`; lane-filtered leaderboard queries (`?lane=eq.sprint`, `?lane=like.decade_*`) exclude `mixed` and NULL naturally. Mixed users still appear on the Global tab. See ADR-0004.

### `/leaderboard?lane=sprint`

Add a `lane` query param to the existing leaderboard endpoint. Filter at the Supabase query level (`leaderboard?lane=eq.sprint`). When `lane` is omitted, return the global board (current behavior).

### `/api/plugins/the_daily/streak`

Extend response shape:

```json
{
  "streak": 7,
  "lane_streaks": { "sprint": 3, "marathon": 1, "drop": 0, ... },
  "committed_lane_today": "sprint" | "mixed" | null
}
```

## Frontend

### Setlist view

- Lane legend (already exists at top of map) becomes interactive: clicking a lane chip dims nodes from other lanes and highlights nodes on that lane's path. Pure visual aid — no commitment yet.
- Once the user clears the boss, the committed lane shows above the completion view: "Committed: 🏃 Sprint" (or "Committed: Mixed path").

### Leaderboard view

- Add a lane filter: tabs for `Global / Sprint / Marathon / Drop / Flat / Decade`. Default is `Global`.
- Each row shows `lane_streak` when a lane filter is active, `streak` (global) otherwise.
- A small lane glyph next to each name on the global board, indicating their committed lane that day.

### Profile / streak strip

- Show global streak (current behavior) plus a row of per-lane streak chips. Greyed out if 0.

## Determinism notes

- Lane assignments are already deterministic (computed at map-generation time from the modifier and seed). No new seed surface.
- Adding `committed_lane` to historic rows would retroactively assign lanes to past days. Decision: **don't backfill**. Past rows remain NULL, lane streaks start fresh from the day this ships. Document this in CHANGELOG.

## Rollout

1. Schema migration via `_ensure_column` (one PR, ships invisibly).
2. Backend: `_compute_committed_lane` + `lane_paths` population. Test with `preview.py`. (still no UI surface change)
3. `/sign` sends lane fields. Supabase columns added. Old clients keep working — server tolerates missing fields.
4. Frontend: lane filter on leaderboard, committed-lane chip on completion screen. Per-lane streaks in profile.
5. Announcement: "Lane streaks have started today — pick your station."

## Open questions

- **Mixed paths**: **Resolved — counts toward global only.** Stored as `'mixed'` with `lane_streak=0` (ADR-0004). Don't punish, don't reward as a lane.
- **Lane-only daily mode**: future. Earned via lane mastery (see `03-tokens-shop-passport.md`).
- **What about `decade_*` lanes that vary day-to-day?** **Resolved — store specific (`decade_1980s`), aggregate at query time** via `LIKE 'decade_%'`. Single column, both granularities supported: `decade` lane streak collapses; per-decade stamps survive distinct. Leaderboard tabs aggregate decade; passport stamps remain per-decade.
- **UI commitment**: no. Inferred from behavior. Friction without payoff.
