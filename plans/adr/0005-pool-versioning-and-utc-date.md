# Pool versioning & UTC date semantics

## Status

accepted

## Context

The Daily promises that "every player on every install sees the same songs and the same modifier each day." Determinism is load-bearing: the modifier is picked from a date-seeded RNG, and song selection is dispatched off the modifier against a song pool loaded from `songs_pool.json` (bundled) or `POOL_URL` (remote). The pool itself was treated as a moving target — `_load_pool` cached it in `pool_cache` keyed by `fetched_date`, refetching `POOL_URL` once per day.

This breaks the promise as soon as the pool changes. Two failure modes:

1. **Mid-day pool swap.** User A fetches `/today` at 04:00 UTC, caches setlist with pool v1. Maintainer pushes pool v2 at 06:00 UTC. User B fetches at 07:00 UTC, caches setlist with pool v2. Same date, different setlist.
2. **Past-day non-reproducibility.** `reset_today.py` (and any future "regenerate this date" path) loads the *current* pool, not the pool active when that date originally ran. After any swap, historical days cannot be rebuilt identically.

The plugin is pre-release: no installs in the wild, no streaks to preserve, no schema migration concerns.

## Decision

**Pool stamps as activation dates.**

- Each pool file is uploaded as `pool-YYYY-MM-DD.json` to a single GitHub release tagged `pool-archive`.
- The stamp is the **activation date** — the first UTC date on which that pool may be used. Stamps must be strictly future: `stamp > today_utc` at upload time.
- Latest-leq lookup: for any date D, the pool active for D is the one with the largest stamp `≤ D`.
- A `pool-manifest.json` asset in the same release lists all stamps. Append-only. Clients fetch the manifest, resolve the stamp for the target date, then fetch that pool. No GitHub API calls (avoids the 60/h anonymous rate limit and keeps the client thin).
- Pools are immutable per stamp. Once `pool-2026-05-01.json` is published, its bytes never change.
- Old pools are kept forever in the release. Storage cost is negligible (~14 MB per swap, ~12 swaps/year expected) and preserves past-day reproducibility indefinitely.

**Schema changes.**

- `pool_cache` is rekeyed: `(pool_stamp PRIMARY KEY, pool TEXT, fetched_at TEXT)`. Same stamp is fetched once and reused forever — pools are immutable, so date-keyed caching is wrong.
- `daily_setlists` gains a `pool_stamp TEXT` column. Records which pool produced each cached setlist. `reset_today.py` uses this to fetch the exact original pool and produce identical regen.

**UTC-only date.**

- `_get_today()` switches from `date.today()` (local) to `datetime.utcnow().date()`.
- Everything date-keyed (setlist row, completion row, streak walk, `_EPOCH`-derived "Daily #N") is UTC.
- The daily rolls at 00:00 UTC for every install. The UI may show a local-clock countdown to next rollover, but the underlying boundary is UTC.

**Fallback when GitHub unreachable.**

Stale-cache with 7-day grace:

1. On any GET failure (manifest or pool asset), use the most recently fetched copy from `pool_cache` (or last-seen manifest).
2. If the stale copy was fetched ≤ 7 days ago, proceed silently.
3. Beyond 7 days, hard-fail the daily: UI shows "couldn't reach the pool, retry later." Forces installs to refresh against current state rather than diverging indefinitely.
4. The bundled `songs_pool.json` shipped with the plugin is a **first-run seed only**. It carries a `BUNDLED_POOL_STAMP` constant in `routes.py` and is treated as an additional stamp in latest-leq. Once any successful manifest+pool fetch lands, the bundled copy is irrelevant for that install.

**Authoring workflow.**

A `publish_pool.py` script (gitignored, dev-only, alongside `build_pool.py`):

- Computes `stamp = today_utc + 1 day` (configurable, must be future).
- Hard-asserts the stamp does not collide with an existing asset (immutability).
- Uploads `pool-<stamp>.json` to the `pool-archive` release via `gh` CLI.
- Appends the stamp to `pool-manifest.json` and re-uploads it.
- Verifies the just-uploaded asset by anonymous GET + content hash.
- Runs `preview.py --start <stamp> --days 7` to spot-check the next week's setlists.

**Preview/snapshot reproducibility.**

`preview.py` adopts the same manifest+stamp loader as `routes.py`. Snapshot files (`preview.py --snapshot ...`) record the `pool_stamp` for each previewed date alongside the setlist, so diffs between snapshots distinguish "modifier-logic change" from "pool composition change."

**No hotfix mechanism.**

A bad song in the active pool (broken CDLC link, copyright issue, profanity) waits ≤ 1 day for the next pool swap. No same-day blocklist override is shipped. If observed need is real later, the escape hatch is a server-side `pool-blocklist.json` applied **at generation time only** (asymmetric: users who already cached today's setlist keep it; users who haven't yet get a filtered version). This was deliberately rejected for MVP because every divergence vector eliminated above is one we don't want to reintroduce.

## Considered alternatives

- **Accept mid-day divergence and weaken the "global same songs" promise to best-effort.** Rejected: the global daily is the product hook. Every divergence vector chips away at it. Cheaper now, but harder to walk back than to start strict.
- **Pool stamp = upload moment (datetime), not activation date.** Allows same-day swaps to "take effect immediately." Rejected: re-creates failure mode #1 from Context. Strict future-date stamps are the only rule that closes the race entirely.
- **Mutable-with-versions: pool file at fixed URL plus a `pool_version` integer fetched alongside.** Equivalent expressive power. Rejected: filename-as-stamp is self-documenting and human-inspectable in the GitHub releases UI; an opaque version integer needs an external lookup to know "what's in v7."
- **GitHub releases REST API for asset discovery.** Avoids maintaining a manifest file. Rejected: 60/h anonymous rate limit is real (multiple installs behind a corporate NAT could collectively burn it), payload is verbose, and the publishing script already runs once per swap — appending to a manifest is trivial work in exchange for a rate-limit-free, plain-HTTP client.
- **Local date (`date.today()`) with a Wordle-style 2-day stamp lead time.** Preserves familiar local-midnight rollover and was Wordle's actual answer to the same problem. Rejected because the plugin is pre-release with no streak data to protect — UTC is strictly simpler and removes the pre-existing timezone divergence in completion/streak rows for free. If post-release feedback shows users hate UTC rollover, fallback to local-date + 2-day lead is reachable without changing pool versioning.
- **Per-pool GitHub release** (separate release per stamp). Rejected: requires API pagination on the client and clutters the releases page. Single `pool-archive` release with many assets keeps everything in one place.
- **Garbage-collect old pools after N months.** Rejected: storage is free, past-day reproducibility was the whole motivation for stamping in the first place, and the disk cost is bounded (≤ 1 GB/year at expected swap cadence).
- **Server-side blocklist applied at-render** (frontend filters bad songs from already-cached setlist, dropping count from 5 to 4). Rejected as MVP: too invasive (completion logic, UI, streaks all need to handle variable setlist length) and the failure mode it solves is rare.

## Consequences

- **Same-day pool fixes are impossible by design.** Bad pool means a bad day. Acceptable because `build_pool.py` filtering catches most issues and the maintainer reviews via `preview.py` before publishing.
- **Pool publishes have a minimum 1-day lead time.** Workflow: build today, stamp tomorrow, upload today. Maintainer must internalize this or the assertion in `publish_pool.py` will block them.
- **Daily rolls at 00:00 UTC for every player regardless of timezone.** Players in UTC+12 see rollover at noon local; players in UTC-8 at 16:00 local. Some will find this unintuitive. UI must clearly surface the next-rollover countdown to soften it.
- **Disk: GitHub release will accumulate ~14 MB × N pool versions over time.** No cap. Tracked as accepted cost.
- **Manifest is a single point of failure** for client discovery. If the manifest URL is misconfigured or the file is corrupted on upload, every fresh install fails latest-leq. `publish_pool.py` post-upload verification catches this; stale-cache shields existing installs from a transient corruption window.
- **Pre-release schema** lets us drop and recreate `pool_cache` cleanly. No migration code needed.
- **`reset_today.py` becomes deterministic** for any post-launch date that has a `pool_stamp` recorded. Pre-launch rows don't exist (pre-release), so the NULL-stamp path is skipped entirely.
- **Future hotfix lane is reachable** via at-generation blocklist without breaking any decision here. The asymmetric divergence it would introduce is bounded and intentional (favors users who haven't played yet), and the blocklist itself doesn't need to be stamped because it only affects fresh setlist generation.
