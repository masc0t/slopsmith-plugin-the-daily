# Contiguous dungeon floorplan with rock-gated sections

ADR 0007 chose a first-person dungeon but rendered each Room as an *independent
straight tunnel* — a cosmetic projection of the DAG, not a spatially accurate
map. ADR 0010 added Quake walk-controls *within* each tunnel but kept the
per-node teardown: walking into a door triggered a ~1.4 s walk tween that rebuilt
the scene as the next node's tunnel. Both ADRs explicitly rejected a
"grid-reproject / spatially-accurate corridors" model as unnecessary backend work
for accuracy the minimap already provided.

The user has now asked for exactly that, and more: *"a proper dungeon, not just
rooms — you should be able to traverse each area in sections as they unlock, but
everything is all one map,"* and *"instead of doors, make them rocks that blow up
when the room is cleared."* The "place you inhabit" goal of 0010 is only half
delivered while each Room is a sealed box you teleport between. This ADR makes the
whole map one contiguous, walkable space.

## Decision

**The whole map is one contiguous floorplan, built once.** Every Room is placed at
its grid position — `col` drives the lateral (X) axis, `row` drives the forward
(−Z) depth axis, the boss sits centered at the far end. Rooms are connected by
real **Corridors** routed as axis-aligned L-segments (forward, lateral jog,
forward) between Room centers. The player walks the entire dungeon under the
existing Quake controller; there is no per-node teardown, no walk tween, and no
"current tunnel." The 3D layout now *is* the DAG, replacing 0007/0010's cosmetic
projection.

**Walkable space is an occupancy grid; walls are extracted from it.** Room
rectangles and *open* Corridor rectangles are rasterized into a coarse tile grid.
Walls are the boundary edges between walkable and solid tiles, emitted as a single
merged wall geometry (one draw call) and rebuilt only when a section opens. This
makes diagonal/jogged corridors, doorway gaps, and dead-ends fall out
automatically instead of being hand-placed per Room. Floor and ceiling are large
planes spanning the extent; fog (unchanged from 0007) bounds visibility so the
player never sees the whole plan at once.

**Sections unlock by clearing Rooms; the gate is a rockfall that explodes.** A
Corridor `A → B` is **open** iff `B` is *discovered* — `B ∈ available ∪ cleared ∪
committed` from the backend payload. A closed Corridor is physically blocked by a
**Rubble Gate**: a pile of boulders filling the corridor mouth, with its tiles
marked solid so walls seal around it. When `A` is cleared (in place, or on return
from a song), every newly-opened Corridor out of `A` detonates its Rubble Gate —
an explosion of debris, sparks, light flash, and a low boom — then the tiles
become walkable and the wall geometry is rebuilt. This replaces ADR 0010's
door-unseal beat. Committing to a Room still locks its same-row siblings
(0002/STS lane commitment); their entrance Corridors close with a quiet rockfall
rather than an explosion.

**Backend authority is unchanged.** Gate state is derived entirely from the
existing `available_node_ids` / `cleared_node_ids` / `committed_node_ids` /
`locked_node_ids` arrays. No new API surface, no map-generation change — the same
view-layer-only principle as 0007. Commitment is triggered by entering an
available Room (the same `commit` POST the old lane-picker / move tween sent).

**Starting path is chosen up front, not walked to.** On a fresh run (nothing
committed/cleared) with more than one open entrance, a **path picker** overlay
pauses the dungeon and lists the entrance Rooms (icon + song); choosing one places
the player just inside that entrance (committed, siblings sealed) and they walk
forward from there. With a single open entrance the player is dropped straight in.
This replaces the old SVG lane-picker and avoids a sideways trudge across the
antechamber to reach a far lane — the antechamber is now only the staging area
behind the picker. Deeper-in-the-run commitment (picking among a cleared Room's
multiple exits) is still spatial: you walk through the exit you want.

**Per-Room identity comes from lighting, props, and floor, not per-wall texture.**
A single wall material spans the merged wall geometry. Each Room's mood is carried
by (1) its signature **prop** (built once at the Room's center, distance-culled),
(2) a themed floor patch under it, and (3) the follow-lights' color. A small pool
of PointLights tracks the player and tints to the Room currently occupied, so the
WebGL light budget stays fixed regardless of map size.

**The minimap becomes a true overview.** Because geometry now matches the DAG, the
minimap (0007) plots the same coordinates the player walks, plus a live player
marker. It remains the macro-navigation aid.

## Considered alternatives

**Per-Room walls with hand-cut doorway gaps.** Build each Room's four walls and
notch a gap where each Corridor attaches. Rejected: diagonal/jogged corridors make
gap geometry fiddly and error-prone; the occupancy-grid extraction produces
correct walls, gaps, and dead-ends for free and degrades gracefully (stair-stepped
diagonals read fine at the pixelated render scale).

**Per-Room torches as real lights.** Give every Room its own PointLights for true
per-Room wall theming. Rejected: a 30–40 Room map blows the WebGL point-light
budget. Follow-lights keyed to the occupied Room deliver the same felt result at
fixed cost.

**Keep teleport-between-tunnels, just render neighbors.** Render the current tunnel
plus its immediate neighbors so transitions feel connected. Rejected: still reads
as discrete rooms, not "all one map" — the user explicitly asked to traverse the
whole thing.

**Sealed doors that slide/fade open (extend 0010's unseal beat).** Keep doors,
animate them opening on clear. Rejected by the user in favor of rocks that blow up;
the explosion is also a stronger "this section just opened" signal across a large
contiguous space than a door recoloring.

## Consequences

- **ADR 0007's "cosmetic projection" and ADR 0010's "each room is its own box" +
  walk-tween transition are superseded.** Geometry now encodes topology. The
  minimap, encounter overlay, full-screen takeover, Quake controller, and diegetic
  surfaces from 0007/0008/0010 all remain in force.
- **`enterNode` / `rebuildDoors` / the `moving` tween phase are gone.** "Current
  Room" is derived from which Room rectangle contains the camera, and drives HUD,
  saved position, audio motif, light tint, and commit.
- **Saved position is a coordinate, not a node id.** `ds_dun_node_<date>` is
  replaced by a saved camera `x,z`; on load the player resumes where they stood.
- **Commitment is spatial.** Walking into an available, uncommitted Room sends the
  `commit` POST; this can no longer be skipped by a menu. Returning to a partially
  cleared day drops the player back into the contiguous plan with the cleared
  sections already open.
- **Rock detonation is the canonical "section unlocked" beat.** Any future Room
  type that gates progress reuses the Rubble Gate; reintroducing doors would
  contradict this ADR.
- **Performance is now map-size sensitive in geometry, not lighting.** Wall draw
  cost scales with boundary length (one merged mesh); lights are fixed. Prop cost
  is bounded by distance-culling. The render target resolution stays a design
  constant (0007).
- **The per-node door-label/door-color systems are retired.** Door destination
  signs are replaced by walking up and reading the Room itself (its prop +
  minimap). The lane picker survives as a **pre-start path picker** (card list,
  not the old SVG graph) shown only on a fresh multi-entrance run.
