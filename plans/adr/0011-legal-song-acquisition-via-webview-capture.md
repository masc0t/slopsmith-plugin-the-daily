# Legal song acquisition via webview Capture and a crowd-sourced Host-URL cache

The biggest friction in the Dungeon is that every Room a player might enter needs a manual CustomsForge round-trip (open page → download → drop file → rescan → lost flow), and a single day puts ~40-50 distinct songs in play while any one path plays only ~7. The obvious fix — auto-downloading via CF's signed `…/user/collectedcdlcs/toggle/<id>?expires=…&signature=…` URL — is the **prohibited** path: that endpoint is account-bound, expiring, and hitting it programmatically is exactly the "bots/scrapers using CustomsForge without staff approval" the community rules forbid. So we keep CF's *listing* (`cf_url`) but never touch CF programmatically, and obtain the **Host URL** (the author's Dropbox/Drive/OneDrive/Mega/Mediafire link the PSARC actually lives on) only from a human's own click.

## Decision

**Hard boundary — no automated CustomsForge access.** Every byte that comes off CF/host is pulled by the user's own browser from a human click on CF's own page. The app may do everything on *either side* of that click — set it up, clean up after — never the click itself. The old `find_more` (`streamer-monitor` branch) `/download` endpoint, which used a stored CF cookie to hit the toggle URL and capture the redirect (with rate-limiting/backoff — the tell of a polite scraper), is **deliberately not restored**. Only its provider-download half (Host URL → file) is reused.

Two layered wins over the manual baseline:

- **Win #1 — the Manual Floor (all platforms, always on).** A folder-watch on the DLC/Downloads folder auto-rescans the moment a new `.psarc` lands and returns the player to the Room. The human still clicks CF, but the rescan/alt-tab/lost-flow friction vanishes. This is the floor everything degrades to; it needs no cache, no network, no scale.
- **Win #2 — Capture + Unlock + crowd-sourced cache (desktop only).** The desktop app's embedded webview observes the player's *own* download and **Captures** the Host URL (legal — observing your own window after a human click, not botting CF). The first Capture **Unlocks** the song: the Host URL is stored locally *and* mirrored to Supabase (same anon read/insert model as the Wall of Fame), so every later player silently Acquires it with zero clicks. Desktop-only because webview interception is the only cross-origin-safe Capture mechanism; browser users get Win #1.

**Provider handling.** Hard providers (Mega's fragment-key decryption, OneDrive's browser auth) are fetched **through the webview**, which is a real browser engine and handles them natively with no extra dependency; easy providers (Dropbox `?dl=1`, Mediafire, Drive's confirm-token dance) use a fast-path HTTP GET. If the webview path misbehaves for Mega, fall back to the `megadl` CLI (the back-pocket native dependency).

**Trust — solo-first, community-as-bonus.** Because the realistic audience is anywhere from 1 to ~500 and is mostly the author, the design must already feel great at N=1 and treat extra players as free upside. So:
- **Trust-on-first-capture** for silent fetch — a song goes frictionless the moment *anyone* (including future-you on a replay/Archive/second machine) Captures it. No corroboration gate, which would never graduate a song at small scale and would punish the very person it's built for.
- **Per-file validation is the safety floor** and works at N=1: every fetched file must be a valid PSARC whose embedded artist/title matches the expected song, or it is rejected.
- The content **hash is recorded but not gated** — kept as a column so corroboration/quarantine can be switched on later *if* poisoning ever becomes real at scale.

**Two failure modes, handled oppositely.**
- *Recoverable* (dead/quota-locked/stale link, network error — the song is legit): degrade to the **Manual Floor**; the human's click recovers the file and re-Captures a fresh Host URL, self-healing the cache.
- *Untrustworthy* (Host URL yields a non-`.psarc` — a `.zip`, archive, or multi-file): mark the song a **Reported Item**, **auto-complete its Room**, and move on, so a choice-based path is never trapped by un-acquirable content.

## Consequences

- The same code degrades smoothly across the whole population range — N=1 rides your own Captures, N=many runs warm with occasional hot-link quota-locks quietly falling back to the Manual Floor. **No scale assumption is baked anywhere.**
- Win #2's reach has an **uncontrollable scale ceiling**: hot nodes (boss, forced-start) are one Host URL on one author account and will quota-lock as the playerbase grows. We accept this — the only "raise the ceiling" move that respects the community is **per-author opt-in mirrors** (consented redistribution with attribution), and that is **deferred** until a link actually dies under load. Rehosting files without consent is rejected outright (redistribution violation + author harm).
- Auto-completing a **Reported Item**'s Room grants a "free" clear on a song the player didn't play. Accepted: completion is already trust-based (local, self-reported), and not trapping the run matters more.
- Browser users never get silent fetch — only desktop. Accepted, since the majority run the desktop app.

## Considered and rejected

- **Automated CF download via the signed toggle URL** — the prohibited path; the whole reason this ADR exists.
- **Hand-seeding the cache** — ~40-50 manual downloads/day by the author; doesn't survive a weekend off, doesn't scale.
- **Strict hash-agreement gate (≥2 corroborating installs before silent fetch)** — never graduates songs at small scale and makes the solo case *worse*, inverting the solo-first priority.
- **Rehosting PSARCs on a neutral CDN** — fixes bandwidth but is the "no collections / folders to multiple CDLC" violation and harms authors; off the table without per-author consent.
