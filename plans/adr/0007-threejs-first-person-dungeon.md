# ThreeJS first-person dungeon replaces SVG map

> **Superseded in part by [ADR 0010](0010-quake-first-person-controls.md).** The "Movement model" and "Navigation" sections below — abstract tween-to-node movement, the camera auto-facing a selected door, and left/right arrow exit-cycling — are replaced by Quake first-person controls (Pointer Lock mouselook + WASD with Quake ground physics). The renderer, visual style, cosmetic-projection geometry, minimap, encounter overlay, and full-screen takeover described here all remain in force.

The Daily's map was a 2D SVG graph — nodes as circles, edges as lines, row/col grid. It worked but wasn't a game. The intent is to turn The Daily into an actual game within Slopsmith: a first-person dungeon crawler where the player walks through rooms (nodes) and plays songs as encounters. We replaced the SVG renderer with a ThreeJS first-person view styled after 90s Doom-era crawlers.

## Decision

**Renderer.** ThreeJS loaded from CDN via ES module import. The Daily already requires internet (pool fetches from GitHub releases, leaderboard hits Supabase), so a CDN dependency is acceptable. ThreeJS is not used elsewhere in Slopsmith; this plugin carries it independently.

**Visual style.** Doom-era 90s aesthetic: actual 3D geometry (walls, floor, ceiling) rendered to a low-resolution render target (e.g. 320×200) and upscaled for a pixelated look. No external texture assets — wall textures generated programmatically via canvas. Node type is conveyed as a glowing icon on the door ahead. Lane colors (`--lane-*` CSS variables) drive wall/door accent colors for visual continuity.

**Movement model.** Abstract node-to-node movement, not a walkable grid. Pressing forward tweens the player linearly to the next connected node along its edge. The corridor ahead is always rendered as a straight tunnel regardless of the actual DAG topology — the 3D layout is a cosmetic projection of the graph, not a spatially accurate map. This avoids reworking `_map_shape_template()` in the backend; the map API is unchanged.

**Navigation.** Left/right arrow keys cycle available exits when a node has multiple outgoing edges. A minimap in the top-right corner shows the full DAG (cleared/available/locked state) so the player can plan their route without getting lost. No avatar is rendered — first-person perspective eliminates the need.

**Full-screen takeover.** When the player opens The Daily, the dungeon fills the entire viewport, hiding Slopsmith's navbar. An exit button returns to normal Slopsmith. This is the minimum viable version of "actual game" — a dungeon crammed into a plugin panel with a navbar above it is a widget, not a game.

**Encounter overlay.** When the player arrives at a node (room), the dungeon pauses and a full-screen overlay slides in styled as a Doom encounter screen (dark panel, pixelated borders). The overlay surfaces song/node info and the play/download/shop/bank actions. `dsOpenNode()` populates this overlay rather than a div panel. Dungeon resumes after the overlay is dismissed.

**Setlist and leaderboard replaced.** The dungeon is the daily experience — the traditional setlist view is removed. The leaderboard (Wall of Fame) becomes a post-boss room accessible after completing the daily: a doorway appears at the boss exit leading to the Wall of Fame room, which renders the leaderboard inside the dungeon aesthetic. The completion overlay (confetti, streak, sign button) triggers on boss clear before the doorway appears.

**HUD.** A minimal bottom bar: day name + modifier name (left), progress pips for cleared/total nodes (center), token count + lane streak (right). Minimap in top-right corner. Node details live in the encounter overlay, not the HUD.

**Build strategy.** The dungeon is built behind a `localStorage` feature flag (`the_daily_dungeon === '1'`). The SVG map remains live during development. The flag is removed and the SVG renderer deleted in the merge PR.

## Considered alternatives

**Isometric view.** Preserves DAG topology legibility and is lower-complexity than first-person. Rejected in favour of first-person after the user explicitly chose the Doom-era crawler aesthetic and framed the goal as "actual game." Isometric would be a better map, not a better game.

**Sprite billboard avatar (isometric).** Diablo-style sprite character navigating an isometric map was considered before first-person was chosen. Eliminated entirely by the first-person decision — you don't see yourself in first-person.

**Panel-contained canvas.** ThreeJS renders inside the plugin's container, navbar stays visible. Rejected because a full-screen takeover is the minimum version of this experience that reads as a game rather than a widget. The option remains viable as a fallback if full-screen causes integration issues.

**Real spatial corridors (grid reproject).** Re-project nodes onto a regular grid so cardinal corridors connect them accurately in 3D. Would require changing `_map_shape_template()` and the backend node coordinate model. Rejected: abstract movement (straight tunnel per edge, independent of topology) delivers the same first-person feel with zero backend changes. The corridor is decoration, not navigation data.

**Split-screen encounter (dungeon + song panel side by side).** Keeps spatial context visible while interacting. Rejected in favour of full overlay — split-screen halves the render budget and the encounter content (song title, artist, play button) needs the full width to be readable.

**Bundled ThreeJS.** Serve `three.module.min.js` as a static plugin asset. Avoids CDN dependency. Rejected because the plugin already requires internet and bundling ~600 KB adds maintenance burden (version updates) with no user benefit.

## Consequences

- **Backend is unchanged.** All map generation, node state tracking, and API endpoints are unmodified. The dungeon is a pure view-layer replacement.
- **SVG renderer is deleted on merge.** `dsMapView()` and the setlist view are removed. There is no fallback after merge — the feature flag strategy is the safety net during development, not after.
- **ThreeJS version is pinned in the CDN import.** Bumping the version is a deliberate change, not an automatic update. The import URL must specify a semver-exact version.
- **Low-res render target is the 90s aesthetic mechanism.** Changing the target resolution changes the look significantly. The render target resolution should be treated as a design constant, not a performance knob.
- **Wall of Fame room is a new frontend concept** with no backend counterpart. The leaderboard data is the same (`/leaderboard` endpoint); only the presentation changes.
- **The `the_daily_dungeon` localStorage flag is a dev artifact.** It must be removed (not defaulted to `'0'`) before shipping — leaving it in place silently splits the user population.
