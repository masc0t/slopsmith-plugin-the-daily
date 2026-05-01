# Agent 4 — Fix blind_pick title-hiding (hallucinated DOM IDs)

The blind_pick mystery event is fully wired (UI, timer, state machine, POST), but the visual effect — hiding the song's title and artist for the first N seconds of playback — silently does nothing.

## The bug

In `C:\Users\jimey\slopsmith\plugins\the_daily\screen.js`, the agent that built mystery events invented two DOM element IDs that don't exist:

- `ds-now-playing-title`
- `ds-now-playing-artist`

These IDs appear in four places:

- Lines 722-725 in `dsStartBlindPick` — adds `ds-blind-hidden` class
- Lines 729-732 in the same function's setTimeout — removes the class
- Lines 136-139 in the song:ended handler — also removes the class

`document.getElementById` returns `null`, the `if (titleEl)` guards short-circuit, and nothing visible happens. The CSS at line 103 (`.ds-blind-hidden { visibility: hidden; }`) is correct but never gets applied to anything.

Verify by grepping the entire repo:

```
grep -rn 'ds-now-playing-title\|ds-now-playing-artist' C:\Users\jimey\slopsmith
```

You'll find them only in `screen.js` — never anywhere they could match.

## Investigation step (do this first)

The actual DOM that shows the currently-playing song lives in the parent Slopsmith app, not in the plugin. Read these files to find the real elements:

- `C:\Users\jimey\slopsmith\static\index.html` — look for the player chrome. Search for elements that look like a song title display (any element near the `<audio>` tag, or near `#player-controls`).
- `C:\Users\jimey\slopsmith\static\app.js` — find where `playSong` (or its callees) writes the title/artist into the DOM. The setter is the authoritative source — whatever element it writes to is what you want to hide.

Useful searches:

```
grep -n 'playSong\|songInfo\.title\|innerText\|textContent' C:\Users\jimey\slopsmith\static\app.js
```

The right element is whichever one app.js sets when a song starts playing.

## Two acceptable fixes — pick one

### Option A — direct element targeting

Replace the four hallucinated IDs with the real ones you found in the investigation step. Update lines 722, 723, 729, 730, 136, 137 in `screen.js` to use the actual selectors. If the real selector is a class or attribute rather than an id, use `document.querySelector(...)` instead of `getElementById(...)`.

### Option B — body-class approach (recommended if no stable ID exists)

If the parent app's chrome doesn't have stable IDs, or if you want to decouple from its DOM structure, use a body-level class:

1. In the existing `<style>` block injection (around `screen.js:103`), expand the CSS:
   ```js
   style.textContent = `
       .ds-blind-hidden { visibility: hidden; }
       body.ds-blind-active <SELECTOR> { visibility: hidden; }
   `;
   ```
   Replace `<SELECTOR>` with whatever selector matches the parent app's title/artist elements (you'll know after the investigation step).

2. In `dsStartBlindPick`, replace the four lines that add/remove `ds-blind-hidden` on individual elements with:
   ```js
   document.body.classList.add('ds-blind-active');
   ```
   And in the setTimeout callback:
   ```js
   document.body.classList.remove('ds-blind-active');
   ```

3. Same change in the song:ended handler at lines 136-139 — just remove the body class instead of trying to hit individual elements.

This is more robust because the parent app can rename or restructure its chrome without breaking blind_pick, as long as the selector pattern stays valid.

## Verification

- `node -c screen.js` exits 0.
- Manually trigger a blind_pick mystery node (use `THE_DAILY_TEST_TODAY` env var to force a date with a blind_pick event, or wait for one). Confirm:
  - Title and artist are NOT visible during the first 5 seconds of playback.
  - They reveal after 5 seconds.
  - If the song ends before 5 seconds, they reveal immediately on song:ended (don't stay hidden).
- `grep -n 'ds-now-playing-title\|ds-now-playing-artist' screen.js` returns nothing.

## Out of scope

- Don't change anything in `static/` (the parent Slopsmith app). Only read those files.
- Don't touch `routes.py`, `screen.html`, `plans/`, or any other file beyond `screen.js`.
- Don't add new mystery event types or refactor existing ones.
- Don't touch the existing CSS injection beyond the one rule needed for option B.
