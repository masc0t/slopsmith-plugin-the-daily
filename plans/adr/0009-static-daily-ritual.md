# The Daily as static daily ritual

> **Revised in part by [ADR 0010](0010-quake-first-person-controls.md).** This ADR's "Ceremony is the point" stance treated abstract movement tweens as load-bearing ritual. Under ADR 0010, movement *within* a room is now player-driven (Quake mouselook + WASD), while the *between-room* tweens, the Hub-to-Today commitment, and the boss-clear two-beat remain non-skippable ceremony. The no-skip-path and cosmetic-projection stances survive; corridors become *lightly* navigational (walk to the door you want) but still do not encode topology, and the minimap is still the macro-navigation tool.

ADR 0007 chose to replace the SVG map with a first-person dungeon. ADR 0008 placed that dungeon inside a Quake-style Hub and committed every screen to live in-world via diegetic surfaces. Both ADRs answered *what to build* and *where things go*. Neither answered *what kind of experience The Daily is asking the player to commit to*. As we sized the cumulative scope (Hub, Archive, six themed room types, audio, no 2D fallback) it became clear the experiential framing — "the dungeon is the only way in, every day, forever, identical" — is itself a load-bearing decision with real alternatives that were explicitly considered and rejected. Recording those trade-offs.

## Decision

**The Daily is a religious daily ritual, not a utility.** Players who open The Daily are committing to a fixed, immersive experience: enter the Hub, walk to today's Dungeon, navigate it, return to sign the Wall of Fame. The same walk, the same sounds, the same rooms. Familiarity is the value; the ritual *is* the product.

**There is no skip path.** No keyboard shortcut bypass, no flat song-picker fast-travel rune, no "classic mode" settings toggle. A player who wants to play today's daily walks the dungeon. Players who don't want this self-select out — opening The Daily plugin signals consent to the ceremony.

**Ceremony is the point.** The walk between rooms, the load-in, the Hub-to-Today commitment, the boss-clear two-beat, the return path to the Wall of Fame guestbook — none of these are friction to be optimized away. They are the experience. Movement tweens are not skippable. The Hub is not bypassed on re-entry. The choreography between beats *is* the game.

**The dungeon is static across sessions.** No long-arc unlocks, no streak trophies appearing in the Hub, no per-day modifier re-skinning, no seasonal lighting, no player-customizable cosmetics. Build it once, build it deeply, ship it as a fixed artifact. The 365-days-a-year commitment is to a known, identical ritual — as it is for any genuine ritual.

**Room types are maximally differentiated.** The six room types (forced/song, elite, treasure, rest, shop, mystery, boss) are not labeled with door icons over identical geometry — they are full themed scenes: shop with shelves and a clerk silhouette, rest with a bedroll and embers, treasure with chests and gold piles, boss with a scaled throne hall. The room *announces* its type before the player processes the icon. The icon remains for at-a-distance recognition; the room itself carries the meaning.

**Audio is mandatory at baseline tier.** Ambient bed loops, footsteps tied to movement tweens, door-opens stings on Encounter, a boss-clear stinger, lane-themed motifs across room types. Freely-licensed or procedurally-generated audio is acceptable; silent is not. Audio gates the deletion PR at the same tier as the Wall of Fame Room.

**The dungeon is a cosmetic projection of the DAG, and that is accepted.** Geometry does not encode topology — corridors are straight tunnels regardless of node connectivity (per ADR 0007). The player navigates by minimap, not spatial memory. The 3D earns its keep aesthetically (atmosphere, sound, room identity), not navigationally. Attention budget concentrates in rooms (where Encounters open) over corridors (which are flavor).

**The modifier surfaces as a stone plaque at the Today Passage.** Today's modifier name and description are inscribed on a fixed plaque object next to the Today Passage in the Hub. The player learns the modifier *before* committing to walk in — modifiers shape strategy, not just narrative. The plaque object is static; only its inscribed text changes daily.

## Considered alternatives

**Diegetic skip path in the Hub.** A "hurry" rune, fast-travel scroll, or shortcut device that opens a flat song picker for time-limited sessions. Rejected: a skip path admits that the dungeon is a tax for some sessions, which contradicts the framing. Players who want speed are in the wrong product.

**Undocumented keyboard shortcut.** Press a key in the Hub to skip; no UI. Power-user escape hatch. Rejected for the same reason as the diegetic skip — once a bypass exists, the design has to defend itself against "why am I walking when I could press 0?" every session.

**Settings toggle: classic mode.** A user preference disabling the dungeon globally, returning to a flat list. Rejected: splits the user population (the precise failure mode the `the_daily_dungeon` localStorage flag was banned for in ADR 0007). Also negates ADR 0008's diegetic-surfaces decision — "classic mode" requires the legacy 2D shell to live indefinitely.

**Tight friction budget.** Bundle ThreeJS as a static asset to eliminate the CDN round-trip, make movement tweens click-skippable, fast-travel from Hub to Today on re-entries, cache state aggressively. Rejected: optimizing the ceremony is a category error if the ceremony is the experience. The case for bundling ThreeJS *for reliability* (CDN unreachable = hard failure) survives separately and may revisit ADR 0007's bundle/CDN decision; the case *for speed* does not.

**Evolving ceremony with long-arc unlocks.** Streak trophies appearing in the Hub, modifier first-clears carving names into walls, seasonal lighting shifts. Rewards loyalty; sustains novelty. Rejected: adds ongoing authoring obligation (every new modifier needs a wall carving, every season needs lighting) and dilutes the "fixed artifact" stance. Static is honest about what we can sustain.

**Heavy per-day theming.** The daily modifier visually re-skins the dungeon (decade modifiers re-light, shop modifiers add inventory). Rejected: maximum daily variety, maximum authoring scope. We considered and chose against because static-deeply-authored is buildable; dynamic-deeply-authored is not.

**Player-customizable cosmetics.** Token shop sells dungeon decorations the player applies to their dungeon. Rejected: gives players agency over the ritual, which makes it not a ritual. The shared experience — every player walking the same dungeon today — is part of the social/identity value of The Daily.

**Light-touch room types: door icon does the work.** Today's model. Rooms identical, icon labels them. Rejected: under no-skip + ceremony-is-the-point, six identical walks with different stickers is undefensible. Maximalist room identity is what justifies asking the player for the daily walk.

**Modifier engraved on the boss door.** Hide the modifier until the climax — ritual reveal. Rejected: deprives the player of strategic foreknowledge. Modifiers shape song-pool selection and lane choice; the player needs to know before they commit, not at the climax.

## Consequences

- **The deletion PR's prerequisite scope is months, not weeks.** Hub geometry, Archive, six themed room types with props/NPCs, WoF Room with diegetic guestbook, error surfaces, baseline audio, two-beat boss-clear, modifier plaque, test ports — all gate the deletion. ADR 0008 ships when these exist; not before.
- **The Daily's audience is self-selecting.** Players who want a fast utility for picking today's songs are not the audience. Marketing or onboarding text should set the expectation honestly: this is a game inside Slopsmith, not a quicker way to play.
- **No fallback exists if the experiential bet is wrong.** The legacy 2D shell is gone after deletion. If players reject the ritual at scale, recovery means rebuilding a flat path from scratch, not flipping a flag. The bet is staked.
- **Audio failure modes are user-facing.** If audio fails to load, the dungeon becomes silent — and silent ceremony is the failure case this ADR rules out. Audio loading must be robust (cached, retried, gracefully degraded) on the same tier as the dungeon itself.
- **Static rooms can be authored once, but must be authored well.** No iteration via daily content; the version that ships is the version that lives. Room authoring is a one-time investment with no sequel-style escape hatch.
- **The cosmetic-projection compromise is permanent.** The dungeon will never be a spatially-accurate map of the DAG. Players who want topology legibility are served by the minimap, not the world. ADR 0007's geometry decision is locked in by this ADR's "ceremony is the point" stance — fixing it would require admitting the walk is navigation, not ritual.
- **The cumulative scope makes timing predictions unreliable.** Months-of-work prerequisites with creative-authoring components (room props, audio direction, boss-clear choreography) are difficult to estimate. Treating the deletion PR as a single milestone is correct architecturally per ADR 0008 but should not be treated as a date-bound deliverable.
