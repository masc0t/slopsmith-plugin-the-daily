# The Daily — AI Agent Guide

A Slopsmith plugin that delivers a globally-shared daily setlist of CDLC songs, inspired by Slay the Spire's daily climb. Every player on every install sees the same 5 songs and the same modifier each day, deterministically derived from the date.

The parent `CLAUDE.md` (two levels up) covers Slopsmith's plugin contract — read it first. This file documents what's specific to The Daily.

## Agent skills

### Issue tracker

Local markdown — issues live as files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (needs-triage, ready-for-agent, etc.). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `plans/adr/` at the repo root. See `docs/agents/domain.md`.

## Files

```
plugin.json          Manifest (id: the_daily, nav label "Daily")
screen.html          Three views: setlist, complete, leaderboard — all in one container
screen.js            Frontend; functions prefixed `ds*`. Hooks window.showScreen.
routes.py            Backend: pool loading, modifier engine, FastAPI routes, Supabase calls
songs_pool.json      The song pool (~14 MB, gitignored). Built by build_pool.py.
build_pool.py        Discord scraper + CustomsForge metadata filler (dev tool, gitignored)
publish_pool.py      Stamps + uploads pool to GitHub release `pool-archive` (dev tool, gitignored)
preview.py           Simulate the next N days without writing to the DB (gitignored)
reset_today.py       Wipe today's cached setlist from the_daily.db so it regenerates (gitignored)
checkpoint.json      Discord scrape resume cursor (gitignored)
fill_checkpoint.json CF artist-fill resume state (gitignored)
```

The pool file and the build/publish scripts are gitignored on purpose — the pool is too large to ship, and the scripts need a Discord user token + CustomsForge cookie + `gh` auth that nobody else has. End users fetch versioned pools from a GitHub release (see `MANIFEST_URL` + `POOL_URL` in `routes.py`); the bundled `songs_pool.json` is a first-run seed only.

## How a daily setlist is built

`GET /api/plugins/the_daily/today` is the entry point. All dates are **UTC** (`datetime.utcnow().date()` — daily rolls at 00:00 UTC for every install). The flow:

1. **Cache check** — `daily_setlists` table keyed by `date`. If today's row exists, return its modifier + songs.
2. **Pool resolution** — `_get_pool_stamp(date)` fetches `pool-manifest.json` (cached in DB), runs latest-leq against the date to pick a `pool_stamp`, then `_fetch_pool_by_stamp(stamp)` returns the pool (cached by stamp in `pool_cache`, else GETs `pool-<stamp>.json` from the release). On network failure, stale-cache covers a 7-day grace window; beyond that, hard-fail. Bundled `songs_pool.json` participates as `BUNDLED_POOL_STAMP` for first-run installs. Pool gets filtered: artist+title ≥ 2 chars, no "full album" entries.
3. **Modifier pick** — `_pick_modifier(date_str)` seeds an RNG with `md5(date)[:6]` and picks one key from `MODIFIERS`.
4. **Pool narrowing** — exclude any `cf_id` used in the last 14 days. If that leaves <5 songs, ignore the exclusion. For `artist_takeover`, additionally exclude artists picked in the last 14 days.
5. **Song selection** — dispatched by modifier `type` (see "Modifier system" below). Returns `(songs, song_count, fallback_bool)`.
6. **Day name** — for `identity` modifiers, derived from the chosen value ("The 1980s", "AC/DC", album name). Otherwise `"Daily #{N}"` where N is days since `_EPOCH = 2026-04-22` (Day #1, UTC).
7. **Persist + enrich** — write to `daily_setlists` (including `pool_stamp` for past-day reproducibility), then enrich each song with `local_filename`, `has_locally` (via `_find_locally` LIKE-match against `meta_db.songs`), and `done` (from `daily_completions`).

Pool stamps are immutable once published. Stamps are activation dates — the pool stamped `2026-05-01` first applies on UTC date 2026-05-01 and remains in effect until a later stamp supersedes it. See `plans/adr/0005-pool-versioning-and-utc-date.md`.

Determinism is load-bearing: changing the modifier list, the seed function, the EPOCH, or the selection algorithms will silently retroactively change what every user sees today. If you need to evolve a selector, version it (e.g. seed with `_date_seed(date) + "v2"`) so past days remain reproducible.

## Modifier system

`MODIFIERS` in `routes.py` is a dict keyed by modifier id. Each entry has a `type` that drives selection in `_select_songs()`:

| `type`       | Selector                | Semantics                                                                 |
|--------------|-------------------------|---------------------------------------------------------------------------|
| `filter`     | inline                  | `mod["fn"](song)` keeps a song. Fallback to full pool if <5 match.        |
| `identity`   | `_identity_candidates`  | Group by `mod["key"]` (string field, callable, or `"decade"`); pick one group with `len ≥ max(min_pool, count)`. |
| `composite`  | `_select_composite`     | Parses `rules` like `identity:artist`, `unique:album`, `order:year`.      |
| `sequence`   | `_select_sequence`      | Adjacent pairs must satisfy `fn(prev, curr)`. Tries 200 random starts.    |
| `structural` | `_select_structural`    | `shape: "bookend"` (same artist 1st & last) or `"alternating"` (A/B/A/B). |
| `ordering`   | inline                  | Random pick, then `sorted(key=mod["key"])`.                               |
| `ui`         | inline (random pick)    | Selection is unaffected; the modifier only changes the frontend (e.g. `blindside` hides titles). |
| `meta`       | `_select_meta`          | `dealers_choice` delegates to a random non-meta; `double_trouble` stacks two filters; `reanimated` / `secret_handshake` are random picks today. |

Every selector returns `(songs, count, fallback_bool)`. `fallback=True` surfaces a yellow "not enough matching songs" banner in the UI — this is the only feedback that the modifier was bypassed. When adding a new modifier, exercise `preview.py --days 90` and check the fallback list at the bottom; a modifier that fallbacks more than ~5% of the time isn't really doing its job.

## Frontend specifics

- All DOM ids start with `ds-`; all global JS functions start with `ds`. Several `onclick=` attributes in `screen.html` reference these globals — keep them in the global scope (no IIFE around `dsPlay`, `dsSign`, `dsSelectRating`, `dsShowSetlist`, `dsShowLeaderboard`).
- `dsPlay()` calls `/mark` *before* `playSong()`. The order matters because `playSong` navigates away from the Daily screen and the user may not return until later — we mark optimistically.
- `_dsReturnAfterPlayback` + `window.slopsmith.on('song:ended')` send the user back to the Daily screen when a song they launched from here finishes. The listener is registered once per session on first show.
- The completion view triggers a one-shot `dsRunConfetti()` (canvas particles, ~3.5s). `_dsConfettiDone` prevents replays on refresh.
- Server JSON is parsed via `text → JSON.parse` rather than `resp.json()` so empty bodies don't throw.

## Database

SQLite file at `<config_dir>/the_daily.db`. `config_dir` is provided by Slopsmith's plugin context. Three tables, all created on first connection:

- `daily_setlists(date PK, day_name, modifier, songs JSON, song_count, pool_stamp)` — one row per day; the source of truth for "what is today's setlist". `pool_stamp` records which pool produced the row, enabling identical regen via `reset_today.py`.
- `daily_completions(date, cf_id, completed_at)` — composite PK, INSERT OR IGNORE so dupes are silent.
- `pool_cache(pool_stamp PK, pool JSON, fetched_at)` — keyed by stamp, not by fetch date. Pools are immutable per stamp, so each stamp is fetched once and reused forever. `fetched_at` drives stale-cache grace: beyond 7 days without a successful refresh + GitHub unreachable, the daily hard-fails rather than silently diverging.

Connection is a module-level singleton with `check_same_thread=False` and a `threading.Lock` around writes. Reads are unlocked.

## Wall of Fame (Supabase)

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are hard-coded at the top of `routes.py`. The anon key is intentionally committed — it's a public read/insert-only key for the `leaderboard` table. Auth is by anon key only; there is no per-user identity, just a `display_name` field that anyone can submit.

`/sign` requires the local setlist to be marked complete (server checks `daily_completions` count vs `song_count`) before posting to Supabase. The `streak` value is computed locally via `_compute_streak()` walking backwards day-by-day until a gap is found, then sent in the POST body — Supabase doesn't verify it.

If `SUPABASE_URL` is empty or starts with `https://YOURPROJECT`, both `/leaderboard` and `/sign` short-circuit with `{"error": "Supabase not configured"}` so a fork can run without leaderboard.

## Dev workflows

```bash
# Preview upcoming days (uses songs_pool.json directly, never touches the DB)
python preview.py --days 30
python preview.py --days 90 --compact
python preview.py --start 2026-05-01 --days 7

# Deterministic snapshot for comparison testing (new)
python preview.py --snapshot snapshots/baseline.json --days 90
python preview.py --snapshot snapshots/after-change.json --days 90
# Compare: diff snapshots/baseline.json snapshots/after-change.json

# Map mode preview (ASCII art)
python preview.py --map --days 30

# Force-regenerate today's setlist (e.g. after editing MODIFIERS)
# IMPORTANT: always restart the container FIRST, then reset. If you reset before
# restarting, the old code regenerates and saves the row before new code loads.
docker restart slopsmith-web-1 && sleep 3 && docker exec slopsmith-web-1 python plugins/the_daily/reset_today.py
docker restart slopsmith-web-1 && sleep 3 && docker exec slopsmith-web-1 python plugins/the_daily/reset_today.py --pool

# Rebuild songs_pool.json (requires DISCORD_USER_TOKEN in repo-root .env)
python build_pool.py             # incremental — uses checkpoint.json
python build_pool.py --full      # full rescrape, ignores checkpoint
python build_pool.py --fill-artists --cf-cookie '...'   # back-fill missing metadata via CF

# Publish a new pool to the GitHub release (requires gh CLI authenticated)
python publish_pool.py                          # stamps as today_utc + 1 day
python publish_pool.py --stamp 2026-05-15       # explicit future stamp
# Asserts: stamp is strictly future, no collision with existing asset.
# Uploads pool-<stamp>.json + updated pool-manifest.json to release `pool-archive`,
# verifies anonymous GET + content hash, then runs preview spot-check.
```

### Running tests

```bash
npm test            # backend coverage (pytest/unittest) + frontend smoke
npm run test:python # backend route tests only (this is what CI runs)
npm run test:e2e    # Playwright dungeon smoke (tests/playwright/dungeon-smoke.spec.js)
```

The Daily is a 3D dungeon (no 2D fallback). Frontend automated testing is the
Playwright **dungeon smoke** spec — it serves the test page over real HTTP
(localStorage needs a non-opaque origin), enters via `dsDungeonEnter`, and
asserts the Quake-1 main menu renders, keyboard nav works, the OPTIONS sliders
adjust, and no console errors occur. It imports three.js from a CDN, so it
**skips** when offline. See [tests/E2E_TESTING.md](tests/E2E_TESTING.md).

For interactive dungeon debugging (walking, encounters, screenshots) use the
ad-hoc harnesses under `.scratch/dungeon-debug/` over real HTTP — see the
`reference-dungeon-headless-harness` memory.

`reset_today.py` reads `CONFIG_DIR` from env, defaulting to `~/.local/share/rocksmith-cdlc`. On Windows that path won't exist — pass `CONFIG_DIR=...` matching what Slopsmith uses on this machine.

## Common pitfalls

- **Editing MODIFIERS changes today retroactively.** The seed function shuffles all keys and picks index 0. Adding/removing/renaming a modifier reshuffles. If you need to test a new modifier without disturbing the live setlist, add it locally, run `preview.py`, then `reset_today.py` before the day it lands.
- **`_find_locally` is a `LIKE` match** on title and artist. Songs with punctuation/featuring-artist differences won't match. False positives are possible (substring collisions); accepted as a tradeoff for not requiring per-song fingerprinting.
- **The pool ships ~14 MB of JSON.** Keep it gitignored. End users fetch versioned pools from the `pool-archive` GitHub release; the bundled copy is a first-run seed only and is shadowed once any successful manifest fetch lands.
- **Pool stamps are immutable and strictly future.** `publish_pool.py` enforces this — never overwrite an existing `pool-<date>.json`, never stamp a pool with today's or a past UTC date. Same-day pool fixes are impossible by design; bad pool means a bad day. Build pool today, stamp tomorrow, upload today.
- **All dates are UTC.** `_get_today()` uses `datetime.utcnow().date()`. The daily rolls at 00:00 UTC for every install regardless of timezone. Don't reintroduce `date.today()` — it breaks the global determinism guarantee across timezones.
- **`day_number` is anchored to `_EPOCH = date(2026, 4, 22)` UTC.** Don't bump this — it would renumber every past day in every user's UI.
- **The Supabase anon key is public on purpose.** Don't rotate it as if it leaked. If abuse becomes a problem, add a Postgres RLS policy or rate-limit at the edge instead.
## Frontend = 3D dungeon only

The legacy 2D UI (setlist + SVG node-graph map, the complete page, the
leaderboard/Wall-of-Fame tab, and the full-screen passport and shop pages) was
**removed entirely**. `dsDungeonEnabled()` is always true and the only DOM view
outside the 3D overlay is the initial loading spinner; everything else is a
diegetic dungeon room (Hub, WoF Room, Shop Room, Hall of Records, Archive).

When working on the player-facing experience, edit the dungeon builders in
`screen.js` (`dsDungeonEnter` → `_dsBuildHub` / `_dsBuildDungeon` / room
builders) — there is no 2D `dsRender`/`dsMapView`/`dsShow('setlist')` path to
fall back to. Shared, still-live helpers reused by the 3D rooms: the encounter
panel (`dsOpenNode` and its tree), the shop-item system (`dsRenderShopItem`,
`dsLoadShop`, `dsBuyItem`, `dsRefreshTokens`, equip/refund), acquisition
(`dsAcquire`/`dsCapture*`), and song launching (`dsPlayMapNode`/`dsPlay`).
The Quake-1 main menu (`_dsShowMainMenu`) is the front door; QUIT and the Hub
exit-door return to the host library via `showScreen('home')`.
