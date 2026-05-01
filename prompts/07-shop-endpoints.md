# Prompt 07 — Shop endpoints + catalog + map node discount

## Goal

Wire the shop backend per ADR-0002 (solo-flex completionist) and ADR-0002 amendment (peeks live exclusively at treasure nodes — no info consumables in the shop catalog).

## Read first

- `plans/adr/0002-solo-flex-completionist-shop.md` (including the peek-surface amendment)
- `plans/adr/0003-bank-as-partial-grant.md` (for token grant model)
- `plans/03-tokens-shop-passport.md` (Spending section, post-amendment)

## Files allowed to touch

- `routes.py`

## Spec

### 1. Static catalog dict

Near the existing `MODIFIERS` dict:

```python
COSMETICS = {
    "flair_glow":       {"type": "flair",         "cost": 15, "name": "Glow Flair"},
    "theme_papercraft": {"type": "map_theme",     "cost": 25, "name": "Papercraft"},
    "skin_neonsprint":  {"type": "lane_skin",     "cost": 20, "name": "Neon Sprint", "lane": "sprint"},
    "calendar_pastel":  {"type": "calendar_art",  "cost": 10, "name": "Pastel Calendar"},
}

CONSUMABLES = {
    "boss_reroll":  {"cost": 8,  "name": "Boss Re-roll",  "description": "Re-roll today's boss song.",                  "fn": "_consume_boss_reroll"},
    "lane_reroll":  {"cost": 12, "name": "Lane Re-roll",  "description": "Re-roll non-boss songs on a single lane.",     "fn": "_consume_lane_reroll"},
}
# NB: per ADR-0002 amendment, NO peek consumables here. Peeks live at treasure nodes.
```

### 2. Endpoints

```python
@app.get("/api/plugins/the_daily/shop")
def get_shop(request: Request, node_id: str | None = None):
    install_id = _get_install_id_from_request(request)
    inv = _conn.execute(
        "SELECT tokens, cosmetics FROM daily_inventory WHERE install_id = ?",
        (install_id,)
    ).fetchone()
    tokens = inv[0] if inv else 0
    owned = set(json.loads(inv[1])) if inv and inv[1] else set()

    items = []
    for cid, c in COSMETICS.items():
        items.append({
            "id": cid, "name": c["name"], "type": c["type"], "cost": c["cost"],
            "is_cosmetic": True,
            "owned": cid in owned,
            "affordable": tokens >= c["cost"],
        })
    for cid, c in CONSUMABLES.items():
        items.append({
            "id": cid, "name": c["name"], "type": "consumable",
            "description": c["description"], "cost": c["cost"],
            "is_cosmetic": False,
            "owned": False,
            "affordable": tokens >= c["cost"],
        })

    discount = None
    if node_id:
        # Map shop node — deterministic 3-item subset @ 10% off
        offer = _shop_offer_for_node(date.today().isoformat(), node_id)
        for it in items:
            if it["id"] in offer:
                it["discounted_cost"] = round(it["cost"] * 0.9)
                it["affordable"] = tokens >= it["discounted_cost"]
        discount = {"node_id": node_id, "items": list(offer), "rate": 0.1}

    return {"tokens": tokens, "items": items, "discount": discount}


def _shop_offer_for_node(date_str: str, node_id: str) -> set[str]:
    rng = random.Random(f"shop:{date_str}:{node_id}")
    catalog_ids = list(COSMETICS.keys()) + list(CONSUMABLES.keys())
    return set(rng.sample(catalog_ids, min(3, len(catalog_ids))))


@app.post("/api/plugins/the_daily/shop/buy")
async def buy_item(request: Request):
    body = await request.json()
    item_id = body.get("item_id")
    node_id = body.get("node_id")  # optional — set when bought from map shop node
    install_id = _get_install_id_from_request(request)

    cosmetic = COSMETICS.get(item_id)
    consumable = CONSUMABLES.get(item_id)
    if not cosmetic and not consumable:
        return {"error": "Unknown item"}

    base_cost = (cosmetic or consumable)["cost"]
    cost = base_cost
    if node_id:
        offer = _shop_offer_for_node(date.today().isoformat(), node_id)
        if item_id in offer:
            cost = round(base_cost * 0.9)

    with _write_lock:
        inv = _conn.execute(
            "SELECT tokens, cosmetics FROM daily_inventory WHERE install_id = ?",
            (install_id,)
        ).fetchone()
        tokens = inv[0] if inv else 0
        owned = set(json.loads(inv[1])) if inv and inv[1] else set()

        if cosmetic and item_id in owned:
            return {"error": "Already owned"}
        if tokens < cost:
            return {"error": "Insufficient tokens"}

        new_tokens = tokens - cost
        if cosmetic:
            owned.add(item_id)
            cosmetics_blob = json.dumps(sorted(owned))
            _conn.execute("""
                INSERT INTO daily_inventory (install_id, tokens, cosmetics) VALUES (?, ?, ?)
                ON CONFLICT(install_id) DO UPDATE SET tokens = ?, cosmetics = ?
            """, (install_id, new_tokens, cosmetics_blob, new_tokens, cosmetics_blob))
            # Track purchased_at for refund window — store as JSON sidecar
            # (See refund endpoint below for the 60s rule.)
            _record_purchase_time(install_id, item_id)
            result = {"item_id": item_id, "new_balance": new_tokens, "owned": True}
        else:  # consumable — execute on buy
            _conn.execute(
                "UPDATE daily_inventory SET tokens = ? WHERE install_id = ?",
                (new_tokens, install_id)
            )
            effect = _execute_consumable(item_id, install_id)
            result = {"item_id": item_id, "new_balance": new_tokens, "effect": effect}

        _conn.execute(
            "INSERT INTO daily_token_ledger (install_id, date, delta, reason) VALUES (?, ?, ?, ?)",
            (install_id, date.today().isoformat(), -cost, f"shop:{item_id}")
        )
        _conn.commit()

    # Trigger Supabase mirror push (prompt 06)
    if "_mirror_push_debounced" in globals():
        _mirror_push_debounced(install_id)

    return result


def _record_purchase_time(install_id: str, item_id: str):
    """Append {item_id, purchased_at} to daily_inventory.purchased_at JSON column,
    or use a separate table — match existing routes.py conventions."""
    # Implementation: extend cosmetics JSON to {id, purchased_at} entries,
    # OR add a new daily_purchases table. Pick whichever pattern matches existing code.
    pass

def _execute_consumable(item_id: str, install_id: str) -> dict:
    """Run the consumable's effect immediately. Returns the result payload to the frontend."""
    if item_id == "boss_reroll":
        return _consume_boss_reroll(install_id)
    if item_id == "lane_reroll":
        return _consume_lane_reroll(install_id)
    return {}

def _consume_boss_reroll(install_id: str) -> dict:
    """Re-roll today's boss song. Stub — flesh out by reusing existing setlist generation
    logic with a new RNG seed offset."""
    # TODO: integrate with _select_songs / _get_or_generate_setlist
    return {"rerolled": True}

def _consume_lane_reroll(install_id: str) -> dict:
    """Re-roll non-boss songs on a single lane. Same TODO as boss_reroll."""
    return {"rerolled": True}


@app.post("/api/plugins/the_daily/shop/refund")
async def refund_item(request: Request):
    body = await request.json()
    item_id = body.get("item_id")
    install_id = _get_install_id_from_request(request)
    cosmetic = COSMETICS.get(item_id)
    if not cosmetic:
        return {"error": "Refunds only apply to cosmetics"}
    purchased_at = _get_purchase_time(install_id, item_id)
    if not purchased_at:
        return {"error": "Item not owned"}
    seconds_since = (datetime.utcnow() - purchased_at).total_seconds()
    if seconds_since > 60:
        return {"error": "Refund window expired"}
    with _write_lock:
        # Reverse the purchase: refund tokens, drop cosmetic ownership, ledger entry.
        # ... implement using same pattern as buy_item.
        pass
    return {"refunded": True}


@app.post("/api/plugins/the_daily/equip")
async def equip_cosmetic(request: Request):
    body = await request.json()
    slot = body.get("slot")  # "flair", "map_theme", "lane_skin", "calendar_art"
    cosmetic_id = body.get("cosmetic_id")  # null = unequip
    install_id = _get_install_id_from_request(request)
    if cosmetic_id is not None:
        c = COSMETICS.get(cosmetic_id)
        if not c or c["type"] != slot:
            return {"error": "Cosmetic does not match slot"}
    with _write_lock:
        row = _conn.execute(
            "SELECT cosmetics, equipped FROM daily_inventory WHERE install_id = ?",
            (install_id,)
        ).fetchone()
        owned = set(json.loads(row[0])) if row and row[0] else set()
        if cosmetic_id is not None and cosmetic_id not in owned:
            return {"error": "Not owned"}
        equipped = json.loads(row[1]) if row and row[1] else {}
        if cosmetic_id is None:
            equipped.pop(slot, None)
        else:
            equipped[slot] = cosmetic_id
        _conn.execute(
            "UPDATE daily_inventory SET equipped = ? WHERE install_id = ?",
            (json.dumps(equipped), install_id)
        )
        _conn.commit()
    if "_mirror_push_debounced" in globals():
        _mirror_push_debounced(install_id)
    return {"equipped": equipped}
```

### 3. Inventory endpoint

If `/api/plugins/the_daily/inventory` doesn't already return `{tokens, cosmetics, equipped, stamps}`, extend it. This is the read endpoint for the frontend's token counter and equip pickers.

## Verification

```bash
python -c "import ast; ast.parse(open('routes.py', encoding='utf-8').read())"
pytest tests/ -v

# Manual:
curl http://localhost:PORT/api/plugins/the_daily/shop -H "X-Install-Id: t"
curl -X POST http://localhost:PORT/api/plugins/the_daily/shop/buy -H "X-Install-Id: t" \
  -H "Content-Type: application/json" -d '{"item_id":"flair_glow"}'
```

## Out of scope

- Frontend shop UI is prompt 11.
- Do not add peek consumables to the shop. ADR-0002 amendment is explicit.
- Do not invent shop rotation. Static catalog only.
- Do not implement re-roll mechanics in detail — leave `_consume_boss_reroll` / `_consume_lane_reroll` as stubs that return `{"rerolled": True}`. Real re-roll integration is a follow-up PR.
- Do not catch-up grant tokens. ADR-0001 / Q11 says no.
