# Spec — The Daily (`the_daily`)

> Retrospective spec for shipped v1.0.0. Implementation in `routes.py`
> (1079 lines), `screen.js` (373), `screen.html` (86), and the build/preview
> tooling (`build_pool.py`, `preview.py`, `reset_today.py`) is the source of
> truth. The repo's `CLAUDE.md` already documents the ground-truth design;
> this spec rephrases it as a retro spec-kit doc.

## Summary

A Slopsmith plugin that delivers a globally-shared, deterministic daily
setlist of 5 CDLC songs plus a modifier — a Slay-the-Spire-style "daily
climb" for guitar. Every player on every install sees the same setlist on
the same date. Completion is tracked locally; an opt-in **Wall of Fame**
(Supabase) lets users sign daily completions with their streak.

## User stories

### US-1 — See today's setlist
- **Given** I open the **Daily** screen (nav button),
  **When** the client calls `GET /api/plugins/the_daily/today`,
  **Then** the response contains today's `date`, `day_name`, `modifier_id`,
  `modifier_desc`, `song_count`, and an array `songs[]` enriched with
  `local_filename`, `has_locally`, and `done` flags.

### US-2 — Play a song from the setlist
- **Given** a song is in today's list and `has_locally === true`,
  **When** I click **Play**,
  **Then** the client posts `/mark` for that `cf_id` *first* (optimistic
  completion), then calls `playSong(local_filename)`. The Daily registers
  a `song:ended` listener once per session to bring the user back to the
  Daily screen on song end.

### US-3 — Mark progress
- `daily_completions(date, cf_id, completed_at)` rows are written by
  `/mark`. The composite primary key is `(date, cf_id)` with INSERT OR
  IGNORE — duplicate marks are silent.

### US-4 — Day Complete view + confetti
- **Given** every song's `cf_id` has a completion row for today,
  **When** the screen re-renders,
  **Then** the `ds-complete` view shows; `dsRunConfetti()` fires once per
  session (`_dsConfettiDone` guard).

### US-5 — Sign the Wall of Fame
- **Given** the day is complete,
  **When** I enter a name and click **Sign**,
  **Then** the client posts `/sign` with `{display_name, rating, streak}`.
  The server verifies completion (count vs `song_count`) before forwarding
  to Supabase.
- **Given** Supabase is unconfigured (`SUPABASE_URL` empty or template),
  **Then** `/sign` and `/leaderboard` short-circuit with
  `{"error": "Supabase not configured"}`.

### US-6 — Wall of Fame view
- **Given** I click **View Wall of Fame**,
  **When** the client calls `GET /leaderboard?date=YYYY-MM-DD`,
  **Then** Supabase returns recent entries (and rating tallies) which the
  UI renders.

### US-7 — Streak tracking
- `GET /streak` walks `daily_completions` backwards day by day until a gap
  is found. The streak value is computed locally and posted with `/sign` —
  Supabase does not verify it.

### US-8 — Modifier system (closed taxonomy)
The day's modifier comes from `MODIFIERS[modifier_id]` whose `type` drives
selection:

| Type        | Description                                                                       |
|-------------|-----------------------------------------------------------------------------------|
| `filter`    | Inline `mod["fn"](song)` predicate. Fallback to full pool if <5 match.            |
| `identity`  | Group by `mod["key"]` (string field, callable, or "decade"); pick a group ≥ size. |
| `composite` | `rules` list (e.g. `identity:artist`, `unique:album`, `order:year`).              |
| `sequence`  | Adjacent pairs satisfy `fn(prev, curr)`. 200 random starts.                       |
| `structural`| `shape: bookend` (same artist 1st & last) or `alternating` (A/B/A/B).             |
| `ordering`  | Random pick, then `sorted(key=mod["key"])`.                                       |
| `ui`        | Random pick; modifier only changes presentation (e.g. `blindside` hides titles).  |
| `meta`      | `dealers_choice` delegates to a non-meta; `double_trouble` stacks two filters.    |

### US-9 — Anti-repetition
- 14-day window: `cf_id` used in the last 14 days is excluded.
- For `artist_takeover`, additionally exclude artists picked in the last
  14 days.
- If exclusion drops the pool below 5 songs, exclusion is bypassed.

### US-10 — Pool refresh strategy
- `_load_pool()` order:
  1. `pool_cache` row for today.
  2. Remote fetch from `POOL_URL` (GitHub release).
  3. Bundled `songs_pool.json`.
- Filter pool: artist + title both ≥ 2 chars; drop "full album" entries.

### US-11 — `blindside` UI modifier
- When `modifier_id === 'blindside'`, the UI hides song titles until the
  user marks them played. Selection is unaffected (random pick).

### US-12 — Identity day naming
- For `identity` modifiers, `day_name` is derived from the chosen value:
  decade → `"The 1980s"`; artist → `"AC/DC"`; album → album name.
- Otherwise `Daily #{N}` where `N = (today - _EPOCH).days + 1`,
  `_EPOCH = 2026-04-22`.

## Functional requirements (selected)

| ID    | Requirement                                                                                              | Source                          |
|-------|----------------------------------------------------------------------------------------------------------|---------------------------------|
| FR-1  | `GET /today` returns cached row from `daily_setlists` if present; otherwise generate, persist, and enrich. | `routes.py`                     |
| FR-2  | RNG seed = `md5(date)[:6]` (`_date_seed`).                                                                | `routes.py`                     |
| FR-3  | Day-number math anchored on `_EPOCH = 2026-04-22`.                                                        | `routes.py`                     |
| FR-4  | Pool cached in `pool_cache(fetched_date PK, pool JSON)` — one row per fetch date.                          | `routes.py`                     |
| FR-5  | Completion marks via `INSERT OR IGNORE INTO daily_completions(date, cf_id, completed_at)`.                | `routes.py`                     |
| FR-6  | `_compute_streak()` walks backward from today.                                                            | `routes.py`                     |
| FR-7  | `/sign` requires server-verified completion before forwarding to Supabase.                                | `routes.py`                     |
| FR-8  | When Supabase is unconfigured, `/sign` and `/leaderboard` short-circuit.                                  | `routes.py`                     |
| FR-9  | Frontend uses `text → JSON.parse` (not `resp.json()`) so empty bodies don't throw.                        | `screen.js`                     |
| FR-10 | All client globals prefixed `ds*`; DOM ids `ds-*`. `screen.html` uses `onclick=` attributes that reference these globals — they MUST stay in global scope. | `screen.js` / `screen.html`     |
| FR-11 | `dsPlay()` calls `/mark` BEFORE `playSong()`.                                                              | `screen.js`                     |
| FR-12 | `_dsReturnAfterPlayback` listens to `slopsmith.on('song:ended')` once per session.                         | `screen.js`                     |
| FR-13 | Confetti runs once via `_dsConfettiDone` guard.                                                            | `screen.js`                     |
| FR-14 | DB connection is module-level singleton with `check_same_thread=False` and `threading.Lock` on writes.    | `routes.py`                     |
| FR-15 | Songs enriched via `_find_locally` LIKE-match against `meta_db.songs`.                                    | `routes.py`                     |

## Non-functional

- **Latency**: cached `today` returns in <50 ms; cold path (regenerate) is
  dominated by pool I/O — typically <500 ms.
- **Determinism**: `preview.py --days 90` MUST produce stable output across
  runs barring intentional modifier changes.
- **Privacy**: `display_name` is user-supplied; the anon Supabase key
  permits public read/insert. Inserts cannot be deleted by clients.

## Out of scope

- Per-user identity / OAuth. Wall of Fame is anon-key only.
- Difficulty-aware setlist tuning. Modifiers are content-based.
- Time-zone localisation. Today is UTC server-side.
- Editor for the modifier list. Modifiers are code, not data.

## Open clarifications

- [NEEDS CLARIFICATION] How do we handle a forked install that wants its
  own pool / modifier set without breaking determinism? Today they share
  state with the canonical pool by default.
- [NEEDS CLARIFICATION] Time-zone semantics — UTC midnight may not match a
  user's local "day". Acceptable now; flag for the future.
- [NEEDS CLARIFICATION] Spam / abuse on the Wall of Fame — anon writes are
  unauthenticated. Rate limiting via Supabase row policies is implicit.
- [NEEDS CLARIFICATION] The hard-coded Supabase URL in `routes.py` makes
  forks inherit a shared backend unless they override; document the
  override flow more clearly?
