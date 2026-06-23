# Quake first-person controls for the dungeon

ADR 0007 chose a first-person dungeon but with *abstract* movement: pressing forward tweens the player to the next node, left/right arrows cycle exits, and the camera auto-pivots to face the selected door. ADR 0009 elevated that abstraction into philosophy — movement tweens are ceremony, the player navigates by minimap, corridors are flavor. In practice the abstract scheme read as an on-rails slideshow more than a place you inhabit: you don't *stand* in a room and look around, you watch the camera swivel between doors. We are replacing the control layer with authentic Quake first-person controls — Pointer Lock mouselook + WASD with Quake ground physics — ported from the control scheme in [mrdoob/three-quake](https://github.com/mrdoob/three-quake) (`src/in_web.js`, `src/pmove.js`). This trades some of 0009's scripted ceremony for embodiment.

## Decision

**Mouselook via Pointer Lock.** Clicking the canvas captures the mouse; yaw/pitch come from raw `movementX/movementY` using Quake's exact view-angle math — `delta = mouse × sensitivity(3) × m_yaw/m_pitch(0.022)` — with pitch clamped to ±80°. The camera is driven by an Euler rotation (`YXZ` order), not by `lookAt` toward a selected door.

**WASD movement with Quake ground physics.** Locomotion ports Quake's `PM_Friction` + `PM_Accelerate` (accelerate 10, friction 4, stopspeed:maxspeed ratio 100:320), with maxspeed scaled to this room's small unit system. The accel/friction "glide" is Quake's, not a linear lerp. WASD and the arrow keys both move (mouse turns), so left/right strafe rather than cycle exits.

**The room is a real walkable box.** Collision clamps the player to the corridor interior — side walls, the back recess, and the far wall that holds the doors. You inhabit the room and walk around it; you do not ride a track through it.

**Doorway-walkthrough is navigation.** Walking into a door opening on the far wall triggers that edge's node transition — replacing arrow-key exit selection. You take the exit you physically walk through. The room-to-room transition itself remains a short (~1.4 s) walk tween plus the Encounter overlay, reusing the existing arrival path (`enterNode`, room theming, audio stings) unchanged.

**The cosmetic projection is preserved.** Each room is still an independent straight tunnel; geometry does not encode DAG topology (0007's grid-reproject rejection stands). The minimap remains the macro-navigation tool. The corridor is now *lightly* navigational — you choose a door by walking to it — but it is still not a spatially accurate map of the graph.

**Touch / no-mouse fallback is preserved.** Hold ▲ to walk forward, ◀/▶ to turn — so Pointer Lock is not a hard requirement on touch or trackpad-only setups. A one-time `CLICK TO LOOK · WASD MOVE · E ENTER` hint covers discoverability and auto-hides on first input. `E`/`Enter` opens the current room's Encounter.

**Graceful failure for now-mandatory 3D.** Because the controls — and the whole experience — require WebGL, a WebGL-unavailable or scene-build failure shows a recoverable pure-DOM `EXIT` overlay (with Esc) instead of trapping the player on a black full-screen takeover. The diegetic error scenes from earlier work themselves use WebGL, so they cannot cover the no-WebGL case; this DOM fallback is the floor.

## Considered alternatives

**Keep abstract tween movement (0007 / 0009 status quo).** Camera pivots to the selected door; forward tweens to the next node. Rejected: it reads as a slideshow rather than a place, and the user explicitly asked for Quake controls. Embodiment is the goal now.

**Mouselook only; keep arrow-cycle + tween for locomotion.** Add free look but keep abstract movement. Rejected as a half-measure — a free camera attached to an on-rails body is more uncanny than either pure model; looking around a room you cannot walk in breaks the illusion worse than not looking at all.

**Full grid reproject / spatially-accurate corridors.** Make the 3D layout encode the DAG so corridors connect nodes accurately. Still rejected, per 0007: a backend coordinate-model change for navigational accuracy the minimap already provides. Quake controls deliver embodiment *without* spatial accuracy — each room is its own box.

**Stock `PointerLockControls` from three/examples.** Use the generic helper. Rejected in favour of porting three-quake's actual constants (sensitivity, m_yaw/m_pitch, accelerate/friction/stopspeed) so the feel is authentically Quake rather than a generic FPS controller.

**Bring Quake controls to the Hub and special rooms too.** Unify all room controllers (Hub, Wall of Fame, Shop, Archive, Hall of Records) on the FPS scheme. Deferred, not rejected: those are "walk up to a diegetic surface" scenes (ADR 0008) where the lookAt/click controller is adequate, and converting them is larger scope with less payoff. The dungeon — where you traverse between nodes — is where FPS movement earns its keep. A later ADR may unify them.

## Consequences

- **ADR 0007's "Movement model" and "Navigation" sections are superseded.** Abstract tween-to-node movement and arrow-cycle exits are gone. The cosmetic-projection geometry and the minimap described in 0007 remain in force.
- **ADR 0009's "Ceremony is the point" is revised, not discarded.** Ceremony *between* rooms — the inter-room walk tween, the Hub-to-Today commitment, the boss-clear two-beat — remains non-skippable. Movement *within* a room is now player-driven agency. The framing shifts from "watch the choreography" to "inhabit the space, and the choreography still carries you between rooms." 0009's no-skip-path stance is intact: there is no fast-travel; you still walk the dungeon.
- **0009's "navigate by minimap, corridors are flavor" is softened.** Corridors are now lightly navigational (you walk to the door you want), but the minimap is still the macro-navigation tool and geometry still does not encode topology. Attention budget still concentrates in rooms.
- **Pointer Lock is now part of the contract.** The dungeon requests pointer lock on canvas click and releases it for Encounters, menus, and teardown. Host/plugin integrations must tolerate The Daily capturing the mouse during play.
- **WebGL is load-bearing with a defined failure mode.** A recoverable DOM exit replaces the black-screen trap, strengthening 0007's renderer decision rather than changing it. The CDN single-point-of-failure (and the standing "bundle ThreeJS for reliability" question from 0007/0009) is unchanged.
- **Control feel is intentionally non-uniform across room types.** The dungeon uses Quake controls; the Hub and special rooms still use the legacy lookAt/click controller until a follow-up unifies them.
- **Headless testing cannot grant real Pointer Lock.** Verification drives synthetic `movementX`/`movementY` with a faked `pointerLockElement`; the math path is exercised, but real capture and sensitivity feel must be confirmed in the live app.
