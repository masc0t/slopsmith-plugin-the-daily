# Quake-style Hub architecture and diegetic surfaces

ADR 0007 settled that the SVG map gets replaced by a first-person ThreeJS dungeon, with the Wall of Fame becoming a post-boss room. As we moved toward deleting the legacy 2D shell, gaps became visible: the dungeon only loads when the daily isn't complete, the post-completion view, historical day navigator, Passport, Shop entry, and error states all still rendered as 2D HTML inside Slopsmith chrome. The deletion question forced the question "where does *every* screen of The Daily live, in-world?" — and the answer reshapes the frame around the dungeon.

## Decision

**The Hub is the entry point.** The player loads into a Quake-1-styled stone chamber containing diegetic Passages to each top-level area: Today (the daily dungeon), Archive (historical days), Passport (meta progression), Shop, and Wall of Fame. There is no 2D title menu — the Hub *is* the title screen. Passages are doorways/corridors in the world, not buttons.

**Passages reflect availability through visual state.** A sealed Passage (dark archway, locked gate) becomes unsealed (open, glowing in lane color) when its area becomes accessible. The canonical case: the Wall of Fame Passage is sealed until today's boss is cleared; on clear, it unseals and glows.

**Diegetic surfaces render flat content in the world.** Leaderboard entries, Passport stamps, calendar pickers, error messages — all live on canvas-textured planes attached to in-world objects (stone tablets, pedestals, display cases). The player walks up to them; raycaster + click coordinates handle interaction. The screen *is* an object you can walk up to. Single carve-out: sign-the-wall briefly summons an HTML `<input>` over the canvas because typing on a canvas-painted keyboard would be miserable for a once-per-day action.

**The Archive uses the dungeon as its viewer.** Walking through the History Passage drops the player into a small antechamber with a diegetic calendar device. Selecting a date loads that day's daily dungeon as a fully-cleared replay — same code path as the present, all rooms cleared, WoF Passage already unsealed. There is no separate "historical view" code path.

**Boss-clear is a two-beat sequence.** First beat in the boss room: lane-color flare on the walls, a Doom-style "FINISHED" stinger, torches igniting, the streak number rendered diegetically (carved on the floor or appearing on a stone slab). Second beat at the Hub: when the player returns, the WoF Passage is now unsealed and glowing. No HTML confetti — paper particles don't fit Doom-era stone; the lighting/torch effect is the 3D analog.

**Exit Slopsmith is a diegetic door in the Hub.** A labeled exit (heavy door, upward staircase) re-shows the Slopsmith navbar and navigates back. No persistent host chrome during play. Esc returns to Hub from any area; Esc-from-Hub prompts before exiting (so accidental exits during play don't kick the player out of Slopsmith).

**Render technique for diegetic surfaces is canvas textures.** PlaneGeometry with a canvas-rendered texture, raycaster for hit-testing. Fits the procedural-texture pipeline already in use, z-buffers cleanly with walls and fog (a tablet can be partially occluded by a column or dimmed by distance). CSS3DRenderer was rejected because real DOM in 3D space doesn't z-buffer with the WebGL scene — surfaces would float over walls.

## Considered alternatives

**Keep the 2D title menu.** Continue showing a dungeon-styled HTML menu (Continue / Restart / Options) as the entry point. Rejected because it leaves a 2D pre-game shell exactly where we said we'd kill one. The Hub eliminates the menu entirely without losing the options it surfaces — they become diegetic objects.

**Direct entry with HUD-only navigation.** Always start in today's daily dungeon; reach Passport / History / Shop via persistent HUD buttons. Rejected because HUD buttons are screen-locked overlays — exactly the kind of 2D chrome the Hub model exists to eliminate. Also no natural place for the WoF unseal moment.

**Hub-only celebration.** Boss room ends quietly; all post-clear feedback happens at the Hub when the player returns. Rejected: the boss-clear is the *point* of the daily, and a silent boss room is a flat moment. Two beats stages the payoff (immediate in-room, then world-state change at the Hub) without taking control away.

**Forced cinematic on boss clear.** Lock input, auto-tween the player from boss room → Hub → WoF Room. Rejected: takes agency away on the most important moment of the daily. Two-beat preserves player walk-back as the connective tissue.

**CSS3DRenderer for diegetic surfaces.** Real DOM elements positioned in 3D space; native inputs, scrollbars, focus. Rejected because CSS3DRenderer composites in a separate pass that doesn't z-buffer with the WebGL scene — a stone tablet would float over a column instead of being occluded by it. Breaks the spatial illusion that justifies diegetic surfaces in the first place. Canvas textures + a summoned input for the rare typing case keeps the WebGL pipeline whole.

**Long corridor of dated doors for History.** One door per past day, walk down a hall to find the date you want. Dramatic but unscalable past ~30 days, and breaks at the EPOCH boundary. The Archive's calendar pedestal is the same idea (browse past dailies) without the geometry blowup.

**Embed the WoF Room directly into the Archive for past days.** Pick a date → the Archive transforms into that day's WoF Room. Skips re-entering the dungeon for past days but introduces a second code path for "WoF Room rendering" depending on whether you came from boss-clear or from the Archive. Rejected in favour of a single mechanism: the dungeon is the viewer for any date.

## Consequences

- **The legacy 2D shell is fully removed in the same PR that introduces the Hub.** No partial cutover — `#ds-setlist`, `#ds-complete`, `dsMapView`, the tabbed Wall of Fame, sign-container, date-nav buttons, lane-extras, confetti canvas, and the `the_daily_dungeon` localStorage advert all go in one merge. The Hub is the only surface left.
- **Slopsmith host chrome is hidden during play.** The full-screen takeover from ADR 0007 is now permanent and total — there is no fallback to the host navbar except via the Hub's exit door. Plugin authors integrating with The Daily must respect that the screen is fully owned during play.
- **Every new screen is a diegetic surface.** Future features (e.g. a stats screen, a settings panel, a friends list) must be expressed as a 3D object the player walks up to, not as a HUD overlay or modal. The CSS3DRenderer carve-out path is closed.
- **The Archive ties historical-day rendering to the dungeon code path.** Any change to the dungeon's rendering of cleared state automatically applies to past days. Conversely, breaking the dungeon breaks historical browsing — there is no separate "view past day" fallback.
- **Sealed/unsealed Passage state is computed from existing backend signals.** The Hub reads `is_complete` to decide WoF Passage state; no new API surface is required. The visual seal/unseal is a frontend-only concern.
- **The `<input>` summon for sign-the-wall is the only HTML element that exists during play.** Any other DOM-based UI is a regression of this ADR.
- **Confetti is gone.** The 3D lighting/torch celebration replaces it. Reintroducing confetti would require either a particle system in WebGL or breaking the no-DOM rule.
- **Tests that asserted SVG DOM structure are deleted.** Playwright flows describing valid product behaviour (sign, complete, modifier display) are ported to drive the dungeon DOM and diegetic surfaces. There is no path back to testing the SVG renderer.
