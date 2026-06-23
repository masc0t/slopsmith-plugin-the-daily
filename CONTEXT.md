# The Daily

A Slopsmith plugin that delivers a globally-shared daily setlist of CDLC songs. Every player on every install sees the same five songs and the same modifier each day, deterministically derived from the UTC date.

## Language

### Setlist

**Daily Setlist**: The songs served for a given UTC date, plus the modifier that shaped their selection. Persisted in `daily_setlists` table once generated; served from cache on subsequent requests for the same date.
_Avoid_: daily, today's set, the set

**Modifier**: A named rule that governs how songs are selected from the pool. One modifier is active per day, picked deterministically from the Active Modifier Set via date-seeded RNG. A modifier has a `type` (filter, identity, composite, sequence, structural, ordering, ui, meta) that drives the selection algorithm. Modifiers may return fewer than 5 songs if the pool cannot satisfy the constraint.
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

### Dungeon

**Dungeon**: The full-screen first-person 3D map view that is the primary interface for The Daily. Replaces the SVG map. Built with ThreeJS in a Doom-era 90s aesthetic (low-res pixelated render target, procedurally generated wall textures). The Dungeon is the Daily Setlist expressed as a game — navigating it is how a player progresses through their nodes for the day. Since ADR 0012 the entire map is **one contiguous walkable floorplan**: every Room is placed at its grid position and connected by real Corridors, walls are extracted from an occupancy grid, and the player walks the whole dungeon under Quake controls rather than teleporting between standalone Rooms.
_Avoid_: map view, map panel, 3D map

**Room**: The 3D representation of a map node inside the Dungeon — a walkable chamber at the node's grid position (`col`→lateral, `row`→forward depth), holding that node type's signature prop. Each Room has a type (forced, elite, mystery, boss, choice, rest, treasure, shop). The "current Room" is whichever Room rectangle contains the player; it drives the HUD, audio motif, lighting tint, and lane commitment. The terms "node" (backend/data) and "Room" (frontend/presentation) refer to the same entity at different layers.
_Avoid_: node (in frontend/UI contexts), tile, cell

**Corridor**: The walkable passage connecting two Rooms in the contiguous floorplan, routed as axis-aligned L-segments between their centers (ADR 0012). A Corridor is **open** iff its target Room is discovered (`available ∪ cleared ∪ committed`); a closed Corridor is physically blocked by a Rubble Gate. Since ADR 0012 the layout encodes DAG topology — it is no longer a cosmetic projection.
_Avoid_: edge, path, hallway

**Rubble Gate**: The pile of boulders blocking a closed Corridor (ADR 0012, replacing ADR 0010's sealed door). When the source Room is cleared, the Rubble Gates on its now-open exits **detonate** — debris, sparks, a light flash, a boom — and the passage becomes walkable. Committing to a lane drops Rubble Gates on the sibling entrances (a quiet rockfall, not an explosion) to lock them.
_Avoid_: door, gate (bare), sealed exit

**Encounter**: The full-screen overlay that opens when the player arrives at a Room. Surfaces song/node info and available actions (play, download, bank, shop). The Dungeon pauses behind it. Dismissing the Encounter resumes navigation.
_Avoid_: node panel, song panel, interaction panel

**Wall of Fame Room**: A special Room that appears at the boss exit after the player completes the daily. Renders the Wall of Fame leaderboard inside the Dungeon aesthetic. Accessible only after boss clear.
_Avoid_: leaderboard screen, leaderboard view

**Diegetic Surface**: A 3D object inside the Dungeon that displays 2D content (leaderboard entries, Passport stamps, error messages) on its visible face. The content is flat and readable — generated as a canvas texture or embedded HTML — but the object is part of the world geometry: the player walks up to it, raycaster detects proximity, interactions happen via clicks on the surface itself rather than a fullscreen overlay. The canonical answer to "is this screen in the game?" — the screen *is* an object you can walk up to. Examples: stone tablet for the Wall of Fame, pedestal guestbook for signing, hall-of-records display cases for Passport.
_Avoid_: HUD element (HUDs are screen-locked), overlay, panel

**Hub**: The Quake-1-inspired starting chamber that the player loads into when they enter The Daily. Contains diegetic Passages to each top-level area (Today, Archive, Passport, Shop, Wall of Fame). The Wall of Fame Passage is sealed until the player completes today's daily. The Hub also contains the diegetic exit (a labeled door / staircase) that returns the player to the Slopsmith host UI. Replaces the legacy 2D title menu.
_Avoid_: title menu, lobby, main menu

**Passage**: A diegetic doorway / corridor / slope in the Hub leading into an area. Visual state reflects availability — a sealed Passage (e.g. dark archway, locked gate) becomes unsealed (open, glowing in lane color) when its area becomes accessible. The Wall of Fame Passage is the canonical example: sealed before boss-clear, unsealed after.
_Avoid_: portal, exit, link

**Archive**: The antechamber reached through the Hub's History Passage. Contains a single diegetic calendar device (e.g. a pedestal-mounted dial) for picking a past UTC date. Selecting a date loads that day's Daily Setlist as a fully-cleared dungeon — same dungeon code path as the present day, with the Wall of Fame Passage already unsealed. The Archive is the input device; the loaded dungeon is the viewer.
_Avoid_: history view, calendar screen, past dailies page

### Acquisition

**Acquisition**: A player obtaining the playable PSARC for a song so its Room becomes playable — the transition from a listed song to `has_locally: true`.
_Avoid_: download, install, fetch

**Host URL**: The direct file-host link (Dropbox, Google Drive, OneDrive, Mega, Mediafire, …) where a song's PSARC actually lives, as distinct from its CustomsForge listing (`cf_url`).
_Avoid_: download link, file URL, mirror

**Capture**: The desktop app learning a Host URL by observing the player's *own* manual download inside its embedded webview — the only sanctioned way to obtain a Host URL, since automated CustomsForge access is forbidden.
_Avoid_: scrape, harvest, resolve

**Unlock**: The first successful Capture of a song's Host URL, after which every later player Acquires that song silently from the shared cache.
_Avoid_: cache hit, prefetch, seed

**Reported Item**: A song flagged untrustworthy because its Host URL yielded a non-PSARC file (e.g. a `.zip`); it is never silently fetched, and its Room is auto-completed so a path is never trapped by un-acquirable content.
_Avoid_: blocked song, banned song, flagged

**Manual Floor**: The always-available fallback Acquisition path — the player downloads from CustomsForge by hand and a folder-watch auto-rescans — used whenever silent fetch is unavailable or fails.
_Avoid_: manual mode, legacy download, fallback

### Leaderboard

**Wall of Fame**: The global leaderboard stored in Supabase. Players may sign their name after completing a full daily setlist. Entries include `display_name`, `date`, `streak`, and `day_name`. No per-user identity — anyone can submit any name.
_Avoid_: leaderboard, scoreboard, rankings

**Streak**: The number of consecutive UTC days on which a player has completed the daily setlist, computed locally by `_compute_streak()` walking backwards until a gap. Sent in the Wall of Fame POST body; not verified by Supabase.
_Avoid_: combo, chain, run

**Completion**: A row in `daily_completions(date, cf_id, completed_at)` inserted when a player marks a song played. INSERT OR IGNORE makes duplicates silent. The setlist is considered complete when completion count equals `song_count`.
_Avoid_: mark, play, finish

## Relationships

- The **Hub** is the player's entry point into The Daily; it contains a **Passage** to each top-level area (today's **Dungeon**, the **Archive**, Passport, Shop, **Wall of Fame Room**)
- The **Dungeon** is the primary interface for a **Daily Setlist** — each map node becomes a **Room**, each edge becomes a **Corridor**, and interacting with a Room opens an **Encounter**
- The **Wall of Fame Room** is reached via the Hub's Wall of Fame **Passage**, which is sealed until the boss **Room** in today's Dungeon is cleared; the room renders the **Wall of Fame** leaderboard on **Diegetic Surfaces**
- The **Archive** is reached via the Hub's History Passage; selecting a date there loads that day's Dungeon as a fully-cleared replay
- A **Daily Setlist** is produced by applying one **Modifier** to the **Song Pool** active for that UTC date
- A **Modifier** belongs to the **Active Modifier Set** resolved from the **Modifier Manifest** for a given date
- A **Data-driven Modifier** is fully specified in a **Modifier Stamp** via the **Predicate DSL**
- An **Algorithm-parameterized Modifier** is referenced by name in a **Modifier Stamp** and implemented in plugin code
- A **Modifier Stamp** may carry **min_plugin_version**; if the plugin is too old, no **Daily Setlist** is served
- A **Completion** accumulates against a **Daily Setlist**; when count equals `song_count`, the player may sign the **Wall of Fame** and a **Streak** is computed
- A **Room** becomes playable through **Acquisition** of its song's PSARC
- **Acquisition** resolves a song's **Host URL** from the **Unlock** cache and silently fetches it; on a miss or failure it falls back to the **Manual Floor**, where a human **Capture** on CustomsForge both downloads the song and re-populates the cache
- The first **Capture** of a song **Unlocks** it for every later player
- A song whose **Host URL** yields a non-PSARC file becomes a **Reported Item**, and its **Room** is auto-completed rather than fetched

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
- "download" is overloaded — the **Encounter**'s download action, a **Capture** (learning a Host URL), and an **Acquisition** (obtaining the file) are distinct steps; prefer the specific term.
- `cf_url` is the CustomsForge *listing* page, never a **Host URL** — the two must not be conflated; one CDLC has exactly one `cf_url` but its Host URL is provider-specific and may change when the author re-uploads.
