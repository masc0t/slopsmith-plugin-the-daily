# The Daily — AI Agent Guide

A Slopsmith plugin that delivers a globally-shared daily setlist of CDLC songs, inspired by Slay the Spire's daily climb. Every player on every install sees the same 5 songs and the same modifier each day, deterministically derived from the date.

The parent `CLAUDE.md` (two levels up) covers Slopsmith's plugin contract — read it first. This file documents what's specific to The Daily.

## Files

```
plugin.json          Manifest (id: the_daily, nav label "Daily")
screen.html          Three views: setlist, complete, leaderboard — all in one container
screen.js            Frontend; functions prefixed `ds*`. Hooks window.showScreen.
routes.py            Backend: pool loading, modifier engine, FastAPI routes, Supabase calls
songs_pool.json      The song pool (~14 MB, gitignored). Built by build_pool.py.
build_pool.py        Discord scraper + CustomsForge metadata filler (dev tool, gitignored)
preview.py           Simulate the next N days without writing to the DB (gitignored)
reset_today.py       Wipe today's cached setlist from the_daily.db so it regenerates (gitignored)
checkpoint.json      Discord scrape resume cursor (gitignored)
fill_checkpoint.json CF artist-fill resume state (gitignored)
```

The pool file and the build script are gitignored on purpose — the pool is too large to ship, and the build script needs a Discord user token + CustomsForge cookie that nobody else has. End users get the pool from a remote URL (see `POOL_URL` in `routes.py`, currently empty → falls back to bundled file).

## How a daily setlist is built

`GET /api/plugins/the_daily/today` is the entry point. The flow:

1. **Cache check** — `daily_setlists` table keyed by `date`. If today's row exists, return its modifier + songs.
2. **Pool load** — `_load_pool()` returns from the `pool_cache` table (1 row per fetch date), else fetches `POOL_URL`, else reads bundled `songs_pool.json`. Pool gets filtered: artist+title ≥ 2 chars, no "full album" entries.
3. **Modifier pick** — `_pick_modifier(date_str)` seeds an RNG with `md5(date)[:6]` and picks one key from `MODIFIERS`.
4. **Pool narrowing** — exclude any `cf_id` used in the last 14 days. If that leaves <5 songs, ignore the exclusion. For `artist_takeover`, additionally exclude artists picked in the last 14 days.
5. **Song selection** — dispatched by modifier `type` (see "Modifier system" below). Returns `(songs, song_count, fallback_bool)`.
6. **Day name** — for `identity` modifiers, derived from the chosen value ("The 1980s", "AC/DC", album name). Otherwise `"Daily #{N}"` where N is days since `_EPOCH = 2026-04-22` (Day #1).
7. **Persist + enrich** — write to `daily_setlists`, then enrich each song with `local_filename`, `has_locally` (via `_find_locally` LIKE-match against `meta_db.songs`), and `done` (from `daily_completions`).

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

- `daily_setlists(date PK, day_name, modifier, songs JSON, song_count)` — one row per day; the source of truth for "what is today's setlist".
- `daily_completions(date, cf_id, completed_at)` — composite PK, INSERT OR IGNORE so dupes are silent.
- `pool_cache(fetched_date PK, pool JSON)` — one row per day. Don't trust this for "the pool today" beyond a single date; a stale row from yesterday is still valid for yesterday's setlist regeneration but never read past today.

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

# Force-regenerate today's setlist (e.g. after editing MODIFIERS)
python reset_today.py            # just the setlist row
python reset_today.py --pool     # also clear today's pool_cache row

# Rebuild songs_pool.json (requires DISCORD_USER_TOKEN in repo-root .env)
python build_pool.py             # incremental — uses checkpoint.json
python build_pool.py --full      # full rescrape, ignores checkpoint
python build_pool.py --fill-artists --cf-cookie '...'   # back-fill missing metadata via CF
```

`reset_today.py` reads `CONFIG_DIR` from env, defaulting to `~/.local/share/rocksmith-cdlc`. On Windows that path won't exist — pass `CONFIG_DIR=...` matching what Slopsmith uses on this machine.

## Common pitfalls

- **Editing MODIFIERS changes today retroactively.** The seed function shuffles all keys and picks index 0. Adding/removing/renaming a modifier reshuffles. If you need to test a new modifier without disturbing the live setlist, add it locally, run `preview.py`, then `reset_today.py` before the day it lands.
- **`_find_locally` is a `LIKE` match** on title and artist. Songs with punctuation/featuring-artist differences won't match. False positives are possible (substring collisions); accepted as a tradeoff for not requiring per-song fingerprinting.
- **The pool ships ~14 MB of JSON.** Keep it gitignored. End users fetch via `POOL_URL` once that's set; until then they use whatever bundled copy they have.
- **`day_number` is anchored to `_EPOCH = date(2026, 4, 22)`.** Don't bump this — it would renumber every past day in every user's UI.
- **The Supabase anon key is public on purpose.** Don't rotate it as if it leaked. If abuse becomes a problem, add a Postgres RLS policy or rate-limit at the edge instead.
