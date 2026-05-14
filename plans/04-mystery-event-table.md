# Plan: Mystery Event Table

> **Status: post-grill amendments inline.** Open questions resolved below — see "Open questions" section. No new ADRs (all decisions tactical and reversible).

Today, a `?` (mystery) node just hashes to a random song from `cf_pool` and plays it like any other. This plan turns it into a small grab-bag of one-off mini-experiences. Crucially: **no event modifies how the song plays**. Events live in the *frame around* playback (before, after, or alongside), never inside it.

## Goal

- Picking a mystery node feels like opening a small package.
- Events are deterministic per `(date, node_id)` so everyone sees the same event today.
- Events do not require new song-side mechanics; they wrap presentation, prompts, and result tracking.

## Initial event catalog

| Event id           | What happens                                                                              |
|--------------------|-------------------------------------------------------------------------------------------|
| `guess_year`       | Before play, user enters a year. After play, see how close they were.                     |
| `blind_pick`       | Title and artist hidden until first chord (or 5s) after the song starts.                  |
| `cover_battle`     | Three different covers/recordings of the same song; user picks one to play.               |
| `replay`           | A song from a past Daily (deterministic by `(date, node_id)`). Sentimental callback.      |
| `setlist_sibling`  | The song the original artist usually plays *next* in their live setlists.                 |
| `genre_swap`       | A song that's the *opposite genre* of the day's overall vibe (e.g. ballad on a sprint day)|
| `obscure_b_side`   | Pulls specifically from least-played songs in the pool.                                   |
| `time_capsule`     | Reveals what year you would have first heard this song (year + 12 → "you were N years old"|
| `chain_link`       | Song shares a band member with one already on today's path (cross-pollination).           |
| `decade_jump`      | Song from a decade that hasn't appeared on today's path.                                  |

Start with 3 events for V1: `guess_year`, `blind_pick`, `replay`. They prove the pattern:

- `guess_year` proves "input before play, result after play."
- `blind_pick` proves "modify what's *shown* without modifying the song."
- `replay` proves "deterministic selection from history."

The rest are V2+, layered on once the pattern holds.

## Determinism

For each mystery node:

1. Hash `(date, node_id)` to pick an event id from the catalog with weights.
2. Hash again with `:song` to pick the specific song from the relevant candidate set.
3. Persist both in `daily_setlists.songs[i]` so reload is stable and `preview.py` can show them.

Events are *not* per-install. Everyone gets the same event at the same node. The user's *response* (guessed year, blind-pick choice) is per-install and lives in `daily_node_actions`.

## Data model

### `daily_setlists` (existing)

The mystery node entry already has `cf_pool`. Extend the node payload:

```json
{
  "id": "n_mystery_1",
  "type": "mystery",
  "event_type": "guess_year",
  "event_payload": {
    "cf_id": 12345,
    "answer_year": 1978
  }
}
```

`event_payload` shape varies by event_type. The frontend dispatches on `event_type`.

### `daily_node_actions` (from plan 02)

Reuse it for event responses:

- `action = "mystery:guess_year:submit"`, `payload = {"guess": 1980}`
- `action = "mystery:cover_battle:pick"`, `payload = {"cover_idx": 1}`

## Backend

### Event registration

Mirror the `MODIFIERS` pattern:

```python
MYSTERY_EVENTS = {
    "guess_year": {
        "weight": 3,
        "build": _build_guess_year,    # (date_str, node_id, song_pool, history) -> event_payload
        "filter": lambda song: bool(song.get("year")),
    },
    "blind_pick": {
        "weight": 3,
        "build": _build_blind_pick,
        "filter": None,
    },
    "replay": {
        "weight": 2,
        "build": _build_replay,         # needs access to past daily_setlists
        "filter": None,
    },
    ...
}
```

Each `build` returns the `event_payload` dict to embed in the node.

### `_pick_mystery_event(date_str, node_id, ...)`

Seeded by `f"{date_str}:{node_id}:mystery"`. Returns the chosen event_type and payload.

Called inline during `_select_*` mystery node generation, so the result is baked into `daily_setlists`.

### Endpoints

- `GET /api/plugins/the_daily/mystery/{node_id}` — returns the event_payload (with answer fields stripped, e.g. `answer_year` is removed for `guess_year` until after submit).
- `POST /api/plugins/the_daily/mystery/{node_id}/submit` — body varies by event_type, persists to `daily_node_actions`. Returns the result (e.g. `{"correct_year": 1978, "guess": 1980, "delta": 2}`).

### Per-event helpers (V1)

**`_build_guess_year`**
- Filter pool to songs with `year`. Pick one.
- Return `{"cf_id": ..., "answer_year": int(year)}`.

**`_build_blind_pick`**
- Pick any song from pool.
- Return `{"cf_id": ..., "reveal_at_seconds": 5}`.

**`_build_replay`**
- Read past `daily_setlists` (last 30 days). Pick a random song from those that the user *played* (filter via `daily_completions` if install_id known at gen time — actually no, generation is shared, can't be per-user).
- Better: pick a random `cf_id` that has appeared on any past daily, weighted toward more recent.
- Return `{"cf_id": ..., "originally_seen_date": "2026-04-25"}`.

## Frontend

### Mystery modal dispatcher

Replace today's `dsOpenNode` mystery branch (screen.js:566-570) with a dispatch on `event_type`:

```js
function dsOpenMysteryNode(node) {
    switch (node.event_type) {
        case 'guess_year':   return dsRenderGuessYear(node);
        case 'blind_pick':   return dsRenderBlindPick(node);
        case 'replay':       return dsRenderReplay(node);
        default:             return dsRenderMysteryFallback(node);  // legacy: just play
    }
}
```

### V1 event UI

**Guess Year**
- Modal: song obscured (just shows "🎲 Mystery"). Number input for year. [Submit & Play] button.
- After play (i.e. after the song ends, via the existing `song:ended` event), show result modal: "You guessed 1980. It was 1978. Off by 2 years."
- Persist to `daily_node_actions` with the guess.

**Blind Pick**
- Modal: "Press play to hear a song. Title appears after 5 seconds." [Play] button.
- During playback, frontend sets a 5s timer; until then, song info display shows `???`. After 5s, reveal title/artist normally.
- This is purely a UI state — the song plays exactly as it would normally.

**Replay**
- Modal: "🔁 You've seen this one before — Day #N." Show the original day's modifier and date as flavor. [Play] button.

### Result display

For events with results (`guess_year`, future `cover_battle` polls), the completion view shows a small recap card: "Guess Year: you were off by 2 years. Avg. across all players: 5 years."

Cross-player aggregates require Supabase. For V1, just show the user's own result. Add aggregates in V2.

## Determinism notes

- `MYSTERY_EVENTS` weight changes affect future selections only. Past `daily_setlists` rows already have their `event_type` baked in.
- Adding a new event type does not retroactively change past mystery nodes (good).
- Removing an event type would break replay-from-cache for past dates that picked it. **Don't remove events from the catalog**; only deprecate by setting `weight: 0`.

## Rollout

1. **Schema + generation**: extend mystery node payload with `event_type` + `event_payload`. Generate for new days. Past days keep working with the current "just play" semantics — frontend dispatcher falls back gracefully when `event_type` is missing.
2. **V1 events**: `guess_year` + `blind_pick` + `replay`. Each is a small frontend addition.
3. **V2 events**: `cover_battle`, `setlist_sibling`, etc. Each is a self-contained PR.
4. **Aggregates**: Supabase-side stats per event type (avg guess delta, cover_battle vote counts).

## Open questions

- **Cover battle data**: requires multiple recordings of the same song in the pool. Current `songs_pool.json` doesn't dedupe by title — there are likely covers already, just not labeled. Building a "cover groups" pre-pass during pool build could surface them. Out of scope for V1.
- **Replay scope**: **Resolved — appeared-on-past-maps, not played-only.** Generation runs server-side without install_id, so per-user "did they play it" is unavailable at gen time. `_build_replay` picks a `cf_id` from past `daily_setlists` rows weighted toward recent. Sentimental hit is "this song was on Day #N," not "you played this."
- **Should mystery events grant tokens?** **Resolved — no engagement bonus.** Mystery node clears already count toward `cleared_count` in the boss reconcile (`3 × cleared + 5`, see ADR-03). Adding +2 for "filled in the input" inflates economy and creates a punishment-flavored Skip choice (see below). V2 may add aggregate-related rewards (cover_battle voting, etc.) but V1 stays clean.
- **Reveal timing for blind_pick**: fixed at 5s for V1, watch user feedback.
- **Mystery as a streak-breaker**: **Resolved — yes, Skip button.** Per-install state via `daily_node_actions` already supports this; just don't write the `mystery:*:submit` row. Re-opening shows the same deterministic event in un-submitted state. Trade: user could repeatedly open + Skip to "preview" the event type. Acceptable — same info available via the V2 `mystery_event` peek anyway.
