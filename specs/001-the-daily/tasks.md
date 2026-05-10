# Tasks — The Daily

Status legend: `DONE` (shipped in v1.0.0), `OPEN` (not yet implemented), `[P]` (parallelisable).

## US-1 — Today's setlist
- [DONE] `GET /today` with cache hit / generation paths.
- [DONE] Enrichment with `local_filename`, `has_locally`, `done`.
- [DONE] Setlist view rendering with progress bar.

## US-2 — Play song
- [DONE] `dsPlay()` calls `/mark` then `playSong(local_filename)`.
- [DONE] `slopsmith.on('song:ended')` listener returns to Daily on completion.

## US-3 — Mark progress
- [DONE] `/mark` writes `daily_completions` with INSERT OR IGNORE.

## US-4 — Day Complete
- [DONE] Auto-show `ds-complete` view when all songs marked.
- [DONE] One-shot confetti via `_dsConfettiDone` guard.

## US-5 — Sign Wall of Fame
- [DONE] Name + rating + Sign button.
- [DONE] Server verifies completion before forwarding.
- [DONE] Short-circuit when Supabase unconfigured.

## US-6 — Wall of Fame view
- [DONE] `GET /leaderboard?date=...` Supabase passthrough.
- [DONE] Rating tallies + entries list.

## US-7 — Streak
- [DONE] `_compute_streak` walks backwards.
- [DONE] Streak posted with sign payload.

## US-8 — Modifier types
- [DONE] `filter` selector.
- [DONE] `identity` selector with decade / artist / album keys.
- [DONE] `composite` selector parsing `rules` like `identity:artist`, `unique:album`, `order:year`.
- [DONE] `sequence` selector with adjacency `fn`.
- [DONE] `structural` selector with `bookend` / `alternating` shapes.
- [DONE] `ordering` selector.
- [DONE] `ui` selector (no selection effect).
- [DONE] `meta` selector (`dealers_choice`, `double_trouble`, etc.).
- [OPEN] [P] Add a self-test that runs `preview.py --days 90` in CI.

## US-9 — Anti-repetition
- [DONE] 14-day cf_id exclusion.
- [DONE] Artist exclusion for `artist_takeover`.
- [DONE] Bypass exclusion when pool < 5.

## US-10 — Pool refresh
- [DONE] `pool_cache` table with per-date rows.
- [DONE] Remote fetch via `POOL_URL` (release asset).
- [DONE] Bundled fallback.

## US-11 — `blindside` UI modifier
- [DONE] Frontend hides titles when modifier id matches.

## US-12 — Identity day naming
- [DONE] `_day_name` derives names from chosen value or falls back to `Daily #{N}`.

## Cross-cutting
- [DONE] Module-level DB connection with `threading.Lock`.
- [DONE] `text → JSON.parse` to tolerate empty bodies.
- [DONE] `ds*` global namespace + `ds-*` DOM ids.
- [DONE] Optimistic completion mark.
- [OPEN] [P] Override mechanism for `POOL_URL` / Supabase via env or
  config (Q12).
- [OPEN] [P] Time-zone localisation policy (Q in spec).
- [OPEN] [P] Document Supabase RLS / rate-limit policy in this repo.
- [OPEN] Tests — `preview.py` is the de facto regression harness; a
  pytest wrapper would help.
- [OPEN] [P] Pool sanity-check at load (count, schema) with a clear
  refusal message.
