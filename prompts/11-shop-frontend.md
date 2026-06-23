# Prompt 11 — Shop frontend (screen + map node modal + token counter)

## Goal

Frontend surfaces for the shop:

1. A nav button on the setlist screen that opens the full shop screen.
2. A shop view (`#ds-shop`) with item cards, categories, and Buy buttons.
3. A map shop node modal — opens the deterministic 3-item discount offer per ADR-0002.
4. A token counter chip in the Daily nav header that animates `+N` on grants.
5. Equip pickers for the four cosmetic slots — sets `<div class="daily-root">` classes per ADR-0002 amendment.
6. 60s refund button on cosmetics within window.

## Read first

- `plans/adr/0002-solo-flex-completionist-shop.md` (including peek-surface amendment)
- `plans/03-tokens-shop-passport.md` (Frontend section)

## Pre-reqs

- Prompt 02 (cosmetics.css) merged.
- Prompt 07 (shop endpoints) merged.

## Files allowed to touch

- `screen.js`
- `screen.html`

## Spec

### 1. Wrap Daily UI in `.daily-root`

Find the Daily screen container in `screen.html` (likely `<div id="screen-plugin-the_daily">` or similar). Wrap its inner contents in `<div class="daily-root">` so the equip classes apply. If the existing structure already has a class on the root, add `daily-root` alongside.

### 2. Token counter chip

Top of the Daily nav (or wherever the "Daily" header lives):

```html
<span id="ds-token-counter" class="ml-2 px-2 py-1 rounded-full bg-dark-700 text-yellow-400 text-sm font-mono">
  🪙 <span class="value">0</span>
</span>
```

```js
async function dsRefreshTokens() {
    const r = await fetch(dsApiUrl('/api/plugins/the_daily/inventory'),
                          { headers: { 'X-Install-Id': dsInstallId() } });
    const data = await r.json();
    const el = document.querySelector('#ds-token-counter .value');
    const old = parseInt(el.textContent, 10) || 0;
    const next = data.tokens || 0;
    el.textContent = next;
    if (next > old) dsAnimateTokenDelta(next - old);
    dsApplyEquipped(data.equipped || {});
}

function dsAnimateTokenDelta(delta) {
    const chip = document.getElementById('ds-token-counter');
    const float = document.createElement('div');
    float.className = 'absolute -top-4 right-0 text-yellow-400 text-xs animate-bounce';
    float.textContent = `+${delta}`;
    chip.style.position = 'relative';
    chip.appendChild(float);
    setTimeout(() => float.remove(), 1500);
}
```

Call `dsRefreshTokens()` after each Daily screen show, after each shop purchase, and after each `/mark` reconcile.

### 3. Shop screen

Add a new view to `screen.html`:

```html
<div id="ds-shop" class="hidden">
  <div class="flex items-center mb-4">
    <button onclick="dsShowSetlist()" class="text-sm text-gray-400 hover:text-white">← Back</button>
    <h2 class="ml-4 text-xl font-semibold text-white">Shop</h2>
    <span class="ml-auto text-yellow-400 font-mono">🪙 <span id="ds-shop-tokens">0</span></span>
  </div>
  <div class="flex gap-2 mb-4">
    <button class="ds-shop-tab" data-tab="all"        onclick="dsShopFilter('all')">All</button>
    <button class="ds-shop-tab" data-tab="cosmetic"   onclick="dsShopFilter('cosmetic')">Cosmetics</button>
    <button class="ds-shop-tab" data-tab="consumable" onclick="dsShopFilter('consumable')">Re-rolls</button>
  </div>
  <div id="ds-shop-items" class="grid grid-cols-2 gap-3"></div>
</div>
```

Item card template (rendered in JS):

```js
function dsRenderShopItem(item) {
    const cost = item.discounted_cost ?? item.cost;
    const discount = item.discounted_cost ? `<span class="line-through text-gray-500 mr-1">${item.cost}</span>` : '';
    const buttonState = item.owned ? 'Owned' : (item.affordable ? 'Buy' : 'Not enough');
    const disabled = item.owned || !item.affordable;
    return `<div class="bg-dark-700 border border-gray-700 rounded-2xl p-3 flex flex-col">
      <div class="text-sm font-semibold text-white">${esc(item.name)}</div>
      <div class="text-xs text-gray-500 mb-2">${esc(item.description || item.type)}</div>
      <div class="mt-auto flex items-center justify-between">
        <span class="text-yellow-400 text-sm">🪙 ${discount}${cost}</span>
        <button onclick="dsBuyItem('${esc(item.id)}')" ${disabled ? 'disabled' : ''}
                class="px-3 py-1 rounded-xl bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs">
          ${buttonState}
        </button>
      </div>
    </div>`;
}

async function dsLoadShop(nodeId /* optional */) {
    const url = nodeId
        ? `/api/plugins/the_daily/shop?node_id=${encodeURIComponent(nodeId)}`
        : `/api/plugins/the_daily/shop`;
    const r = await fetch(dsApiUrl(url), { headers: { 'X-Install-Id': dsInstallId() } });
    const data = await r.json();
    document.getElementById('ds-shop-tokens').textContent = data.tokens;
    const filter = window._dsShopFilter || 'all';
    const filtered = data.items.filter(i =>
        filter === 'all' ||
        (filter === 'cosmetic' && i.is_cosmetic) ||
        (filter === 'consumable' && !i.is_cosmetic)
    );
    document.getElementById('ds-shop-items').innerHTML = filtered.map(dsRenderShopItem).join('');
}

async function dsBuyItem(itemId, nodeId /* optional */) {
    const r = await fetch(dsApiUrl('/api/plugins/the_daily/shop/buy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
        body: JSON.stringify({ item_id: itemId, node_id: nodeId }),
    });
    const data = await r.json();
    if (data.error) { alert(data.error); return; }
    dsRefreshTokens();
    dsLoadShop(nodeId);
    if (data.effect?.rerolled) {
        // refresh setlist if this was a re-roll
        dsLoadToday();
    }
}

window._dsShopFilter = 'all';
function dsShopFilter(filter) {
    window._dsShopFilter = filter;
    dsLoadShop();
}
```

### 4. Map shop node modal

When the user clicks a shop node on the map, open a small modal showing the 3 discounted items. Reuse the same `dsLoadShop(nodeId)` and item-card renderer, just constrained to the discount subset:

```js
async function dsOpenShopNode(nodeId) {
    const panel = document.getElementById('ds-map-panel');
    if (!panel) return;
    const r = await fetch(dsApiUrl(`/api/plugins/the_daily/shop?node_id=${encodeURIComponent(nodeId)}`),
                          { headers: { 'X-Install-Id': dsInstallId() } });
    const data = await r.json();
    const offerSet = new Set(data.discount?.items || []);
    const offerItems = data.items.filter(i => offerSet.has(i.id));
    panel.innerHTML = `<div class="bg-dark-700/50 border border-yellow-700/40 rounded-2xl p-4">
      <div class="flex items-center gap-2 mb-3">
        <span class="text-xl">🛒</span>
        <span class="text-sm font-semibold text-white">Shop · 10% off (today)</span>
      </div>
      <div class="grid grid-cols-1 gap-2">
        ${offerItems.map(i => dsRenderShopItem({...i, _node_id: nodeId})).join('')}
      </div>
    </div>`;
}
```

Wire `dsOpenShopNode(nodeId)` into the existing `dsOpenNode` dispatcher (currently dispatches treasure / rest / mystery — add shop):

```js
if (node.type === 'shop') return dsOpenShopNode(nodeId);
```

### 5. Equip pickers

In settings or in the shop "owned" row for each cosmetic, add an Equip/Unequip toggle:

```js
async function dsEquip(slot, cosmeticId) {
    await fetch(dsApiUrl('/api/plugins/the_daily/equip'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Install-Id': dsInstallId() },
        body: JSON.stringify({ slot, cosmetic_id: cosmeticId }),
    });
    dsRefreshTokens();  // also refreshes equipped via dsApplyEquipped
}

function dsApplyEquipped(equipped) {
    const root = document.querySelector('.daily-root');
    if (!root) return;
    // Remove all theme-* / skin-* / flair-* / calendar-art-* classes
    [...root.classList].forEach(c => {
        if (/^(theme|skin|flair|calendar-art)-/.test(c)) root.classList.remove(c);
    });
    Object.values(equipped).forEach(id => {
        if (id) root.classList.add(id.replace(/_/g, '-').replace(/^([a-z]+)-/, '$1-'));
        // simple mapping: flair_glow -> flair-glow, theme_papercraft -> theme-papercraft
    });
}
```

The class-name mapping: cosmetic ids are `flair_glow`, `theme_papercraft`, `skin_neonsprint`, `calendar_pastel`. Map these to CSS classes `flair-glow`, `theme-papercraft`, `skin-neonsprint`, `calendar-art-pastel` (note `calendar_pastel` → `calendar-art-pastel` due to the prefix in cosmetics.css). Pick one consistent convention and document it.

### 6. Refund button

Within 60s of cosmetic purchase, show a small "Refund" link on the cosmetic card:

```js
function dsCanRefund(item) {
    if (!item.purchased_at) return false;
    return (Date.now() / 1000) - item.purchased_at < 60;
}

// In dsRenderShopItem, append "Refund" link if dsCanRefund(item)
```

The shop GET endpoint must include `purchased_at` per cosmetic for this to work. If it doesn't, file a follow-up against prompt 07 — don't paper over.

### 7. Globals

```js
window.dsRefreshTokens = dsRefreshTokens;
window.dsLoadShop = dsLoadShop;
window.dsBuyItem = dsBuyItem;
window.dsShopFilter = dsShopFilter;
window.dsOpenShopNode = dsOpenShopNode;
window.dsEquip = dsEquip;
window.dsApplyEquipped = dsApplyEquipped;
```

## Verification

```bash
node -c screen.js

# Manual:
# 1. Earn some tokens (complete a daily). Token counter animates +N.
# 2. Click "Shop" nav button. Shop screen renders with items.
# 3. Buy a cosmetic. Counter decrements; item shows "Owned."
# 4. Click a shop node on a map. Modal shows 3 items at 10% off.
# 5. Equip the cosmetic. Verify the .daily-root has the matching class
#    (DevTools > Elements). The cosmetic CSS rule applies.
# 6. Within 60s of a purchase, refund link appears. Click — tokens refunded.
```

## Out of scope

- Do not add peek consumables to the shop. ADR-0002 amendment.
- Do not invent shop rotation. Static catalog.
- Do not implement passport — prompt 12.
- Do not modify the existing `dsShopFilter` function unless extending it (it already exists).
- Do not invent new equip slots. Stick to flair / map_theme / lane_skin / calendar_art.
