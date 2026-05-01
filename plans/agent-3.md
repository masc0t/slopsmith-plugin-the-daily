# Agent 3 — Build mystery event frontend

The mystery event backend is built and wired (`GET` and `POST /api/plugins/the_daily/mystery/{node_id}` + `/submit`), but the frontend never calls either endpoint. Today, clicking a mystery node falls through to the legacy code at `screen.js:590-594` which just plays a random song from `node.cf_pool` — the new `event_type` and `event_payload` data is ignored. Build the V1 frontend per `plans/04-mystery-event-table.md`.

## Scope — V1 events only

Implement three event types: `guess_year`, `blind_pick`, `replay`. Other event types in `MYSTERY_EVENTS` (cover_battle, etc.) are V2 and not in scope.

## Endpoints (already implemented in routes.py)

- `GET /api/plugins/the_daily/mystery/{node_id}` — returns `{event_type, event_payload}`. The server strips answer fields (e.g. `answer_year`) before sending. The payload includes `cf_id` so the frontend can look up the song from `_dsData.songs`.
- `POST /api/plugins/the_daily/mystery/{node_id}/submit` — body `{payload: {...}}`. Returns event-specific result.
  - `guess_year` submit body: `{payload: {guess: <int>}}` → returns `{correct_year, guess, delta}`.
  - `blind_pick` submit body: `{payload: {}}` → returns `{revealed: true}`.
  - `replay` submit body: `{payload: {}}` → returns `{originally_seen_date}`.

See `routes.py:3782-3837` for exact server behavior.

## Changes to `screen.js`

### 1. Add mystery dispatch to `dsOpenNode`

Around `screen.js:576`, `dsOpenNode` already dispatches to `dsOpenTreasure` and `dsOpenRest`. Add a third dispatch for mystery, **and remove the legacy mystery branch**:

```js
function dsOpenNode(nodeId) {
    if (!_dsData?.map) return;
    const panel = document.getElementById('ds-map-panel');
    const node = _dsData.map.nodes.find(n => n.id === nodeId);
    if (!panel || !node) return;
    if (node.type === 'treasure') return dsOpenTreasure(nodeId);
    if (node.type === 'rest')     return dsOpenRest(nodeId);
    if (node.type === 'mystery')  return dsOpenMystery(nodeId);
    // existing logic for choice / boss / forced / elite / shop:
    const songMap = ...   // KEEP existing
    // ... but DELETE the `else if (node.type === 'mystery')` branch (lines ~590-594)
    //     since dsOpenMystery handles it now
}
```

### 2. Implement `dsOpenMystery(nodeId)`

```js
async function dsOpenMystery(nodeId) {
    if (!_dsData?.map) return;
    const node = _dsData.map.nodes.find(n => n.id === nodeId);
    const panel = document.getElementById('ds-map-panel');
    if (!panel || !node) return;

    const cleared = new Set(_dsData.cleared_node_ids || []);
    const available = new Set(_dsData.available_node_ids || []);
    const canPlay = available.has(nodeId) || cleared.has(nodeId);

    try {
        const resp = await fetch(dsApiUrl(`/api/plugins/the_daily/mystery/${encodeURIComponent(nodeId)}`));
        const text = await resp.text();
        const data = text ? JSON.parse(text) : {};
        if (data.error) {
            panel.innerHTML = `<div class="text-sm text-yellow-400 text-center py-3">${esc(data.error)}</div>`;
            return;
        }
        const songMap = Object.fromEntries((_dsData.songs || []).map(s => [s.cf_id, s]));
        const song = songMap[data.event_payload?.cf_id];
        if (!song) {
            panel.innerHTML = '<div class="text-sm text-gray-500 text-center py-3">Song not found.</div>';
            return;
        }
        switch (data.event_type) {
            case 'guess_year':  return dsRenderGuessYear(node, song, data.event_payload, canPlay);
            case 'blind_pick':  return dsRenderBlindPick(node, song, data.event_payload, canPlay);
            case 'replay':      return dsRenderReplay(node, song, data.event_payload, canPlay);
            default:            return dsRenderMysteryFallback(node, song, canPlay);
        }
    } catch (e) {
        panel.innerHTML = '<div class="text-sm text-red-400 text-center py-3">Network error.</div>';
    }
}
```

### 3. Implement the three V1 renderers

**`dsRenderGuessYear`** — show a number input + Submit & Play. On submit, POST the guess, then call `dsPlayMapNode(nodeId, song.cf_id, song.local_filename)`. After the song ends (`window.slopsmith.on('song:ended')` — see existing `_dsReturnAfterPlayback` mechanism), display the result modal: "You guessed YYYY. It was YYYY. Off by N years."

```js
function dsRenderGuessYear(node, song, payload, canPlay) {
    const panel = document.getElementById('ds-map-panel');
    const local = song.has_locally;
    const playable = local && canPlay;
    panel.innerHTML = `<div class="bg-dark-700/50 border border-purple-700/40 rounded-2xl p-4 text-left">
        <div class="flex items-center gap-2 mb-3"><span class="text-xl">🎲</span><span class="text-sm font-semibold text-white">Mystery · Guess the Year</span></div>
        <div class="text-sm text-gray-400 mb-3">Guess what year this song was released. We'll show you how close you were after it ends.</div>
        <input id="ds-mystery-year-input" type="number" min="1900" max="2100" placeholder="e.g. 1978" class="w-full px-3 py-2 mb-3 rounded-lg bg-dark-800 border border-gray-700 text-white text-sm" />
        <button onclick="dsSubmitGuessYear('${esc(node.id)}', ${song.cf_id}, '${esc(song.local_filename || '')}')" ${playable ? '' : 'disabled'} class="w-full bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 rounded-xl text-sm font-semibold text-white transition">Submit Guess & Play</button>
    </div>`;
}

async function dsSubmitGuessYear(nodeId, cfId, filename) {
    const input = document.getElementById('ds-mystery-year-input');
    const guess = input ? parseInt(input.value, 10) : NaN;
    if (!Number.isFinite(guess)) {
        // simple inline validation
        if (input) input.classList.add('border-red-500');
        return;
    }
    try {
        await fetch(dsApiUrl(`/api/plugins/the_daily/mystery/${encodeURIComponent(nodeId)}/submit`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ install_id: dsInstallId(), payload: { guess } }),
        });
    } catch (e) { /* swallow — server will rejected on next call if any */ }
    // Stash for the post-play reveal:
    _dsPendingMysteryReveal = { nodeId, type: 'guess_year', guess };
    dsPlayMapNode(nodeId, cfId, filename);
}
```

After the song ends, hook into `window.slopsmith.on('song:ended', ...)` (or the existing `_dsReturnAfterPlayback` codepath) and, if `_dsPendingMysteryReveal` is set, fetch the submit result again (or read the cached `daily_node_actions` row by re-GETting the mystery endpoint after the answer is unmasked — easier: have `dsSubmitGuessYear` await the POST and store its full result, then show the reveal modal on song:ended).

Recommendation: capture the POST result up front, since the answer is in the response. Store it in `_dsPendingMysteryReveal`, then on song:ended call a small `dsShowGuessYearReveal(result)` that swaps the panel HTML.

**`dsRenderBlindPick`** — show "Press play. Title and artist will appear after 5 seconds." plus a Play button. When the user clicks Play, call `dsPlayMapNode(...)` as normal. The trick: hide title/artist in `#ds-now-playing` (or wherever the player chrome shows song info) for the first 5 seconds of playback, then reveal.

The simplest implementation: when `dsPlayMapNode` is called from a blind_pick context, set a flag `_dsBlindPickActive = true` and start a 5-second `setTimeout`. Until the timeout fires, the song-info DOM elements show `???`. After the timeout, restore the actual title/artist. Reset flag on song:ended.

```js
function dsRenderBlindPick(node, song, payload, canPlay) {
    const panel = document.getElementById('ds-map-panel');
    const local = song.has_locally;
    const playable = local && canPlay;
    const revealAt = (payload && payload.reveal_at_seconds) || 5;
    panel.innerHTML = `<div class="bg-dark-700/50 border border-purple-700/40 rounded-2xl p-4 text-left">
        <div class="flex items-center gap-2 mb-3"><span class="text-xl">🎲</span><span class="text-sm font-semibold text-white">Mystery · Blind Pick</span></div>
        <div class="text-sm text-gray-400 mb-3">Press play. Title and artist will appear after ${revealAt} seconds.</div>
        <button onclick="dsStartBlindPick('${esc(node.id)}', ${song.cf_id}, '${esc(song.local_filename || '')}', ${revealAt})" ${playable ? '' : 'disabled'} class="w-full bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 rounded-xl text-sm font-semibold text-white transition">Play Blind</button>
    </div>`;
}
```

Implement `dsStartBlindPick(nodeId, cfId, filename, revealAt)` to: POST submit, set `_dsBlindPickRevealAt = Date.now() + revealAt*1000`, call dsPlayMapNode, and somewhere in the existing player-chrome render logic check the flag and substitute "???" for title/artist until the deadline. If the existing player chrome doesn't have an obvious extension point, the cheapest hack is a setTimeout that swaps a CSS class on the song-info container — e.g. add class `ds-blind` (with `color: transparent` or replaced text via CSS pseudo) for `revealAt` ms then remove it.

Look at how `screen.js` currently displays the playing song (e.g. find where it sets the title in the chrome) to pick the cleanest spot. Don't modify how the song *plays* — only the visible label.

**`dsRenderReplay`** — show a flavor card and a Play button. POST submit on play (so it's recorded), no special player handling.

```js
function dsRenderReplay(node, song, payload, canPlay) {
    const panel = document.getElementById('ds-map-panel');
    const local = song.has_locally;
    const playable = local && canPlay;
    const seenDate = payload?.originally_seen_date || '';
    panel.innerHTML = `<div class="bg-dark-700/50 border border-purple-700/40 rounded-2xl p-4 text-left">
        <div class="flex items-center gap-2 mb-3"><span class="text-xl">🔁</span><span class="text-sm font-semibold text-white">Mystery · Replay</span></div>
        <div class="text-sm text-gray-400 mb-3">You've seen this one before${seenDate ? ` — first appeared on <span class="text-gray-300">${esc(seenDate)}</span>` : ''}.</div>
        <div class="text-sm font-medium text-white">${esc(song.title)}</div>
        <div class="text-xs text-gray-500 mb-3">${esc(song.artist || '')} · ${esc(song.tuning || '—')}</div>
        <button onclick="dsSubmitAndPlayReplay('${esc(node.id)}', ${song.cf_id}, '${esc(song.local_filename || '')}')" ${playable ? '' : 'disabled'} class="w-full bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 rounded-xl text-sm font-semibold text-white transition">Play</button>
    </div>`;
}
```

`dsSubmitAndPlayReplay` POSTs `{payload: {}}` to the submit endpoint (so the action is recorded in `daily_node_actions`) then calls `dsPlayMapNode`.

### 4. Globals export

Add to the existing `window.dsX = dsX` block (around `screen.js:1887`):

```js
window.dsOpenMystery = dsOpenMystery;
window.dsSubmitGuessYear = dsSubmitGuessYear;
window.dsStartBlindPick = dsStartBlindPick;
window.dsSubmitAndPlayReplay = dsSubmitAndPlayReplay;
```

(`onclick=` attributes in the HTML strings need these on `window`.)

## Verification

- `node -c screen.js` exits 0.
- `grep -n 'dsOpenMystery' screen.js` shows the function definition + the dispatch in `dsOpenNode` + the window export.
- `grep -n 'else if (node.type === .mystery.)' screen.js` returns no matches (legacy branch deleted).
- Manual: open a daily that has a mystery node (use `THE_DAILY_TEST_TODAY` env var or wait for one). Click the mystery node. Confirm:
  - For `guess_year`: a year input appears, submitting and playing works, post-play reveal shows the delta.
  - For `blind_pick`: title/artist hidden for 5s after play starts, then revealed.
  - For `replay`: flavor card with original date shown, plays normally.

## Out of scope

- No backend changes — `routes.py` is correct as-is. Don't touch it.
- No new event types beyond V1. Cover_battle, setlist_sibling, etc. are V2.
- No cross-player aggregates ("avg guess delta") — that's V2 once we have Supabase event stats.
- Don't touch `screen.html`, `plans/`, `routes.py`, or any backend files.
- Don't delete any scratch files at the repo root (the user is handling those).
