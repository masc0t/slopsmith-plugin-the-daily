# Recovery-code identity & local-primary mirror for plan-03 meta-progression

## Status

accepted

## Context

Plan 03 (tokens, shop, passport) introduces persistent meta-progression for The Daily. It accumulates over months of play and is the most emotionally load-bearing data the plugin will own — the passport in particular is framed as a sentimental artifact. Slopsmith has no real user authentication: the existing leaderboard runs on a public Supabase anon key, with `install_id` (a per-install UUID) as the only client-side handle. Cost is not a constraint (Supabase free tier handles >1000 users comfortably for this data shape).

## Decision

- **Local SQLite is the source of truth.** Tokens, cosmetics, equipped slots, stamps, and passport history all live in `the_daily.db` first.
- **Supabase mirrors state via a 4-word BIP39-style recovery code** that the user generates on first launch and saves themselves. The code is the lookup key for `inventory` and `passport_entries` rows on Supabase.
- **Single-identity, last-write-wins.** A recovery code is meant to be active on one install at a time. Pasting an existing code on a new install pulls the remote row and overwrites local; the old install becomes orphaned. No server-side merge logic.
- **Push triggers (5):** boss clear, shop purchase, equip change, stamp earn, app close. Debounced 2s. No periodic poll. Pull only on first paste of a recovery code or via an explicit "force re-sync" button.
- **Token ledger stays local-only.** It is a forensic tool; mirroring it would waste bandwidth and add no user-visible value.

## Considered alternatives

- **Pure local with no mirror.** Reinstall = total data loss including passport. Rejected: passport is the sentimental payoff; losing it is real grief.
- **Discord OAuth or email magic link.** Real identity, real multi-device. Rejected for V1: scope explosion, friction, contradicts the self-hosted single-player ethos. Reachable as V2 if abuse appears.
- **Multi-device merge with per-row `updated_at`.** Server-side conflict resolution (tokens = max, completions = union, etc). Rejected: merging breaks ledger audit, niche use case for a self-hosted CDLC tool, and the data shape A's flow stores is a strict subset of what B would need — easy to upgrade later if real demand surfaces.

## Consequences

- A user running two installs with the same code clobbers themselves. Documented as user responsibility, not a server-side problem.
- Recovery code loss = data loss. Equivalent to wallet seed-phrase UX. Acceptable because the stake is cosmetics and a passport, not money.
- No catch-up grant on first feature use (see plan 03 / Q11 grill). Fresh start for everyone keeps the economy honest and avoids dead-loop shops on day 1.
- Future migration to real auth is a strict superset — `recovery_code` becomes one of several lookup paths to the same row.
