# Bank action is an early partial grant; boss reconcile subtracts what was banked

## Status

accepted

## Context

ADR-01 / Q4 of the plan-03 grill locked token grants as **buffered, single ledger row at boss clear**. Plan 02 then introduces the Bank Progress action on rest nodes: a one-shot per rest node that converts current run progress into tokens immediately, at a smaller rate, with the framing that banking trades certainty for total. This contradicts the "single ledger row" phrasing on its face — banking writes mid-day, before any boss clear has happened.

Plan 02 explicitly rejects the punitive model ("banking forfeits all further token grants today") and the trivializing model ("banking adds tokens on top of boss reconcile"). The middle path needed pinning.

## Decision

- **Bank = early partial grant.** Clicking Bank at a rest node grants `2 * (cleared_count - already_banked_count)` tokens immediately and writes a `daily_node_actions` row with `payload = {tokens: N, banked_count: M}`.
- **Multiple rest nodes can each bank.** Each subsequent bank only pays out for clears since the prior bank, tracked via `banked_count` on the most recent action row. Idempotent on PK `(install_id, date, node_id, action='rest:bank')`.
- **Boss reconcile subtracts.** When the boss is cleared, the day-complete grant is `(3 * total_cleared + 5 + bonuses) - sum(banked_today)`. Net total cap is unchanged; banking only shifts timing.
- **Ledger is multi-row per banked day.** Q4's "single ledger row per day" relaxes to "≤1 reconcile row + N bank rows," with distinct `reason` values (`rest_bank` vs `day_complete`) so the audit trail stays separable.

## Considered alternatives

- **Forfeit-on-bank.** Banking ends today's token earn. Punitive — contradicts plan 02's "doesn't prevent finishing the day."
- **Bonus-on-bank.** Bank tokens stack on top of boss reconcile. Trivially better than no-bank; eliminates the trade-off.
- **Single-bank-per-day cap.** Only one rest node can bank per day, regardless of how many rest nodes are on the path. Simpler bookkeeping but punishes maps with multiple rest nodes.

## Consequences

- Q4's "single ledger row per day" is no longer literal. The forensic ledger now reflects the user's banking choices. Acceptable: the reason-tagged rows still reconstruct the day.
- The bank trade is real but small: `cleared_count = 3` → bank now = 6 tokens guaranteed; wait + finish = 14 tokens; wait + abandon = 0. Risk/reward depends on the user's confidence they'll clear the boss. Tunable via the `2x` and `3x+5` constants.
- Plan 03's `daily_token_ledger` is the audit surface that makes this debuggable. Without the ledger, "why did I get 14 tokens at boss clear instead of 20" would be opaque.
- A future change to grant rates needs to update both bank and reconcile formulas in lockstep, or banking becomes either always-better or always-worse. Worth a comment at the constants.
