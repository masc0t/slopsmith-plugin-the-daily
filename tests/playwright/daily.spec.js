const { test, expect } = require('@playwright/test');

// Deterministic mock payload similar to /today response shape
const mockToday = {
  date: '2026-04-26',
  is_complete: false,
  day_name: 'The Daily Test',
  day_number: 1,
  modifier: { id: 'test_mod', label: 'Test Mod', icon: '🧪', description: 'Deterministic preview' },
  songs: [
    { cf_id: 101, title: 'Test Song 1', artist: 'A', duration: 180, tuning: 'standard', has_locally: true, done: false },
  ],
  map: {
    nodes: [ { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0 }, { id: 'n2', type: 'rest', lane: 'standard', col: 1, row: 0 } ],
    edges: [ { from: 'n1', to: 'n2' } ],
    lanes: { standard: '' }
  },
  available_node_ids: ['n1','n2'],
  cleared_node_ids: [],
  locked_node_ids: []
};

test.describe('Daily map view (deterministic)', () => {
  test('loads today and renders map with lane classes', async ({ page }) => {
    // Intercept the /today API call and respond with deterministic payload
    await page.route('**/api/plugins/the_daily/today', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockToday),
      });
    });

    // Load the app root where the plugin UI mounts; adjust URL as needed for your setup
    await page.goto('/');

    // Basic checks: map view container should exist or at least a rendering attempt should complete
    // We look for the presence of lane-standard class on any node in the DOM after render
    const mapNode = await page.evaluate(() => {
      const el = document.querySelector('[class*="ds-svg-lane-group"][class*="lane-standard"]');
      return el ? true : false;
    });
    expect(mapNode).toBeTruthy();
  });
});
