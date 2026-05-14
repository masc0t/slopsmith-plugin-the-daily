# Lane streak semantics — what counts, what skips, what breaks

## Status

accepted

## Context

Plan 01 introduces per-lane streaks alongside the existing global streak. The plan defines a "committed lane" as the lane label of the path the user walked, and a "mixed" state when the user lane-jumped. But it leaves three questions unresolved that all need consistent answers:

1. **Membership** — which nodes participate in lane identity? Only song-bearing nodes, or every node on the cleared path?
2. **Forced-modifier days** — when the modifier produces a single-lane map (e.g. `identity:decade`), should days where a lane was unavailable break that lane's streak, or be skipped?
3. **Mixed-day storage** — should mixed days be a real value in the leaderboard table, or stored as NULL?

These questions are entangled. The streak walk algorithm and the leaderboard query semantics depend on a coherent answer to all three.

## Decision

**Membership: song nodes only.** The `lane_paths` JSON in `daily_setlists` lists only forced/elite/boss/mystery/choice nodes. Rest, treasure, and shop nodes are excluded from lane membership — they are economy/info surfaces, not genre commitments. Mystery nodes inherit the lane they are planted on (a sprint map's mystery node is sprint-lane regardless of which song the event delivers).

**Forced days: frozen skip.** When a day's `lane_paths` does not contain lane X, the streak walk for X *skips* that day rather than breaking on it. Algorithm: walk backward from today; on each day check whether the lane was available; if not, skip and continue; if yes, check `committed_lane` and either increment or break. Lane streak meaning: "consecutive days where this lane was offered and I committed to it."

**Mixed days: stored value, not NULL.** /sign always sends `(lane, lane_streak)` to Supabase. Mixed-path days store `lane = 'mixed'` and `lane_streak = 0`. Incomplete days never reach /sign (already rejected). Lane filter queries (`?lane=sprint`, `?lane=like.decade_*`) exclude `mixed` and NULL naturally. Mixed users still appear on the Global tab with a mixed-icon glyph. No conditional sign rejection — the contract is "send everything you have, server stores it, filters do the right thing."

## Considered alternatives

- **Strict membership (every cleared node counts).** Visiting a rest node off-lane would break commitment. Rejected: rest nodes are decorative w.r.t. lane identity per plan 02.
- **Dominant-lane membership (≥75% threshold).** Forgiving but introduces a fuzzy boundary. Rejected: arbitrary threshold; hard to explain to users.
- **Strict break on forced days.** A forced-decade day resets all non-decade lane streaks to 0. Rejected: punishes the user for RNG they cannot control; modifiers are the modifier table's choice, not the player's.
- **Hybrid frozen-conditional (skip only if user completed the day).** Skipping the day entirely breaks all streaks. Rejected: layered rule; the streak walk threading through "did you complete today" branches becomes harder to reason about.
- **Mixed days as NULL.** Excludes mixed users from `/leaderboard` entirely. Rejected: mixed is a real choice with a real outcome — show it on Global, just don't credit a lane streak for it.

## Consequences

- The streak walk reads both `daily_setlists` (for `lane_paths`) and `daily_completions` (for `committed_lane`). Both tables must be available locally for the per-lane streak chip to render. With ADR-01's local-primary mirror, this is the default state.
- A user who committed to sprint heavily but the modifier table happens to roll non-sprint days for a long stretch will see a frozen sprint streak. Edge case, but visible: "my sprint streak says 5 but I haven't played sprint in three weeks." Acceptable framing: streak counts sprint-clears, not real-world days.
- The `committed_lane = 'mixed'` storage value means the leaderboard table has four kinds of rows by lane: specific (`sprint`), decade-family (`decade_1980s`), `mixed`, and legacy NULL. Future queries must remember NULL exists for backfilled-empty rows from before this ADR.
- A V2 lane-mastery / lane-only daily mode (plan 03 future hook) needs to honor the frozen-skip rule when computing lifetime lane achievements, or it will under-count by penalizing forced-modifier days.
