# Agent 2 — Fix screen.js parse error

Fix the parse error in `C:\Users\jimey\slopsmith\plugins\the_daily\screen.js`. Currently the file does not parse:

```
$ node -c screen.js
screen.js:822  SyntaxError: Unexpected token '<'
```

The whole Daily frontend is broken — the browser refuses to load the script.

Two related issues caused this.

## Issue 1 — `dsOpenNode` at line 576 is malformed

It opens with `function dsOpenNode(nodeId) {` then has early-return guards, but never dispatches anywhere and never closes the brace before the next function `dsOpenTreasure` is declared at line 584.

The intent (per `plans/02-foresight-and-rest.md` and `plans/04-mystery-event-table.md`) is for `dsOpenNode` to dispatch on `node.type`:

```js
function dsOpenNode(nodeId) {
    if (!_dsData?.map) return;
    const panel = document.getElementById('ds-map-panel');
    const node = _dsData.map.nodes.find(n => n.id === nodeId);
    if (!panel || !node) return;
    if (node.type === 'treasure') return dsOpenTreasure(nodeId);
    if (node.type === 'rest')     return dsOpenRest(nodeId);
    if (node.type === 'mystery')  return dsOpenMystery(nodeId);
    // existing behavior for choice / boss / forced / elite / shop:
    // (preserve whatever logic was there before — find the original
    // dsOpenNode body in git history: `git show HEAD:screen.js | grep -n dsOpenNode`)
}
```

Restore the original `dsOpenNode` body for non-treasure/rest/mystery node types from git history (commit `99a4c21` on master, or any pre-agent state). Then prepend the three dispatch lines for the new node types. Close the function brace properly before `dsOpenTreasure` is declared.

## Issue 2 — syntax error at line 822

Likely the same kind of splice damage (unterminated template literal or stray characters). Inspect lines around 800–840 and repair whatever broke. The error message (`Unexpected token '<'`) usually means a backtick or `${...}` got mangled and the parser is now reading raw HTML.

`dsOpenTreasure` (around line 584), `dsOpenRest` (around line 685), and the rest of the new modal/handler functions appear to be intact based on initial inspection — preserve them. Do not rewrite them.

## Verification

- `node -c screen.js` exits 0 with no output.
- `grep -n '^function dsOpenNode' screen.js` shows exactly one definition.
- `grep -n 'window.dsOpenNode' screen.js` still shows the export.
- Open the page in `dev_server.js` and confirm clicking a treasure/rest/mystery/choice/boss node opens its respective panel — no console errors.

## Out of scope

Do not touch `routes.py`, `screen.html`, `plans/`, or any other file. Do not delete the scratch files at the repo root.
