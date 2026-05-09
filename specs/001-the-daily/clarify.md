# Clarifications — The Daily

## Q1 — Why determinism over freshness?
**Resolved.** A "global daily climb" only works if every player on every
install sees the same setlist. That requires a deterministic seed and
modifier dispatch. Constitution §I formalises this.

## Q2 — Why MD5 prefix as the RNG seed?
**Resolved.** `md5(date)[:6]` is short, stable, language-agnostic, and
unbiased enough for this use. Cryptographic strength is irrelevant — it's
a coin-toss seed for non-adversarial selection.

## Q3 — Why is the pool fetched from a GitHub release?
**Resolved.** `songs_pool.json` is ~14 MB — too big to commit. Releases
host it as a static asset and `_load_pool()` falls through to bundled
data on offline installs. The build (`build_pool.py`) needs Discord +
CustomsForge credentials nobody else has, so end users never run it.

## Q4 — Why optimistic completion (mark before play)?
**Resolved.** `playSong` navigates away from the Daily screen. If we marked
on `song:ended`, a user who closes the tab mid-song would never get credit.
Constitution §VI formalises the tradeoff.

## Q5 — Why is the Supabase anon key committed?
**Resolved.** It's an anon key with read-and-insert-only permissions on a
public leaderboard table. Treating it as secret would only obscure the
shared service URL. The README/CLAUDE.md call this out.

## Q6 — How are modifier types vetted before adding?
**Resolved.** Run `preview.py --days 90` and check the fallback rate.
Anything > ~5% means the selector is wrong (constitution §IV). New
modifier types extend the dispatch in `_select_songs` explicitly — no
ad-hoc switches inside selectors (constitution §III).

## Q7 — Why does the streak come from the client?
**Resolved.** The streak is computed locally (`_compute_streak`) walking
the local `daily_completions` table backwards. Supabase doesn't verify it;
streaks are aspirational, not authoritative. Reasonable for a flavour
feature; not for a competitive leaderboard.

## Q8 — Why text→JSON.parse instead of resp.json()?
**Resolved.** Several endpoints can return empty 200s under specific
conditions (e.g. `/leaderboard` when not configured). `resp.json()` throws
on empty body; `JSON.parse(await resp.text())` lets us handle empties
explicitly.

## Q9 — How does versioning evolve a modifier without rewriting history?
**Resolved.** Seed with `_date_seed(date) + "v2"` for the new behaviour.
Past dates keep using the old code path. This is the canonical
break-compat-without-breaking-history pattern.

## Q10 — Why are anti-repetition windows 14 days?
**Resolved.** Two weeks is enough to feel novelty without locking out
small-pool installs (some users have <100 CDLC). The "drop exclusion if
pool < 5" guard prevents starvation.

## Q11 — What happens when the user has zero local CDLC matching today's
setlist?
**Resolved.** Songs are enriched with `has_locally: false`. The UI shows
them as missing; play is disabled. Modifier completion is impossible until
they download the missing CDLC. Acceptable; users can preview the modifier
without playing.

## Q12 — Open: forks vs canonical state?
**Open.** Today the bundled pool and Supabase URL point at the canonical
backend. Forks must override `POOL_URL` and `SUPABASE_URL` in `routes.py`
to avoid contaminating shared state. A clearer override mechanism (env
vars, config file) would be friendlier.
