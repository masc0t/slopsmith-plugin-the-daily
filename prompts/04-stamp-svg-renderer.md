# Prompt 04 — Programmatic SVG stamp renderer

## Goal

Add a JS function `dsRenderStamp(stampId, earnedDate, agg)` to `screen.js` that returns an SVG string for any stamp in the V1 catalog. Stamps compose from primitives (frame + glyph + threshold ribbon) — no per-stamp art assets.

V1 catalog is 14 stamps; the renderer must handle all 14. The passport screen (prompt 12) will call this for each earned-or-progress stamp.

## Read first

- `plans/03-tokens-shop-passport.md` (Stamp definitions section, post-amendment)
- `plans/adr/0002-solo-flex-completionist-shop.md`

## Files allowed to touch

- `screen.js` (add a new section, do not modify existing functions)

## Spec

V1 stamp catalog:

```
first_daily       — 🎸 + ribbon "1"          tier: bronze
first_boss        — 👑 + ribbon "1"          tier: bronze
first_full_clear  — ⭐ + ribbon "1"          tier: bronze
first_sign        — ✍ + ribbon "1"          tier: bronze
streak_3          — 🔥 + ribbon "3"          tier: bronze
streak_7          — 🔥 + ribbon "7"          tier: silver
streak_30         — 🔥 + ribbon "30"         tier: gold
lane_sprint_10    — 🏃 + ribbon "10"         tier: silver
lane_marathon_10  — 🐢 + ribbon "10"         tier: silver
lane_drop_10      — ⬇ + ribbon "10"          tier: silver
decade_1970s      — '70 + ribbon "10"        tier: silver
decade_1980s      — '80 + ribbon "10"        tier: silver
decade_1990s      — '90 + ribbon "10"        tier: silver
modifier_seen_all — ∞  + ribbon "all"        tier: gold
```

### Renderer

Add this to `screen.js`, near the end, before the `window.dsX = dsX` exports block:

```js
// ============================================================
// Stamp SVG renderer (programmatic, no per-stamp assets)
// See plans/adr/0002 and plans/03-tokens-shop-passport.md.
// ============================================================

const DS_STAMP_CATALOG = {
    first_daily:        { tier: 'bronze', glyph: '🎸',  ribbon: '1',   name: 'First Daily' },
    first_boss:         { tier: 'bronze', glyph: '👑',  ribbon: '1',   name: 'First Boss' },
    first_full_clear:   { tier: 'bronze', glyph: '⭐',  ribbon: '1',   name: 'First Full Clear' },
    first_sign:         { tier: 'bronze', glyph: '✍',   ribbon: '1',   name: 'First Sign' },
    streak_3:           { tier: 'bronze', glyph: '🔥',  ribbon: '3',   name: 'Streak 3' },
    streak_7:           { tier: 'silver', glyph: '🔥',  ribbon: '7',   name: 'Streak 7' },
    streak_30:          { tier: 'gold',   glyph: '🔥',  ribbon: '30',  name: 'Streak 30' },
    lane_sprint_10:     { tier: 'silver', glyph: '🏃',  ribbon: '10',  name: 'Sprint Master' },
    lane_marathon_10:   { tier: 'silver', glyph: '🐢',  ribbon: '10',  name: 'Marathon Master' },
    lane_drop_10:       { tier: 'silver', glyph: '⬇',   ribbon: '10',  name: 'Drop Master' },
    decade_1970s:       { tier: 'silver', glyph: "'70", ribbon: '10',  name: '1970s' },
    decade_1980s:       { tier: 'silver', glyph: "'80", ribbon: '10',  name: '1980s' },
    decade_1990s:       { tier: 'silver', glyph: "'90", ribbon: '10',  name: '1990s' },
    modifier_seen_all:  { tier: 'gold',   glyph: '∞',   ribbon: 'all', name: 'Modifier Sampler' },
};

const DS_STAMP_TIER_COLORS = {
    bronze: { frame: '#8a5a2a', fill: '#cd7f32', glow: 'rgba(205,127,50,0.4)' },
    silver: { frame: '#6a6a6a', fill: '#c0c0c0', glow: 'rgba(192,192,192,0.4)' },
    gold:   { frame: '#8a6a1a', fill: '#e8c040', glow: 'rgba(232,192,64,0.5)' },
};

function dsRenderStamp(stampId, earnedDate /* nullable */, locked /* bool */) {
    const def = DS_STAMP_CATALOG[stampId];
    if (!def) return '';
    const colors = DS_STAMP_TIER_COLORS[def.tier];
    const opacity = locked ? 0.25 : 1;
    return `<svg class="ds-stamp tier-${def.tier} ${locked ? 'locked' : 'earned'}" viewBox="0 0 64 64" width="64" height="64" style="opacity:${opacity}">
        <circle cx="32" cy="32" r="28" fill="${colors.fill}" stroke="${colors.frame}" stroke-width="3" />
        <text x="32" y="32" text-anchor="middle" dominant-baseline="central" font-size="22" fill="#1a1a1a">${def.glyph}</text>
        <rect x="8" y="46" width="48" height="14" fill="${colors.frame}" rx="3" />
        <text x="32" y="56" text-anchor="middle" font-size="10" fill="#fff" font-weight="bold">× ${def.ribbon}</text>
        <title>${def.name}${earnedDate ? ' — earned ' + earnedDate : ''}</title>
    </svg>`;
}

window.dsRenderStamp = dsRenderStamp;
window.DS_STAMP_CATALOG = DS_STAMP_CATALOG;
```

### Locked state

When `locked` is true, render the stamp at 25% opacity. The passport (prompt 12) will pass `locked = true` for stamps the user hasn't earned yet, so the catalog visibly previews unearned stamps.

## Verification

```bash
node -c screen.js
```

Plus a manual smoke test — paste this into a browser console after loading the Daily screen:

```js
document.body.insertAdjacentHTML('beforeend',
  Object.keys(DS_STAMP_CATALOG).map(id =>
    dsRenderStamp(id, '2026-04-20', false)
  ).join(''));
```

You should see all 14 stamps render in the page. Run again with `true` for the locked argument and confirm they fade.

## Out of scope

- Do not implement the passport screen — that is prompt 12.
- Do not edit `routes.py`, `screen.html`, or any CSS file.
- Do not invent new stamps beyond the 14 in the catalog.
- Do not modify any existing function in `screen.js` — only add the new section + the two `window.X = X` exports.
- Do not load any external SVG library; the spec is intentionally inline-SVG-only.
