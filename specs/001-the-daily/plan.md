# Plan — The Daily (as built)

## File map

| File                  | Lines | Purpose                                                                  |
|-----------------------|-------|--------------------------------------------------------------------------|
| `plugin.json`         | 7     | Manifest. `id: the_daily`, version `1.0.0`, nav `Daily`, declares `screen.html`/`screen.js`/`routes.py`. |
| `routes.py`           | 1079  | Pool loader, modifier engine, FastAPI endpoints, Supabase calls, streak math. |
| `screen.html`         | 86    | Three views: setlist, complete (confetti + sign), leaderboard.            |
| `screen.js`           | 373   | `ds*`-prefixed globals, view orchestration, `playSong` integration, return-after-playback. |
| `songs_pool.json`     | (large, gitignored) | Pool of CDLC built by `build_pool.py`.                          |
| `build_pool.py`       | (gitignored) | Discord scraper + CustomsForge metadata fill.                       |
| `preview.py`          | (gitignored) | Simulate next N days without writing the DB.                         |
| `reset_today.py`      | (gitignored) | Wipe today's setlist row to force regeneration.                      |
| `checkpoint.json` / `fill_checkpoint.json` | (gitignored) | Build-script resume cursors.                          |

## Database (`{config_dir}/the_daily.db`)

| Table                | Schema                                                    |
|----------------------|-----------------------------------------------------------|
| `daily_setlists`     | `(date PK, day_name, modifier, songs JSON, song_count)`   |
| `daily_completions`  | `(date, cf_id, completed_at)` composite PK                |
| `pool_cache`         | `(fetched_date PK, pool JSON)` one row per fetch date     |

WAL is implicit. Connection is module-level singleton with
`check_same_thread=False`; writes are wrapped in a `threading.Lock`. Reads
are unlocked.

## Endpoints

| Verb | Path                                | Purpose                                              |
|------|-------------------------------------|------------------------------------------------------|
| GET  | `/api/plugins/the_daily/today`      | Cached or generated setlist + enrichment             |
| POST | `/api/plugins/the_daily/mark`       | `INSERT OR IGNORE` completion row                    |
| GET  | `/api/plugins/the_daily/streak`     | `_compute_streak()` over `daily_completions`         |
| GET  | `/api/plugins/the_daily/leaderboard?date=…` | Supabase passthrough; short-circuits on unconfigured |
| POST | `/api/plugins/the_daily/sign`       | Verify completion, then forward to Supabase          |

## Setlist generation flow

```
GET /today
  │
  ├─► daily_setlists row for today exists? ──yes──► return enriched
  │
  no
  │
  ▼
_load_pool()  (cache → POOL_URL → bundled)
  │
  ▼
filter pool: artist+title >= 2 chars, drop "full album"
  │
  ▼
_pick_modifier(date_str)  ← seed = md5(date)[:6]
  │
  ▼
narrow pool: drop cf_ids used in last 14 days
                (and artists for artist_takeover)
                if result < 5, ignore exclusion
  │
  ▼
_select_songs(pool, mod) → (songs, count, fallback_bool)
   dispatched on mod["type"]:
     filter | identity | composite | sequence | structural
     ordering | ui | meta
  │
  ▼
_day_name(date_str, modifier_id, songs)
  │
  ▼
INSERT INTO daily_setlists
  │
  ▼
enrich each song:
  local_filename = _find_locally(meta_db.songs LIKE …)
  has_locally    = bool
  done           = exists in daily_completions
  │
  ▼
return JSON to client
```

## Modifier dispatch

`MODIFIERS[modifier_id]` dict with `type`. Each `type` has its own selector
(see `spec.md`). Every selector returns `(songs, count, fallback_bool)`.
Adding a new `type` requires a new branch in `_select_songs()` — no
opaque mod functions allowed (constitution §III).

## Frontend

- DOM: three top-level views (`#ds-setlist`, `#ds-complete`,
  `#ds-leaderboard`) under one container. `dsShow*` swaps visibility.
- All globals prefixed `ds`: `dsPlay`, `dsSign`, `dsSelectRating`,
  `dsShowSetlist`, `dsShowLeaderboard`, `dsRunConfetti`. Several are
  referenced from `onclick=` attributes — they MUST stay global.
- `dsPlay()`:
  ```js
  await fetch('/api/plugins/the_daily/mark', { ..., body: { cf_id }})
  playSong(local_filename)
  ```
  Order matters (constitution §VI).
- `_dsReturnAfterPlayback` registered once per session via
  `slopsmith.on('song:ended')` — returns the user to the Daily after a
  song finishes.
- JSON parsed via `JSON.parse(await resp.text())` to tolerate empty
  bodies.

## Wall of Fame

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are constants at the top of
`routes.py`. Anon key is intentionally committed (Q5). When `SUPABASE_URL`
is empty or starts with `https://YOURPROJECT`, both `/sign` and
`/leaderboard` short-circuit.

## Dev workflows (from CLAUDE.md)

```bash
python preview.py --days 30
python preview.py --days 90 --compact
python preview.py --start 2026-05-01 --days 7

python reset_today.py            # just the setlist row
python reset_today.py --pool     # also clear today's pool_cache row

python build_pool.py             # incremental, uses checkpoint.json
python build_pool.py --full      # full rescrape
python build_pool.py --fill-artists --cf-cookie '...'   # back-fill metadata
```

## Risks / drift watchpoints

- **Determinism (§I)**: any change to `MODIFIERS`, `_date_seed`, `_EPOCH`,
  or selector internals silently rewrites history. Run `preview.py --days
  90` before merging.
- **Pool cache poisoning**: a bad pool fetch caches a malformed row for
  the day. `reset_today.py --pool` is the recovery path.
- **Hard-coded Supabase URL**: forks inherit shared state unless they
  override (Q12).
- **Anon-key permissiveness**: writes are unauthenticated; rate-limit /
  RLS lives in Supabase config out-of-tree. Document the policy here.
- **`onclick=` global exposure**: refactoring `screen.js` into modules
  would break `screen.html` references unless globals are explicitly
  re-exported.
