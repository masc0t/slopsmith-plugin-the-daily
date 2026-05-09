# Analyze — The Daily

## Coverage

| Area              | Spec | Plan | Code         | Notes                                       |
|-------------------|------|------|--------------|---------------------------------------------|
| Setlist gen       | ✅   | ✅   | `routes.py`  | Deterministic seed + dispatch               |
| Modifier types    | ✅   | ✅   | `routes.py`  | 8 types; closed taxonomy                    |
| DB                | ✅   | ✅   | `routes.py`  | Three tables, lock-on-write                 |
| Pool loading      | ✅   | ✅   | `routes.py`  | cache → remote → bundled                    |
| Frontend views    | ✅   | ✅   | `screen.html`+JS | setlist / complete / leaderboard          |
| Wall of Fame      | ✅   | ✅   | `routes.py`  | Supabase anon-key                           |
| Streak            | ✅   | ✅   | `routes.py`  | Local backwards walk                        |
| Tests             | ❌   | ❌   | —            | None automated; `preview.py` is the harness |

## Drift

- `CLAUDE.md` matches `routes.py` exactly (it was written alongside the
  code). No drift detected.
- README is missing from this repo. The user-facing copy lives in the UI
  + `CLAUDE.md`. A short README pointing at the Daily nav button would
  help discoverability.
- Hard-coded `SUPABASE_URL` and `POOL_URL` mean forks accidentally share
  state — flagged in `clarify.md` Q12.

## Gaps

1. **No automated test harness.** `preview.py` exists but isn't wired into
   CI or pytest. Determinism (constitution §I) is enforced by hand.
2. **Hard-coded canonical backend** for forks (Q12).
3. **Supabase abuse policy** is implicit — RLS / rate-limit lives outside
   this repo.
4. **Time-zone semantics** are server-UTC. A user in Auckland sees
   "today's" setlist roll over at 1 PM local; minor friction.
5. **Pool freshness vs determinism**: pool changes (e.g. `build_pool.py`
   adds new songs) ripple into selectors that depend on cf_id presence.
   The cache mitigates this within a day; cross-day consistency is by
   design.
6. **No README** in the repo. Discoverability for forkers.
7. **Optimistic mark may inflate streaks**: opening a song and bouncing
   still credits completion (Q4 / §VI). Tradeoff is documented but worth
   re-evaluating for "competitive" framing.

## Recommendations

- **Wire `preview.py` into CI** as a smoke test. Fail PRs that change the
  fallback rate by more than X% over a 90-day window.
- **Env-var overrides** for `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
  `POOL_URL`. Document the override flow for forks.
- **Document Supabase RLS** in this repo (or as a sibling
  `supabase/policies.sql`). The policy is load-bearing for trust.
- **Add a short README** that points at `CLAUDE.md` for technical depth
  and at the Daily nav button for end users.
- **Consider a "completion confirmation" toggle** for users who want
  stricter streak semantics — credit only on `song:ended`, not on `dsPlay`.
- **Pool integrity check**: when `_load_pool()` returns a result, sanity-
  check `len(pool) > some_minimum` and required keys present; refuse with
  a clear error if degraded.
