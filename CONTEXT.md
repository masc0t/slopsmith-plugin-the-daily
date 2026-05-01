# The Daily

A Slopsmith plugin that delivers a globally-shared daily setlist of CDLC songs. Every player on every install sees the same five songs and the same modifier each day, deterministically derived from the UTC date.

## Language

### Setlist

**Daily Setlist**: The five songs served for a given UTC date, plus the modifier that shaped their selection. Persisted in `daily_setlists` table once generated; served from cache on subsequent requests for the same date.
_Avoid_: daily, today's set, the set

**Modifier**: A named rule that governs how the five songs are selected from the pool. One modifier is active per day, picked deterministically from the Active Modifier Set via date-seeded RNG. A modifier has a `type` (filter, identity, composite, sequence, structural, ordering, ui, meta) that drives the selection algorithm.
_Avoid_: rule, mode, theme, challenge

**Modifier Type**: The dispatch key that determines which selection algorithm runs for a modifier. Types: `filter` (per-song predicate), `identity` (group by field, pick one group), `composite` (chains multiple rules), `sequence` (adjacent-pair constraint), `structural` (positional constraint), `ordering` (sort after random pick), `ui` (selection unchanged, frontend-only effect), `meta` (wraps or delegates to other modifiers).
_Avoid_: modifier category, modifier kind

**Day Name**: The display label for a given daily — either a derived identity ("The 1980s", "AC/DC") for identity modifiers or "Daily #N" where N is days since the EPOCH.
_Avoid_: daily title, day label

**EPOCH**: `2026-04-22` UTC — Day #1 of The Daily. `day_number` is anchored here and must never change, as it would renumber every past day in every user's UI.

### Pool

**Song Pool**: The full catalogue of eligible CDLC songs from which daily setlists are drawn. Fetched from the `pool-archive` GitHub release as a versioned JSON file. Filtered at load time: artist and title must each be ≥ 2 characters, "full album" entries excluded.
_Avoid_: song list, catalogue, library

**Pool Stamp**: The activation date of a specific song pool version (`pool-YYYY-MM-DD.json`). For any UTC date D, the active pool is the stamp with the largest date ≤ D (latest-leq). Stamps are strictly future at upload time and immutable once published.
_Avoid_: pool version, pool date, pool tag

**Pool Manifest**: `pool-manifest.json` in the `pool-archive` release. An append-only list of all pool stamps. Clients resolve the correct stamp for any date without using the GitHub API.
_Avoid_: pool index, pool registry

**Bundled Pool**: The `songs_pool.json` shipped inside the plugin directory. Acts as a first-run seed only, treated as stamp `BUNDLED_POOL_STAMP = 2026-04-22`. Superseded by any successful remote manifest fetch.
_Avoid_: default pool, fallback pool, local pool

### Modifier manifest

**Modifier Manifest**: `modifiers-manifest.json` hosted in the `pool-archive` GitHub release. The single remote source of truth for what modifiers exist, their definitions, and when each set becomes active. Fetched fresh once per UTC day and cached in `modifier_manifest_cache`.
_Avoid_: modifier config, remote modifier list, modifier registry

**Modifier Stamp**: A dated entry in the Modifier Manifest with an activation date and the full Active Modifier Set for that period. Uses the same latest-leq semantics as Pool Stamps. First stamp: `2026-04-22`.
_Avoid_: modifier version, modifier snapshot

**Active Modifier Set**: The list of modifier definitions in effect for a given UTC date, resolved from the Modifier Manifest by latest-leq stamp lookup.
_Avoid_: enabled modifiers, modifier list, live modifiers

**Data-driven Modifier**: A modifier whose full definition — selection logic and display metadata — is expressed in the Modifier Manifest via the Predicate DSL. Requires no plugin code to add or remove.
_Avoid_: remote modifier, JSON modifier, config modifier

**Algorithm-parameterized Modifier**: A modifier whose selection logic is a named function implemented in the plugin, but whose parameters (field, shape, rules) are specified in the Modifier Manifest. Covers sequence, structural, composite, and meta types.
_Avoid_: baked-in modifier, code modifier, hardcoded modifier

**Predicate DSL**: A restricted JSON predicate language evaluated by `_eval_predicate(song, predicate)` in the plugin. Covers ~10 primitive operations (year range, keyword list, string property, field comparison, etc.) sufficient to express all filter/identity/ordering/ui modifier logic. DSL ops are additive and backward-compatible — existing ops never change semantics.
_Avoid_: filter spec, modifier definition language, JSON filter

**min_plugin_version**: An optional field in a Modifier Stamp specifying the minimum plugin version required to serve that stamp's Active Modifier Set. If the installed plugin is older, the daily is gated: user sees an update prompt, no setlist is served.
_Avoid_: required version, minimum version, version constraint

### Leaderboard

**Wall of Fame**: The global leaderboard stored in Supabase. Players may sign their name after completing a full daily setlist. Entries include `display_name`, `date`, `streak`, and `day_name`. No per-user identity — anyone can submit any name.
_Avoid_: leaderboard, scoreboard, rankings

**Streak**: The number of consecutive UTC days on which a player has completed the daily setlist, computed locally by `_compute_streak()` walking backwards until a gap. Sent in the Wall of Fame POST body; not verified by Supabase.
_Avoid_: combo, chain, run

**Completion**: A row in `daily_completions(date, cf_id, completed_at)` inserted when a player marks a song played. INSERT OR IGNORE makes duplicates silent. The setlist is considered complete when completion count equals `song_count`.
_Avoid_: mark, play, finish

## Relationships

- A **Daily Setlist** is produced by applying one **Modifier** to the **Song Pool** active for that UTC date
- A **Modifier** belongs to the **Active Modifier Set** resolved from the **Modifier Manifest** for a given date
- A **Data-driven Modifier** is fully specified in a **Modifier Stamp** via the **Predicate DSL**
- An **Algorithm-parameterized Modifier** is referenced by name in a **Modifier Stamp** and implemented in plugin code
- A **Modifier Stamp** may carry **min_plugin_version**; if the plugin is too old, no **Daily Setlist** is served
- A **Completion** accumulates against a **Daily Setlist**; when count equals `song_count`, the player may sign the **Wall of Fame** and a **Streak** is computed

## Example dialogue

> **Dev:** "I want to add `golden_era` — filter for songs from the 1970s. Do I need to deploy?"
> **Domain expert:** "No — that's a data-driven modifier. Add it to a new Modifier Stamp with a future activation date. The Predicate DSL handles year ranges natively."
>
> **Dev:** "What about adding a new sequence type where each song's last letter chains to the next song's first letter?"
> **Domain expert:** "That's an algorithm-parameterized modifier. The Python logic ships in a plugin version bump. Then you add a new Modifier Stamp referencing it by name, with min_plugin_version set to that version. Old plugins show the update prompt."
>
> **Dev:** "Can I retire a modifier mid-season?"
> **Domain expert:** "Yes — publish a new Modifier Stamp omitting it. The retired modifier remains in the Active Modifier Set for all past dates (their stamps don't change), so reset_today.py on old dates still reproduces the original setlist."

## Flagged ambiguities

- "modifier" alone is overloaded — it can mean a single modifier entry, the modifier type, or the modifier system generally. Qualify as needed.
- "daily" is used colloquially for both the plugin itself and a specific Daily Setlist — the latter should always be "Daily Setlist" in technical contexts.
- "pool" without qualification could mean the Song Pool or the `songs_pool.json` bundled file — prefer "Song Pool" and "Bundled Pool" respectively.
