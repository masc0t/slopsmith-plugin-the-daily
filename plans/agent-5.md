# Build prompts: Remote Modifier Manifest

Five sequential prompts for implementing ADR 0006. Each is self-contained. Run them in order — each builds on the previous.

Background: `plans/adr/0006-remote-modifier-manifest.md` and `CONTEXT.md` have the full design rationale.

---

## Prompt 1 — Predicate DSL engine

**Context:**
The Daily plugin (`plugins/the_daily/routes.py`) currently defines modifiers as Python dicts with lambda `fn` fields. We are moving modifier definitions to a remote JSON manifest. Data-driven modifiers will express their selection logic as a JSON predicate dict rather than a Python lambda.

You are adding the predicate evaluation engine. This is a pure addition — no existing code changes.

**Task:**
Add `_eval_predicate(song: dict, predicate: dict) -> bool` to `routes.py`, somewhere near the top of the file after the imports and constants but before the modifier definitions.

The function must support these primitive ops (the `"op"` field in the predicate dict):

| op | fields | semantics |
|----|--------|-----------|
| `year_between` | `min`, `max` | `min <= song["year"] <= max` (treat missing/None year as 0) |
| `year_in` | `values` (list) | `song["year"] in values` |
| `year_ends_with` | `digit` (str) | `str(song["year"]).endswith(digit)` |
| `field_len_lte` | `field`, `n` | `len(song.get(field, "")) <= n` |
| `field_len_gte` | `field`, `n` | `len(song.get(field, "")) >= n` |
| `field_case` | `field`, `test` | test is `"upper"` → `.isupper()`, `"lower"` → `.islower()` |
| `field_contains_field` | `haystack`, `needle` | `song.get(needle,"").lower() in song.get(haystack,"").lower()` |
| `field_keywords` | `field`, `words` (list) | any word in `words` appears as a substring in `song.get(field,"").lower()` |
| `same_first_letter` | `fields` (list of 2) | `song.get(fields[0],"")[0].lower() == song.get(fields[1],"")[0].lower()` (skip if either empty) |
| `field_all_digits` | `field` | `song.get(field,"").replace(" ","").isdigit()` |
| `field_has_nonalnum` | `field` | `not song.get(field,"").replace(" ","").isalnum()` |

Return `False` for any unknown op rather than raising — unknown ops are a forward-compat signal that `min_plugin_version` should have gated.

**Tests:**
Add `tests/test_predicate_dsl.py` with one test per op, including edge cases: missing field, None year, unknown op, empty string.

**Constraints:**
- No imports beyond what's already in `routes.py`
- The function must be pure — no side effects, no DB access

---

## Prompt 2 — Modifier manifest fetch, cache, and version gate

**Context:**
The Daily plugin (`plugins/the_daily/routes.py`) fetches a versioned song pool from a GitHub release using a manifest + stamp system (`_fetch_manifest`, `_load_pool`, `pool_cache` table). We are adding an identical system for modifier definitions.

The modifier manifest URL is:
```
https://github.com/masc0t/slopsmith-plugin-the-daily/releases/download/pool-archive/modifiers-manifest.json
```

The manifest JSON shape:
```json
{
  "stamps": [
    {
      "date": "2026-04-22",
      "min_plugin_version": null,
      "active": [
        {
          "id": "e_standard",
          "label": "E Standard",
          "description": "...",
          "icon": "🎸",
          "type": "filter",
          "predicate": {"op": "field_keywords", "field": "tuning", "words": ["e standard"]}
        }
      ]
    }
  ]
}
```

Each stamp entry in `active` is either:
- A **data-driven modifier**: has a `predicate` dict (evaluated by `_eval_predicate` from Prompt 1)
- An **algorithm-parameterized modifier**: no `predicate` field; has `fn`, `shape`, `rules`, or `key` fields that the existing algorithm implementations use

**Task:**

1. **Add `MODIFIERS_MANIFEST_URL` constant** near `MANIFEST_URL` and `POOL_URL`.

2. **Read plugin version at startup.** Add near the top of the module (after imports):
   ```python
   def _read_plugin_version():
       try:
           with open(Path(__file__).parent / "plugin.json") as f:
               return json.load(f).get("version", "0.0.0")
       except Exception:
           return "0.0.0"
   _PLUGIN_VERSION = _read_plugin_version()
   ```

3. **Add `modifier_manifest_cache` table** to the `_init_db()` function:
   ```sql
   CREATE TABLE IF NOT EXISTS modifier_manifest_cache (
       date      TEXT PRIMARY KEY,
       manifest  TEXT NOT NULL,
       fetched_at TEXT NOT NULL
   )
   ```

4. **Add `_fetch_modifier_manifest() -> dict | None`** — fetches `MODIFIERS_MANIFEST_URL`, returns parsed JSON or `None` on failure. Same pattern as `_fetch_manifest()`: 10-second timeout, User-Agent header.

5. **Add `_load_modifier_manifest(date_str: str) -> dict`** — orchestrates fetch + cache:
   - Check `modifier_manifest_cache` for a row where `date = date_str`. If found, return parsed `manifest` JSON.
   - Otherwise fetch via `_fetch_modifier_manifest()`.
   - On success: write to `modifier_manifest_cache` (INSERT OR REPLACE), return manifest.
   - On failure: raise `RuntimeError("offline")`.

6. **Add `_resolve_modifier_stamp(manifest: dict, date_str: str) -> dict`** — latest-leq lookup on `manifest["stamps"]` by `"date"` field. Returns the stamp dict. Raises `RuntimeError` if no stamp applies.

7. **Add `_check_version_gate(stamp: dict)`** — compares `stamp.get("min_plugin_version")` against `_PLUGIN_VERSION` using `packaging.version.Version` if available, else simple string comparison. Raises `RuntimeError("update_required:<min_version>")` if plugin is too old.

**Tests:**
Add `tests/test_modifier_manifest.py` covering:
- `_resolve_modifier_stamp` latest-leq correctness (multiple stamps, date before all stamps, date between stamps, exact match)
- `_check_version_gate` passes when no min_version, passes when equal, raises when older
- `_load_modifier_manifest` returns cached row on second call (mock the fetch to assert it's only called once per date)

**Constraints:**
- Use `unittest.mock` / `pytest` fixtures for network calls — no real HTTP in tests
- `packaging` may not be installed; fall back gracefully to tuple comparison of semver parts if import fails

---

## Prompt 3 — Remove MODIFIERS dict; rewrite picker and selector

**Context:**
`routes.py` in the The Daily plugin (`plugins/the_daily/`) contains a hardcoded `MODIFIERS` dict (~300 lines, starting around line 172). `_pick_modifier(date_str)` shuffles `list(MODIFIERS.keys())` and returns the first. `_select_songs(date_str, modifier_id, pool)` dispatches on `MODIFIERS[modifier_id]["type"]`.

Per ADR 0006, the `MODIFIERS` dict is being replaced by a remote manifest. Prompt 2 added the manifest infrastructure. Prompt 1 added `_eval_predicate`. This prompt migrates the picker and selector and creates the initial manifest file.

**Task:**

### Part A — Create `modifiers-manifest.json`

Create `plugins/the_daily/modifiers-manifest.json` (committed to the repo — this is the canonical baseline, not gitignored). It must contain a single stamp dated `"2026-04-22"` with `min_plugin_version: null` and an `active` list covering all 43 modifiers currently in `MODIFIERS`.

For each modifier:
- Copy `label`, `description`, `icon`, `type` verbatim
- For `filter` type modifiers whose `fn` is expressible via the Predicate DSL (see Prompt 1 op table), add a `predicate` dict and omit `fn`
- For all other types (`identity`, `composite`, `sequence`, `structural`, `ordering`, `ui`, `meta`) and any `filter` with logic not covered by the DSL, carry over the non-lambda fields (`key`, `fn` name as string, `shape`, `rules`, `min_pool`, `count`) — these will be looked up by name in the algorithm registry (Part B)

The full 43-modifier list to convert is in `routes.py` starting at line ~172. Read the file before writing the manifest.

### Part B — Algorithm registry

Add `_ALGORITHM_REGISTRY` dict in `routes.py` (after removing `MODIFIERS`) that maps string names to callables for algorithm-parameterized modifiers:
```python
_ALGORITHM_REGISTRY = {
    "title_chains": _title_chains,
    "tuning_family": _tuning_family,
    "is_new_blood": _is_new_blood,
    # ... all named functions referenced by the manifest
}
```

### Part C — Rewrite `_get_active_modifier(date_str) -> dict`

New function that:
1. Calls `_load_modifier_manifest(date_str)` (from Prompt 2) — raises on offline
2. Calls `_resolve_modifier_stamp(manifest, date_str)` — raises on no stamp
3. Calls `_check_version_gate(stamp)` — raises on outdated plugin
4. Returns the stamp's `active` list

### Part D — Rewrite `_pick_modifier(date_str, active: list) -> str`

Change signature to accept the resolved active list (caller passes it in — avoids fetching twice).
```python
def _pick_modifier(date_str, active):
    rng = random.Random(_date_seed(date_str))
    ids = [m["id"] for m in active]
    rng.shuffle(ids)
    return ids[0]
```

### Part E — Rewrite `_select_songs(date_str, modifier_id, pool, active, exclude=None)`

Change signature to accept `active` (the resolved active list). Instead of `MODIFIERS[modifier_id]`, look up the modifier definition from `active`:
```python
mod = next(m for m in active if m["id"] == modifier_id)
```

For `filter` type: if `mod` has a `predicate` key, use `_eval_predicate(s, mod["predicate"])` as the filter fn. If it has a string `fn` key, look it up in `_ALGORITHM_REGISTRY`.

All other dispatch logic (`identity`, `composite`, etc.) stays identical — just replace `MODIFIERS[modifier_id]` references with `mod`.

### Part F — Update the `/today` endpoint

The endpoint currently calls `_pick_modifier(date_str)` and `_select_songs(...)` directly. Update it to:
1. Call `_get_active_modifier(date_str)` — catch `RuntimeError` and return structured errors (see Prompt 4)
2. Pass `active` through to `_pick_modifier` and `_select_songs`

### Part G — Delete `MODIFIERS`

Remove the entire `MODIFIERS` dict from `routes.py` once all references are migrated.

**Constraints:**
- Do not change any of the underlying algorithm functions (`_identity_candidates`, `_select_composite`, `_select_sequence`, `_select_structural`, `_select_meta`) — only how they receive their modifier definition
- Existing tests must still pass — update any tests that directly reference `MODIFIERS` to use the manifest fixture instead
- The `modifiers-manifest.json` file must be valid JSON parseable by `json.load`

---

## Prompt 4 — Error states: offline and outdated plugin

**Context:**
The Daily plugin's `/today` endpoint (in `plugins/the_daily/routes.py`) now calls `_get_active_modifier(date_str)` (added in Prompt 3), which raises `RuntimeError("offline")` when the modifier manifest can't be fetched and `RuntimeError("update_required:<version>")` when the plugin is too old.

The frontend (`plugins/the_daily/screen.js` and `screen.html`) currently handles the happy path only.

**Task:**

### Backend

In the `/today` endpoint, wrap the `_get_active_modifier` call:
```python
try:
    active = _get_active_modifier(date_str)
except RuntimeError as e:
    msg = str(e)
    if msg == "offline":
        return {"error": "offline"}
    if msg.startswith("update_required:"):
        return {"error": "update_required", "min_version": msg.split(":", 1)[1]}
    raise
```

Also apply the same error handling to the `/today` endpoint's pool load path (`_load_pool`) — it can also go offline. Return `{"error": "offline"}` consistently.

### Frontend

In `screen.js`, in the function that fetches `/today` and renders the setlist view:

1. After parsing the JSON response, check for `data.error` before proceeding.
2. If `data.error === "offline"`: replace the setlist container content with an offline message. Use the existing dark-theme styling (`bg-dark-600`, `text-gray-300`). Message: "No internet connection — The Daily requires an active connection. Try again later."
3. If `data.error === "update_required"`: show an update prompt. Message: "A plugin update is required to play today's Daily. Update The Daily plugin in Slopsmith settings." Include `data.min_version` in a subtle subtitle if present.
4. Both states should render inside `#ds-setlist-view` (the existing container) rather than a modal — consistent with how loading states are handled today.

In `screen.html`, add two hidden template divs (or build them inline in JS — match the existing pattern in the file):
- `#ds-error-offline`
- `#ds-error-update`

**Constraints:**
- Do not add new CSS classes — use existing Tailwind utilities and `bg-dark-*` tokens already present in `screen.html`
- The error states must be dismissible / retry-able: add a "Retry" button on the offline state that re-calls the fetch function
- Keep existing happy-path rendering unchanged

---

## Prompt 6 — Update `preview.py` to use manifest-based active modifier set

**Context:**
`preview.py` is a dev tool that simulates upcoming Daily setlists without touching the database. It currently imports `MODIFIERS` directly from `routes.py` and calls `_pick_modifier(date_str)` / `_select_songs(...)` with the old signatures.

After Prompt 3, `MODIFIERS` no longer exists in `routes.py`. `_pick_modifier` now takes `(date_str, active)` where `active` is a list of modifier dicts resolved from the manifest. `_select_songs` takes an additional `active` parameter. This is the only change needed to un-skip `test_preview_imports`.

`preview.py` does not use the SQLite database — it runs standalone. It already has its own `_fetch_manifest()` and `_load_pool()` that bypass the DB. Use the same pattern for the modifier manifest.

**All changes are in `plugins/the_daily/preview.py`. Do not touch `routes.py` or any test file except `test_daily.py` (to un-skip the one test).**

### Step 1 — Fix imports (line 15–28)

Remove `MODIFIERS` from the import list. Add `MODIFIERS_MANIFEST_URL`, `_fetch_modifier_manifest` (the raw fetch function, not the DB-caching one), and `_resolve_modifier_stamp`:

```python
from plugins.the_daily.routes import (
    BUNDLED_POOL_STAMP,
    DEFAULT_SONG_COUNT,
    MAP_LANES,
    MANIFEST_URL,
    MODIFIERS_MANIFEST_URL,
    POOL_URL,
    _build_map,
    _EPOCH,
    _date_seed,
    _day_name,
    _fetch_modifier_manifest as _fetch_modifier_manifest_raw,
    _pick_modifier,
    _resolve_modifier_stamp,
    _select_songs,
)
```

### Step 2 — Add `_load_active_modifier_set(target_date)`

Add this function after `_load_pool` (around line 94). It fetches the modifier manifest and resolves the active list for a date — no DB, no version gate (preview is a dev tool, version gating is irrelevant):

```python
def _load_active_modifier_set(target_date: date) -> list:
    manifest = _fetch_modifier_manifest_raw()
    if not manifest:
        raise RuntimeError("Could not fetch modifiers-manifest.json — check network connection")
    stamp = _resolve_modifier_stamp(manifest, target_date.isoformat())
    return stamp["active"]
```

Note: `_resolve_modifier_stamp` in `routes.py` takes `(manifest, date_str)` where `manifest` is the full manifest dict (not just the stamps list). Verify the signature matches what was implemented in Prompt 2 and adjust accordingly.

### Step 3 — Update `_simulate_day` signature (line 97)

Add `active: list` as a parameter and pass it to `_pick_modifier` and `_select_songs`:

```python
def _simulate_day(d: date, pool: list, pool_stamp: str, history: dict, active: list, map_mode: bool = False) -> tuple:
    ...
    modifier_id = _pick_modifier(date_str, active)
    ...
    songs, song_count, fallback = _select_songs(date_str, modifier_id, active_pool, active, exclude=exclude)
    # and for map mode:
    map_data, songs, fallback = _build_map(date_str, modifier_id, active_pool, active, exclude=exclude)
```

Also add a helper to look up a modifier dict from the active list by id — used to replace `MODIFIERS[modifier_id]` lookups:

```python
def _mod_by_id(active: list, modifier_id: str) -> dict:
    return next((m for m in active if m["id"] == modifier_id), {})
```

### Step 4 — Update `_lane_label` (line 153–156)

The function currently falls back to `MODIFIERS.get(lane_id, {}).get("label")`. Replace with an `active` parameter:

```python
def _lane_label(lane_id: str, active: list = ()) -> str:
    if re.match(r"^decade_\d{4}s$", lane_id):
        return lane_id.removeprefix("decade_")
    mod = _mod_by_id(list(active), lane_id)
    return MAP_LANES.get(lane_id, {}).get("label") or mod.get("label") or lane_id
```

Update both call sites in `_print_map_ascii` (line 174) and the lane summary in `run()` (line 322) to pass `active`.

### Step 5 — Update `run()` (line 257)

Load the active modifier set once for the start date, then pass it through:

```python
def run(days, compact, start, map_mode, snapshot_path):
    today = start or datetime.utcnow().date()
    pool, pool_stamp = _load_pool(today)
    active = _load_active_modifier_set(today)
    print(f"Pool: {len(pool):,} songs (stamp: {pool_stamp})\n")
    ...
    for i in range(days):
        ...
        modifier_id, songs, song_count, fallback, day_name, map_data, _ = _simulate_day(
            d, pool, pool_stamp, history, active, map_mode=map_mode
        )
        ...
        mod = _mod_by_id(active, modifier_id)
        ...
    # In the summary section, replace MODIFIERS[mid] with _mod_by_id(active, mid)
    # In the lane section, replace MODIFIERS.get(lane_id, {}).get("icon") with _mod_by_id(active, lane_id).get("icon")
```

### Step 6 — Update `_build_snapshot()` (line 206)

Same pattern — load `active` for the start date, pass it to `_simulate_day`, replace `MODIFIERS[modifier_id]["label"]` with `_mod_by_id(active, modifier_id).get("label", modifier_id)`.

### Step 7 — Un-skip the test

In `tests/test_daily.py`, find the skipped test:
```python
@unittest.skip('preview.py needs updating to use active modifier list')
def test_preview_imports(self):
```

Remove the `@unittest.skip` decorator. The test should now pass — verify by running it.

**Constraints:**
- `preview.py` must remain runnable standalone (`python preview.py --days 7`) — do not introduce DB dependencies
- If `_fetch_modifier_manifest_raw()` returns `None` (network unavailable), fail with a clear printed error and `sys.exit(1)` rather than a traceback
- Do not change the output format of `run()` — same columns, same summary layout

---

## Prompt 5 — `publish_modifiers.py` dev script

**Context:**
The Daily plugin uses a `publish_pool.py` script (gitignored, dev-only) to author and upload pool stamps to the `pool-archive` GitHub release. We need an equivalent for the modifier manifest.

The modifier manifest lives at `modifiers-manifest.json` in the `pool-archive` release. Its structure:
```json
{
  "stamps": [
    {"date": "2026-04-22", "min_plugin_version": null, "active": [...]}
  ]
}
```

**Task:**
Create `plugins/the_daily/publish_modifiers.py` (gitignored — add to `.gitignore`).

The script must:

1. **Parse args:**
   - `--stamp YYYY-MM-DD` (optional, defaults to `today_utc + 1 day`)
   - `--min-version X.Y.Z` (optional, defaults to null)
   - `--active-file path/to/active.json` (required) — path to a JSON file containing the new stamp's `active` array

2. **Assert stamp is strictly future** (`stamp > datetime.utcnow().date()`). Hard-fail with a clear message if not.

3. **Fetch current `modifiers-manifest.json`** from the release via anonymous GET. If it doesn't exist (first publish), start with `{"stamps": []}`.

4. **Assert no collision** — the stamp date must not already exist in `manifest["stamps"]`. Hard-fail if it does (stamps are immutable once published).

5. **Append the new stamp** to `manifest["stamps"]`, sorted by date ascending.

6. **Upload via `gh` CLI:**
   ```bash
   gh release upload pool-archive modifiers-manifest.json --clobber --repo masc0t/slopsmith-plugin-the-daily
   ```
   Write the manifest to a temp file, upload it, then clean up.

7. **Verify** — fetch the just-uploaded manifest by anonymous GET, assert the new stamp is present and the content hash matches what was uploaded.

8. **Spot-check** — print the modifier IDs in the new stamp and their types. If any modifier has a `predicate` with an unknown `op` (not in the 11 known ops from Prompt 1), print a warning.

**Constraints:**
- Requires `gh` CLI authenticated and `GITHUB_TOKEN` or `gh auth login` — fail clearly if not
- No third-party dependencies beyond stdlib + `gh` CLI
- Mirror `publish_pool.py`'s structure and error messaging style for consistency
- Add `publish_modifiers.py` to `.gitignore` alongside `publish_pool.py`
