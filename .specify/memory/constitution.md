# The Daily — Constitution

## Inheritance

Slopsmith's core plugin contract governs everything in this repo (manifest,
plugin context: `config_dir` + `meta_db`, navigation, asset serving). This
constitution lists The Daily's own non-negotiables.

## Core Principles

### I. Determinism is load-bearing
Every player on every install MUST see the same setlist + modifier on the
same day. This is achieved by seeding an RNG with `md5(date)[:6]`. Changing
the modifier list, the seed function, the `_EPOCH = 2026-04-22`, or any
selection algorithm SILENTLY rewrites history for every user.

If a selector must evolve, it MUST be versioned (`_date_seed(date) + "v2"`)
so past days remain reproducible. The day-name math also depends on `_EPOCH`
— don't move it.

### II. Pool is bundled, fetched, or cached — in that priority order
`_load_pool()` returns the freshest source available without breaking
offline:
1. `pool_cache` row for the fetch date.
2. Remote fetch from `POOL_URL` (release asset on GitHub).
3. Bundled `songs_pool.json`.
A stale `pool_cache` row from yesterday is still valid for regenerating
yesterday's setlist (determinism), but never read past today.

### III. Modifier types are a closed taxonomy
`MODIFIERS` is a dict of `id → {type, …}`. The dispatch in `_select_songs()`
hard-codes the supported `type` values: `filter`, `identity`, `composite`,
`sequence`, `structural`, `ordering`, `ui`, `meta`. Adding a new modifier
that doesn't fit one of these MUST extend the taxonomy explicitly — no
ad-hoc switches inside selectors.

### IV. Fallback is a signal, not a fix
Every selector returns `(songs, count, fallback_bool)`. `fallback=True`
means "the modifier was bypassed because the pool didn't contain enough
matching songs". This surfaces as a yellow banner in the UI. A modifier
that fallbacks more than ~5% of the time isn't doing its job — fix the
selector or remove it. Do not silently inflate the pool to hide the issue.

### V. Database is local, leaderboard is shared
SQLite (`{config_dir}/the_daily.db`) holds today's cached setlist
(`daily_setlists`), per-song completions (`daily_completions`), and the
pool cache (`pool_cache`). The Wall of Fame lives in Supabase via the
public anon key (committed on purpose). Auth is by anon key only — no
per-user identity, just a `display_name`.

### VI. Optimistic completion mark
`dsPlay()` calls `/mark` BEFORE `playSong()`, because `playSong` navigates
away and the user may not return. We mark on intent. A user who opens a
song and closes the tab still gets credit — accepted tradeoff.

### VII. Anti-repetition rules
14-day exclusion window for `cf_id` (and additionally for `artist` under
`artist_takeover`). If exclusion would leave <5 songs, exclusion is
ignored. Don't widen this without considering the small-pool case.

## Governance

Any change that affects determinism (§I) MUST be reviewed against
`preview.py --days 90`. The fallback rate MUST stay below ~5%. Supabase
schema changes need a coordinated rollout because the anon key is shared
across all installs.

**Version**: 1.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09
