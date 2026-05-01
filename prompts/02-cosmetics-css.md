# Prompt 02 — Cosmetics CSS file + .daily-root scope

## Goal

Create `static/cosmetics.css` containing CSS classes for V1 cosmetic items (1 flair pack + 1 map theme + 1 lane skin + the calendar art slot). All cosmetic styles must be scoped under `.daily-root` so they cannot leak into other Slopsmith plugins.

Per ADR-0002 the rollout is solo-flex completionist. V1 ships a small starting catalog; this prompt only writes the CSS. The catalog dict on the backend (prompt 07) and the equip pipeline (prompt 11) come later.

## Read first

- `plans/adr/0002-solo-flex-completionist-shop.md`
- `plans/03-tokens-shop-passport.md` (Frontend → Cosmetic application section)

## Files allowed to touch

- `static/cosmetics.css` (new file)
- `screen.html` (one line: add `<link rel="stylesheet" href="static/cosmetics.css">` near the existing CSS includes; if the plugin loads CSS via a different mechanism, follow the existing pattern)

## Spec

All rules scoped under `.daily-root`. The body of the Daily plugin's UI is wrapped in `<div class="daily-root">` — equip slots add additional classes to that root: `<div class="daily-root theme-papercraft skin-neonsprint flair-glow">`.

Ship V1 cosmetics:

### Flair pack — `flair-glow`

Adds a subtle glow to the user's leaderboard row.

```css
.daily-root.flair-glow .daily-leaderboard-row.is-self {
    box-shadow: 0 0 8px rgba(232, 192, 64, 0.4);
}
```

### Map theme — `theme-papercraft`

Repaints the map SVG with a warm paper texture and brown ink.

```css
.daily-root.theme-papercraft .daily-map-svg {
    background-color: #f5e6c8;
    filter: sepia(0.2);
}
.daily-root.theme-papercraft .daily-map-svg .map-node {
    stroke: #5a3a1a;
}
.daily-root.theme-papercraft .daily-map-svg .map-edge {
    stroke: #8a6a4a;
    stroke-dasharray: 4 2;
}
```

### Lane skin — `skin-neonsprint`

Recolors the sprint lane to neon magenta, leaves other lanes untouched.

```css
.daily-root.skin-neonsprint {
    --lane-sprint: #ff00aa;
}
```

### Calendar art — generic per-month classes

The passport cell uses month-specific background images. V1 ships placeholder backgrounds; real art lands as separate files later.

```css
.daily-root .passport-cell.month-1  { background-color: #1a2a3a; }
.daily-root .passport-cell.month-2  { background-color: #2a1a3a; }
/* ... through month-12 ... */
.daily-root.calendar-art-pastel .passport-cell { background-blend-mode: multiply; }
```

Stub the 12 month colors and one calendar-art class (`calendar-art-pastel`) as a placeholder.

## Verification

```bash
# CSS file exists and parses (rough check — no broken braces)
node -e "const s = require('fs').readFileSync('static/cosmetics.css','utf8'); const open = (s.match(/{/g)||[]).length; const close = (s.match(/}/g)||[]).length; if (open !== close) throw new Error('brace mismatch '+open+' vs '+close); console.log('OK', open, 'rules');"

# screen.html includes the new file (only if you added the link tag)
grep cosmetics.css screen.html
```

## Out of scope

- Do not edit `routes.py`, `screen.js`, `static/app.js`, or any other JS.
- Do not implement equipped-slot toggling — that is prompt 11.
- Do not add `.daily-root` to existing markup; the equip wiring (prompt 11) handles that.
- Do not write JS to load this CSS; use existing `<link>` patterns in screen.html only.
- Do not invent new cosmetic categories. Stick to the four in the spec.
