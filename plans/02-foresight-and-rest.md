# Plan: Treasure as Foresight, Rest as Liner Notes & Bank

> **Status: amended by ADR-0003 (bank-as-partial-grant) and ADR-0002 amendment (peeks treasure-only).** Inline corrections below.

Today, treasure / rest / shop nodes are decorative. This plan gives them real reasons to be visited without ever modifying how songs play. The currency is **information** and **timing**, not buffs.

## Goal

- **Treasure** = peek at future / hidden information.
- **Rest** = either learn something about the song you just played, or bank current progress as tokens immediately.
- **Shop** = covered by `03-tokens-shop-passport.md`.
- Visiting these nodes feels like a real choice, but the song itself is never altered.

## Treasure: peek menu

Opening a treasure node presents 1-of-N peek options. The user picks one; the others lock for the day.

### Peek types (V1 set, post-grill)

| Peek               | Reveals                                                                   |
|--------------------|---------------------------------------------------------------------------|
| `tomorrow_modifier`| Tomorrow's modifier id + day name (no songs).                             |
| `tomorrow_lanes`   | Tomorrow's map shape (lane labels, no song titles).                       |
| `boss_song`        | Today's boss song revealed early (only relevant before boss is reached).  |

V2 catalog (deferred): `mystery_event` (lands once plan 04 V1 is stable), `next_two_days` (currently redundant with `tomorrow_modifier`), `pool_glimpse` (signal-poor at 5 of ~1000s).

V1 every treasure node shows all 3 peeks; user picks 1, others lock for that node. Treasure tiers deferred to V2.

**Peeks live exclusively at treasure nodes.** The shop sells no info consumables — see ADR-0002 amendment. Time-relative info doesn't bank meaningfully, and a paid surface duplicating the free one is confusing.

### Determinism

- Peek *availability* per treasure node is deterministic from `(date, node_id)` — same options for everyone.
- The user's pick is per-install. Peeked information is shown locally; we don't broadcast picks.
- For `tomorrow_*` peeks: tomorrow's setlist is generated lazily on demand. `_load_pool` and `_pick_modifier` already work for any date — call them with `today + 1` and cache in `pool_cache` like normal.

## Rest: two modes

Opening a rest node presents two tabs:

### Tab A — Liner Notes (free, repeatable)

V1 = pure local-data composition. **No prose, no external trivia, no LLM, no Wikipedia.** All fields fall out of existing tables:

- **Metadata header**: year, album, artist, key/tuning, BPM if known.
- **Daily history**: "Appeared on Day #N (date), Day #M (date)." Local query against `daily_setlists`.
- **Same-artist breadcrumb**: "Other songs by [artist] in your library: [list]." Local query against `meta_db.songs`.
- **Library age**: "In your library since [date]." Filesystem mtime.
- Album art (already cached).

Sentimental hit comes from "Day #N" + library age — personal history, not encyclopedia entry. V2 may layer opportunistic `trivia` field onto popular `songs_pool.json` entries.

**No backend state change.** Pure read.

### Tab B — Bank Progress (one-shot per rest node)

Convert current run progress into tokens *now* instead of waiting for boss completion. Tradeoff:

- Bank now → smaller token grant, locked in even if user doesn't finish the day.
- Wait for boss → larger token grant, but contingent on full clear.

Concrete numbers (tunable):

- Bank early: `2 * (cleared_count - already_banked_count)` tokens. Each bank only pays for clears since the prior bank — multi-rest paths can each bank without double-paying.
- Boss completion: `(3 * cleared_count + 5 + bonuses) - sum(banked_today)` tokens. Reconcile subtracts what was already banked.

Net total cap is unchanged across the day — banking only shifts timing. Risk/reward: bank now = certainty, wait = bigger but contingent on full clear. See ADR-0003 for full ledger semantics (multi-row days are expected; `rest_bank` rows + `day_complete` row).

Banking burns the rest node's "bank" charge but does *not* prevent finishing the day or signing the leaderboard.

## Data model

### `daily_setlists`

Add a `node_state TEXT` column (JSON). One row per day, per install_id, tracking peeks revealed and rest banks claimed:

Actually — keep it cleaner. New table:

```sql
CREATE TABLE IF NOT EXISTS daily_node_actions (
    install_id TEXT NOT NULL,
    date TEXT NOT NULL,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,        -- 'peek:tomorrow_modifier', 'rest:bank', etc.
    payload TEXT,                -- JSON: peek result, banked amount, ...
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (install_id, date, node_id, action)
);
```

This generalizes — plan 04 (mystery events) can use the same table.

### `daily_inventory`

Already exists. Banking adds tokens to the existing items JSON (or a new `tokens INTEGER` column — see plan 03).

### `pool_cache`

Already keyed by `fetched_date`. Foresight peeks for "tomorrow" trigger generation of tomorrow's setlist row in `daily_setlists` if not present. This is already idempotent because `/today` does the same generation.

## Backend

### `/api/plugins/the_daily/treasure/{node_id}`

`GET` — returns the 3 deterministic peek options for this treasure node + which one (if any) the user has already chosen.

`POST {peek_type}` — records the choice in `daily_node_actions`, returns the revealed payload. Rejects if the user already chose a different peek for this node.

### `/api/plugins/the_daily/rest/{node_id}`

`GET ?tab=liner` — returns liner notes for the next-unplayed song.

`POST {action: "bank"}` — banks current progress as tokens. Idempotent per node (PK on `daily_node_actions`).

### Generation helpers

- `_get_or_generate_setlist(conn, date_str)` — refactor of the existing `/today` logic so it can be called for any date from peek endpoints.
- `_song_liner_notes(song)` — pull from `songs_pool.json` entry. Add a `trivia` field to pool entries when available; default to a templated fallback otherwise.

## Frontend

### Treasure modal

```
┌─────────────────────────────────────┐
│  💎  Treasure                        │
├─────────────────────────────────────┤
│  Pick one to reveal:                │
│  [ Tomorrow's modifier ]            │
│  [ Boss song ]                      │
│  [ Mystery event hint ]             │
└─────────────────────────────────────┘
```

After pick, modal swaps to the result. A small "peeked" pill shows on the treasure node from then on.

### Rest modal

Two-tab modal:

- **Liner notes** — shows the card; "next song" or "last played" toggle.
- **Bank progress** — shows current cleared count, the two grant numbers, and a confirm button. Disabled if already banked.

### Persistent peek display

Peeks live in a small "Foresight" strip on the setlist screen, below the map:

> 🔮 You know: tomorrow is **Decade Day (1980s)** · Today's boss is "Free Bird"

Clears at midnight (next day's `/today` resets the strip).

## Rollout

1. Schema: add `daily_node_actions` table. Ship invisible.
2. Backend: refactor `_get_or_generate_setlist`. Implement treasure + rest endpoints. Test with curl/preview.
3. Frontend: treasure & rest modals. Peek strip.
4. Pool enrichment: add `trivia` field to pool entries opportunistically (build_pool.py change). Existing entries fall back to template.

## Open questions

- **How many peeks per day?** A typical map has 1-2 treasure nodes and 1-2 rest nodes. That's ~2-3 peeks max per day. Feels right — peeks should be precious.
- **Peek of tomorrow's *songs*?** Reject. That removes the surprise. Hint at modifier/lane/boss only.
- **Liner notes data source**: **Resolved — local-data composition only V1.** No external API, no prose, no LLM. See Tab A above.
- **Sharing peeks**: cute idea — "your friend on the leaderboard peeked the boss." Skip for V1, revisit when we add social.
- **Forfeit on bank**: **Resolved — no.** See ADR-0003.
