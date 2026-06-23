# Prompt 12 — Passport frontend (grid + stamp shelf + lifetime totals)

## Goal

Frontend for the passport: a calendar-grid of the user's full Daily history, a stamp shelf below showing earned + locked-with-progress stamps, and a top strip of lifetime totals.

## Read first

- `plans/03-tokens-shop-passport.md` (Passport section, post-amendment)
- `plans/adr/0001-recovery-code-identity-and-local-primary-mirror.md` (passport reach decisions)
- `plans/adr/0004-lane-streak-semantics.md` (lane glyph for mixed/NULL rows)
- The output shape of `/api/plugins/the_daily/passport` from prompt 08

## Pre-reqs

- Prompt 04 (stamp SVG renderer) merged — provides `dsRenderStamp(stampId, earnedDate, locked)`.
- Prompt 08 (passport endpoint) merged — provides `/passport` returning days + stamps_earned + stamps_progress + totals.

## Files allowed to touch

- `screen.js`
- `screen.html`

## Spec

### 1. View skeleton in screen.html

```html
<div id="ds-passport" class="hidden">
  <div class="flex items-center mb-4">
    <button onclick="dsShowSetlist()" class="text-sm text-gray-400 hover:text-white">← Back</button>
    <h2 class="ml-4 text-xl font-semibold text-white">Passport</h2>
  </div>

  <div id="ds-passport-totals" class="grid grid-cols-4 gap-3 mb-6">
    <!-- filled by JS: total dailies, longest streak, current streak, lifetime tokens -->
  </div>

  <div id="ds-passport-grid" class="space-y-4 mb-8">
    <!-- months stacked, each month is a row of day-cells -->
  </div>

  <h3 class="text-sm uppercase text-gray-500 mb-2">Stamps</h3>
  <div id="ds-passport-stamps" class="flex flex-wrap gap-3">
    <!-- earned stamps then locked-with-progress -->
  </div>
</div>
```

Add a Passport nav button to the Daily nav (next to the Shop button).

### 2. Loader

```js
async function dsLoadPassport() {
    const r = await fetch(dsApiUrl('/api/plugins/the_daily/passport'),
                          { headers: { 'X-Install-Id': dsInstallId() } });
    const data = await r.json();
    dsRenderPassportTotals(data.totals);
    dsRenderPassportGrid(data.days);
    dsRenderPassportStamps(data.stamps_earned, data.stamps_progress);
}

function dsShowPassport() {
    document.getElementById('ds-passport').classList.remove('hidden');
    document.getElementById('ds-setlist').classList.add('hidden');
    // ... hide other views
    dsLoadPassport();
}
```

### 3. Totals strip

```js
function dsRenderPassportTotals(totals) {
    const t = document.getElementById('ds-passport-totals');
    t.innerHTML = `
      <div class="bg-dark-700 rounded-2xl p-3 text-center">
        <div class="text-2xl font-bold text-white">${totals.total_dailies}</div>
        <div class="text-xs text-gray-500">Dailies played</div>
      </div>
      <div class="bg-dark-700 rounded-2xl p-3 text-center">
        <div class="text-2xl font-bold text-white">${totals.longest_streak}</div>
        <div class="text-xs text-gray-500">Longest streak</div>
      </div>
      <div class="bg-dark-700 rounded-2xl p-3 text-center">
        <div class="text-2xl font-bold text-white">${totals.current_streak}</div>
        <div class="text-xs text-gray-500">Current streak</div>
      </div>
      <div class="bg-dark-700 rounded-2xl p-3 text-center">
        <div class="text-2xl font-bold text-yellow-400">🪙 ${totals.lifetime_tokens_earned}</div>
        <div class="text-xs text-gray-500">Lifetime tokens</div>
      </div>`;
}
```

### 4. Calendar grid

Group days by `YYYY-MM`, render each month as a row of day-cells. Each cell:

- Background: month-N color from cosmetics.css if `calendar_pastel` is equipped, else default dark.
- Center glyph: lane glyph (sprint, marathon, drop, decade, mixed, blank for legacy).
- Top-right: ✓ if boss_done, ⭐ overlay if full_clear.
- Hover/click: show day_name, modifier, lane, streak_at, songs played (fetch on demand if needed).

```js
const LANE_GLYPHS = {
    sprint: '🏃', marathon: '🐢', drop: '⬇', flat: '➡',
    standard: '🎸', mixed: '🔀',
};

function dsLaneGlyph(lane) {
    if (!lane) return '·';
    if (lane.startsWith('decade_')) return lane.replace('decade_', "'").replace(/s$/, '');
    return LANE_GLYPHS[lane] || '?';
}

function dsRenderPassportGrid(days) {
    const grid = document.getElementById('ds-passport-grid');
    if (!days.length) { grid.innerHTML = '<div class="text-gray-500 text-sm">No dailies yet — come back tomorrow!</div>'; return; }
    const byMonth = {};
    days.forEach(d => {
        const ym = d.date.slice(0, 7);
        (byMonth[ym] = byMonth[ym] || []).push(d);
    });
    const months = Object.keys(byMonth).sort();
    grid.innerHTML = months.map(ym => {
        const [y, m] = ym.split('-').map(Number);
        return `<div>
          <div class="text-xs uppercase text-gray-500 mb-1">${ym}</div>
          <div class="grid grid-cols-7 gap-1">
            ${byMonth[ym].map(d => `
              <div class="passport-cell month-${m} aspect-square rounded-lg flex flex-col items-center justify-center cursor-pointer hover:ring-2 hover:ring-accent"
                   title="${esc(d.day_name || '')} · ${esc(d.modifier || '')} · streak ${d.streak_at}"
                   onclick="dsShowPassportDayDetail('${esc(d.date)}')">
                <div class="text-lg">${dsLaneGlyph(d.lane)}</div>
                <div class="text-xs text-gray-400">${d.date.slice(8)}${d.boss_done ? ' ✓' : ''}</div>
              </div>
            `).join('')}
          </div>
        </div>`;
    }).join('');
}

function dsShowPassportDayDetail(date) {
    // Stretch goal: open a modal with the day's full setlist + lane + completion status.
    // Minimal V1: alert with the title attribute info, or redirect to existing day-history view if one exists.
}
```

### 5. Stamp shelf

```js
function dsRenderPassportStamps(earned, progress) {
    const shelf = document.getElementById('ds-passport-stamps');
    const earnedHtml = earned.map(s => dsRenderStamp(s.id, s.earned_date, false)).join('');
    const lockedHtml = progress.map(p => `
      <div class="relative">
        ${dsRenderStamp(p.id, null, true)}
        <div class="absolute -bottom-1 left-0 right-0 text-center text-xs text-gray-500">
          ${p.current} / ${p.target}
        </div>
      </div>`).join('');
    shelf.innerHTML = earnedHtml + lockedHtml;
}
```

### 6. Globals

```js
window.dsShowPassport = dsShowPassport;
window.dsLoadPassport = dsLoadPassport;
window.dsShowPassportDayDetail = dsShowPassportDayDetail;
```

Add `<button onclick="dsShowPassport()">Passport</button>` next to the existing Shop button on the setlist screen.

## Verification

```bash
node -c screen.js

# Manual:
# 1. Click Passport. Grid renders with one cell per past completion.
# 2. Cells show lane glyph (or · for legacy NULL rows).
# 3. Cells with boss_done show a ✓.
# 4. Stamp shelf shows earned stamps at full opacity, locked stamps at 25%
#    with a "current / target" caption underneath.
# 5. Equip the calendar_pastel cosmetic via the shop. Cells get pastel
#    backgrounds (the month-N CSS classes apply via .calendar-art-pastel).
# 6. Click a cell — opens detail modal (or stretch goal: just shows tooltip).
```

## Out of scope

- Do not implement passport export (PNG/SVG share card). Plan 03 lists it as out-of-V1.
- Do not retroactively backfill `committed_lane`. Pre-feature rows show `·` and that is correct.
- Do not invent new stamps. Use whatever the `/passport` endpoint returns plus the catalog from prompt 04.
- Do not implement multi-month calendar art transitions. V1 ships static per-month colors only.
- Do not poll. Refresh on view-show, on shop-buy, and on `/mark` reconcile only.
