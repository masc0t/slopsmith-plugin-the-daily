# The Daily - TODO

## MVP Roadmap (from CLAUDE.md)

### ✅ Completed
- [x] CSS-driven styling for map lanes and acts (Option A) - lane colors and act-label styling in CSS variables and lane-<name> classes
- [x] Lightweight map render tests (no server) - 5 Playwright tests passing
- [x] Lane color legend for accessibility - added to screen.html with ARIA support
- [x] Documented how to run deterministic previews (E2E_TESTING.md)
- [x] Documented how to verify visuals locally (E2E_TESTING.md)
- [x] Quick-start for MVP tests added to E2E_TESTING.md
- [x] Deterministic snapshot workflow for preview.py - `--snapshot` mode and `compare_snapshots.py` tool

### 🔲 Pending

#### High Priority
- [x] Extend preview workflow with deterministic test path to produce stable snapshots for comparison
  - [x] Add `--snapshot` mode to `preview.py` that outputs JSON/YAML of selected songs per day
  - [x] Save snapshots to `tests/snapshots/` for date range
  - [x] Add comparison tool to diff snapshots across runs

#### Medium Priority
- [x] Improve accessibility (ARIA labels, keyboard navigation)
  - [x] Audit all interactive elements in screen.html for ARIA attributes
  - [x] Test keyboard navigation: Left/Right arrows for day navigation in complete view
  - [x] Add `aria-label`, `aria-pressed`, `role` attributes where missing
  - [x] Test with screen reader or accessibility checker

- [x] Add e2e tests for full UI flows
  - [x] Test clicking nodes to play songs (mock `playSong()`)
  - [x] Test day navigation (prev/next buttons, date picker)
  - [x] Test rating selection and sign submission
  - [x] Test confetti animation trigger on completion

- [x] Create visual verification helper
  - [x] Add screenshot comparison to Playwright tests
  - [x] Document visual diff process in E2E_TESTING.md
  - [x] Consider adding Percy or similar visual regression tool

## E2E Testing (Current Status: 11/11 tests passing ✅)

### Test Files
- `tests/playwright/daily.spec.js` - 5 tests (all passing)
- `tests/playwright/ui-flow.spec.js` - 6 tests (all passing)
- `tests/test-pages/e2e_test.html` - full test page
- `tests/test-pages/map_render_test.html` - minimal test page
- `tests/E2E_TESTING.md` - documentation
- `tests/snapshots/` - deterministic snapshot storage
- `compare_snapshots.py` - snapshot comparison tool

### What Works
- Map rendering with lane classes and data attributes
- Multiple lane types (standard, drop, flat, sprint, marathon)
- Song card rendering
- Node icon mapping (🎸, ⚔️, 💎, 🛌, 👑)
- SVG structure validation
- Deterministic snapshot generation via `preview.py --snapshot`
- Snapshot comparison via `compare_snapshots.py`
- Full UI flow tests (init, complete view, leaderboard)
- Accessibility tests (ARIA labels, keyboard nav)
- Lane color legend visibility toggle

### What's Missing
- Visual regression tests (screenshot comparisons)
- Historical day navigation tests

## Bug Fixes Needed
- [x] Fix `_build_map` function - was missing function definition header (indentation error at line 1224)
- [x] Fix syntax error in `compare_snapshots.py` - missing `}` in f-string
- [x] Verify `window.*` exports at end of screen.js are complete
- [x] Test that lane legend shows/hides correctly with map presence

## Dev Workflow Improvements
- [x] Deterministic preview snapshots - `preview.py --snapshot` and `compare_snapshots.py`
- [x] Add `npm test` script that runs both Python and Playwright tests
- [x] Add pre-commit hook to run tests
- [x] Document how to run single test file: `npx playwright test tests/playwright/daily.spec.js`
- [ ] Add test coverage reporting

## Notes
- All Playwright tests use `page.setContent()` with injected screen.js (no dev server needed)
- Python tests (`test_daily.py`, `test_setlist_by_date.py`, `test_leaderboard.py`) run independently
- Preview script (`preview.py`) is separate from e2e tests
