# Remote modifier manifest

The `MODIFIERS` dict in `routes.py` is hardcoded Python — adding or removing a modifier requires a plugin deploy. Most new modifiers are data-driven (filter by year range, keyword list, string property) and need no novel code; yet they still trigger deploys. We replaced the hardcoded dict with a remote `modifiers-manifest.json` hosted in the `pool-archive` GitHub release, using the same stamp/latest-leq semantics as the pool. The plugin ships a Predicate DSL engine (~10 primitive ops) and a registry of named algorithm implementations; the manifest supplies all modifier definitions and controls which are active on which dates. Adding or retiring a modifier now only requires publishing a new manifest stamp.

## Decision

**Manifest structure.** `modifiers-manifest.json` is an append-only list of stamped entries in the `pool-archive` release alongside `pool-manifest.json`. Each stamp has an activation date, an ordered list of active modifier definitions, and an optional `min_plugin_version` field. Latest-leq lookup: for UTC date D, the active stamp is the one with the largest date ≤ D. First stamp: `2026-04-22` (the EPOCH), covering all 43 original modifiers so that past-day reproducibility via `reset_today.py` is unbroken.

**Two modifier kinds.**
- *Data-driven*: filter, identity, ordering, ui types. Fully defined in the manifest via the Predicate DSL. No plugin code needed to add or remove.
- *Algorithm-parameterized*: sequence, structural, composite, meta types. Logic lives in the plugin as named implementations; manifest supplies name + parameters (`shape`, `field`, `rules`, `fn`, etc.).

**Predicate DSL.** A restricted JSON predicate language evaluated by `_eval_predicate(song, predicate)`. Primitive ops cover: `year_between`, `year_in`, `year_ends_with`, `field_len_lte`, `field_len_gte`, `field_case`, `field_contains_field`, `field_keywords`, `same_first_letter`, `field_all_digits`, `field_has_nonalnum`. Ops are additive and backward-compatible — semantics of existing ops never change; new ops require `min_plugin_version` on any stamp that uses them.

**Version gate.** The plugin reads its own version from `plugin.json` at startup (`_PLUGIN_VERSION`). If a resolved stamp's `min_plugin_version` exceeds `_PLUGIN_VERSION`, the daily endpoint returns a structured `{"error": "update_required", "min_version": "..."}` and the frontend shows an update prompt. No setlist is served.

**Network required; no offline fallback.** The manifest is fetched fresh once per UTC day and cached in a new `modifier_manifest_cache(date TEXT PRIMARY KEY, manifest JSON, fetched_at TEXT)` table. If the fetch fails and no same-day cache row exists, the daily returns `{"error": "offline"}` and the frontend shows a "try again later" state. There is no stale-cache grace window and no bundled fallback manifest. The Daily is not useful offline (no leaderboard signing, pool is also unavailable), so a clean error is preferable to serving stale modifier definitions.

**`_pick_modifier` and `_select_songs` rewritten.** Both now receive the resolved Active Modifier Set from the manifest rather than reading `MODIFIERS`. Determinism is preserved: a given date always resolves to the same stamp, same ordered active list, same shuffle result.

**Publishing.** A new `publish_modifiers.py` dev script (gitignored, alongside `publish_pool.py`) authors and uploads new manifest stamps. It asserts the stamp date is strictly future, appends to `modifiers-manifest.json`, uploads to the release via `gh` CLI, and verifies by anonymous GET + content hash.

## Considered alternatives

**Keep `MODIFIERS` hardcoded; accept deploys for every change.** Simplest path. Rejected because filter additions (new keyword list, new year range) are frequent, low-risk, and would generate a stream of trivial plugin deploys. The manifest decouples authoring cadence from deploy cadence at low complexity cost.

**Remote activation list only (definitions stay hardcoded, manifest enables/disables).** Allows retiring without deploy. Still requires deploy to add any new modifier, including ones with no novel logic. Rejected because the Predicate DSL covers the full filter/identity/ordering/ui space and the marginal complexity of the DSL engine is small.

**Stale-cache grace window for offline (7-day grace, same as pool's intended design).** The pool ships `POOL_STALE_GRACE_DAYS = 7` but never enforces it (the constant is defined but no code checks `fetched_at`). A grace window was considered to match the pool's intent. Rejected: The Daily requires internet for its core loop (pool also unavailable offline, leaderboard unreachable). Serving stale modifier definitions silently is worse than a clear offline error.

**Bundled `modifiers-manifest.json` as a first-run fallback (same role as `songs_pool.json`).** Would allow The Daily to run without a network request on first install. Rejected: the bundled copy would drift from the live manifest with no detection mechanism, and the offline Daily experience is meaningless without leaderboard access. The pool's bundled seed exists because the pool is ~14 MB and must be available before any remote fetch; the modifier manifest is a few KB and fast to fetch.

**Separate GitHub release for the modifier manifest.** Cleaner separation of concerns. Rejected: the `pool-archive` release already has fetch infrastructure, caching, and stamp logic in place. A second release duplicates all of that plumbing with no operational benefit.

## Consequences

- **Adding a modifier that needs new plugin code** (new sequence shape, new structural algorithm) still requires a plugin deploy, but only for that modifier. Set `min_plugin_version` on the stamp that activates it — old plugins show the update prompt rather than executing unknown code.
- **Predicate DSL backward compatibility is a hard constraint.** Changing the semantics of an existing DSL op would silently alter what every past and future date resolves to. New ops only; never mutate existing ones.
- **`modifiers-manifest.json` is a single point of failure** for daily generation. `publish_modifiers.py` must verify the upload before returning success. Unlike the pool (stale-cache grace), there is no shield — a corrupted manifest means an offline error for all installs until corrected.
- **Past-day reproducibility is preserved** via the first stamp at `2026-04-22`. `reset_today.py` resolves the same stamp any past daily would have used.
- **The existing `POOL_STALE_GRACE_DAYS = 7` constant in `routes.py` is unused** — staleness checking was designed but never implemented. This ADR does not fix that; it is noted here so the omission is intentional, not accidental.
