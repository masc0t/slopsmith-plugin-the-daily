# E2E Testing Guide for The Daily Plugin

## Overview

End-to-end (e2E) tests for The Daily plugin use Playwright to verify the UI renders correctly and all user flows work as expected. Tests cover:

- Setlist view rendering (map, songs, progress)
- Complete view with leaderboard and signing
- Accessibility (ARIA labels, keyboard navigation)
- Map rendering with lane classes and act labels
- Lane color legend for accessibility

## Prerequisites

- Node.js (v16 or later)
- npm
- Playwright browsers (Chromium)

## Setup

### 1. Install Dependencies

```bash
cd C:\Users\jimey\slopsmith\plugins\the_daily
npm install
npx playwright install chromium
```

### 2. Enable Debug Mode (Optional)

For debugging map rendering without saving to DB:

```javascript
// In browser console:
localStorage.setItem('ds_debug_map', 'true');
localStorage.setItem('ds_debug_map_date', '2026-04-26');
```

## Running Tests

### Recommended (All Tests)

```bash
npm test
```

### Windows (PowerShell)

```powershell
./tests/run_e2e.ps1
```

### Run Single Test File

```bash
npx playwright test tests/playwright/daily.spec.js
```

### Run Single Test Case

```bash
npx playwright test -g "renders setlist view"
```

### Manual (with dev server)

```bash
# Terminal 1: Start dev server
node tests/dev_server.js 3000

# Terminal 2: Run tests
npx playwright test
```

## Test Structure

```
tests/
├── playwright/
│   └── daily.spec.js          # Main e2e test suite
├── test-pages/
│   ├── e2e_test.html          # Test page with mock environment
│   └── map_test.html          # Lightweight map render test
├── run_e2e.sh                 # Linux/Mac runner
├── run_e2e.ps1                # Windows PowerShell runner
├── dev_server.js              # Simple HTTP server for tests
├── map_render_harness.js      # Node.js map render test
└── E2E_TESTING.md             # This file
```

## Test Cases

### Setlist View Tests
- ✓ Renders modifier info (icon, label, day name, seed)
- ✓ Displays progress bar with correct values
- ✓ Shows 5 song cards
- ✓ Displays rescan bar when songs missing locally
- ✓ Shows fallback notice when modifier falls back

### Map Rendering Tests
- ✓ Renders SVG map with lane classes (lane-standard, etc.)
- ✓ Includes act labels (Intro, etc.)
- ✓ Nodes have proper data-lane attributes
- ✓ Lane colors are applied via CSS classes

### Complete View Tests
- ✓ Renders "Day Complete!" message
- ✓ Shows correct day name and modifier
- ✓ Displays tabs (Setlist, Wall of Fame)
- ✓ Shows date navigation (prev/next day, date picker)
- ✓ Sign form is visible with name input and rating buttons

### Accessibility Tests
- ✓ ARIA labels present on interactive elements
- ✓ Keyboard navigation works (tab order)
- ✓ Lane color legend is visible when map is shown
- ✓ Legend includes all lane types with color swatches

### Leaderboard Tests
- ✓ Tab switches to Wall of Fame view
- ✓ Leaderboard data renders correctly
- ✓ Date navigation works for historical views

## Mock Data

Tests use mock API responses defined in `daily.spec.js`:

```javascript
const mockToday = {
  date: '2026-04-26',
  is_complete: false,
  day_name: 'Daily #5',
  // ... see file for full structure
};

const mockLeaderboard = {
  date: '2026-04-26',
  entries: [/*...*/],
  // ... see file for full structure
};
```

## Debugging Tests

### View Test Report

```bash
npx playwright show-report
```

### Run Single Test

```bash
npx playwright test -g "renders setlist view"
```

### Debug Mode (step through)

```bash
npx playwright test --debug
```

### View Browser

```bash
npx playwright test --headed
```

## CI Integration

Add to your CI pipeline:

```yaml
- name: Run e2e tests
  run: |
    cd plugins/the_daily
    npm install
    npx playwright install chromium
    ./tests/run_e2e.sh
```

## Visual Regression Testing

We use Playwright's visual snapshotting to prevent unintended CSS regressions.

### Update Baselines
When you intentionally change the UI, update the snapshots:

```bash
npx playwright test --update-snapshots
```

### Running Visual Tests
Standard test runs will now automatically fail if the visual output differs from the stored baseline:

```bash
npx playwright test tests/playwright/visual.spec.js
```

## Code Coverage

We use `coverage.py` to track backend test coverage.

### Running Coverage
Backend coverage is automatically generated whenever you run the standard test suite:

```bash
npm run test:python
```

This will run the Python unit tests and print a coverage summary for `routes.py` to the console.

### Detailed Coverage Report
For a full HTML report of untested lines in the backend:

```bash
python -m coverage html --include=routes.py
# View results in htmlcov/index.html
```

## Troubleshooting

### Tests timeout or fail to load page
- Ensure dev server is running on port 3000
- Check that `e2e_test.html` is accessible at `http://localhost:3000/tests/test-pages/e2e_test.html`

### Mock API not working
- Check that `page.route()` patterns match the actual API URLs
- Verify mock data structure matches what `screen.js` expects

### Lane legend not showing
- Ensure `dsRender()` in `screen.js` toggles the legend visibility based on `d.map`
- Check that `#ds-lane-legend` element exists in the HTML

## Coverage Goals

Current e2e test coverage:
- ✓ Setlist view rendering
- ✓ Map rendering with lanes and acts
- ✓ Complete view rendering
- ✓ Sign form interaction
- ✓ Leaderboard tab switching
- ✓ Accessibility (ARIA labels)
- ✓ Lane color legend
- ✓ Historical day navigation (boundaries, retry logic, keyboard nav)

Future improvements:
- Add visual regression tests (screenshot comparisons)
- Test confetti animation trigger
- Test rating selection and sign submission
- Add performance benchmarks for map rendering
