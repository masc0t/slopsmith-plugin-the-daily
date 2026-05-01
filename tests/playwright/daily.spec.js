const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Read the test HTML file that has screen.js loaded
const testHtmlPath = path.join(__dirname, '../../tests/test-pages/map_render_test.html');
let testHtml = fs.readFileSync(testHtmlPath, 'utf-8');

// Read screen.js and inject it directly
const screenJsPath = path.join(__dirname, '../../screen.js');
const screenJs = fs.readFileSync(screenJsPath, 'utf-8');

// Inject screen.js directly into the HTML
testHtml = testHtml.replace('<script src="/screen.js"></script>', `<script>${screenJs}</script>`);

test.describe('Daily Setlist Map Rendering Tests', () => {
  test('map rendering produces lane classes and data attributes', async ({ page }) => {
    await page.setContent(testHtml, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const result = await page.evaluate(() => {
      const d = {
        date: '2026-04-26',
        map: {
          nodes: [
            { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0, act: 'Intro' },
            { id: 'n2', type: 'rest', lane: 'standard', col: 1, row: 0 },
            { id: 'n3', type: 'boss', lane: 'marathon', col: 2, row: 0 },
          ],
          edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' }
          ],
          lanes: { standard: '', marathon: '' }
        },
        available_node_ids: ['n1', 'n2', 'n3'],
        cleared_node_ids: [],
        locked_node_ids: [],
        inventory: { counts: { boss_reroll: 0 } },
        debug_no_save: false,
      };

      return window.renderMap(d);
    });

    // Verify lane classes are present
    expect(result).toContain('lane-standard');
    expect(result).toContain('lane-marathon');
    expect(result).toContain('ds-svg-lane-group');

    // Verify data-lane attributes
    expect(result).toContain('data-lane="standard"');
    expect(result).toContain('data-lane="marathon"');

    // Verify act labels
    expect(result).toContain('Intro');
    expect(result).toContain('ds-svg-act');
  });

  test('map rendering with multiple lane types', async ({ page }) => {
    await page.setContent(testHtml, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const result = await page.evaluate(() => {
      const d = {
        date: '2026-04-26',
        map: {
          nodes: [
            { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0 },
            { id: 'n2', type: 'forced', lane: 'drop', col: 1, row: 0 },
            { id: 'n3', type: 'forced', lane: 'flat', col: 2, row: 0 },
            { id: 'n4', type: 'forced', lane: 'sprint', col: 3, row: 0 },
          ],
          edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' },
            { from: 'n3', to: 'n4' }
          ],
          lanes: { standard: '', drop: '', flat: '', sprint: '' }
        },
        available_node_ids: ['n1', 'n2', 'n3', 'n4'],
        cleared_node_ids: [],
        locked_node_ids: [],
        inventory: { counts: { boss_reroll: 0 } },
        debug_no_save: false,
      };

      return window.renderMap(d);
    });

    // Check all lane types
    expect(result).toContain('lane-standard');
    expect(result).toContain('lane-drop');
    expect(result).toContain('lane-flat');
    expect(result).toContain('lane-sprint');
  });

  test('song card rendering', async ({ page }) => {
    await page.setContent(testHtml, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    const result = await page.evaluate(() => {
      const song = { cf_id: 101, title: 'Test Song', artist: 'Test Artist', duration: 180, has_locally: true, done: false };
      return window.renderSongCard(song, 0, false);
    });

    expect(result).toContain('Test Song');
    expect(result).toContain('Test Artist');
  });

  test('node icon mapping', async ({ page }) => {
    await page.setContent(testHtml, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const result = await page.evaluate(() => {
      const d = {
        date: '2026-04-26',
        map: {
          nodes: [
            { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0 },
            { id: 'n2', type: 'elite', lane: 'standard', col: 1, row: 0 },
            { id: 'n3', type: 'treasure', lane: 'standard', col: 2, row: 0 },
            { id: 'n4', type: 'rest', lane: 'standard', col: 3, row: 0 },
            { id: 'n5', type: 'boss', lane: 'standard', col: 4, row: 0 },
          ],
          edges: [],
          lanes: { standard: '' }
        },
        available_node_ids: ['n1', 'n2', 'n3', 'n4', 'n5'],
        cleared_node_ids: [],
        locked_node_ids: [],
        inventory: { counts: { boss_reroll: 0 } },
        debug_no_save: false,
      };

      return window.renderMap(d);
    });

    // Check that node icons are rendered (from NODE_TYPE_ICONS)
    expect(result).toContain('🎸');  // forced
    expect(result).toContain('⚔️');  // elite
    expect(result).toContain('💎');  // treasure
    expect(result).toContain('🛌');  // rest
    expect(result).toContain('👑');  // boss
  });

  test('map renders SVG elements', async ({ page }) => {
    await page.setContent(testHtml, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const result = await page.evaluate(() => {
      const d = {
        date: '2026-04-26',
        map: {
          nodes: [
            { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0 },
          ],
          edges: [],
          lanes: { standard: '' }
        },
        available_node_ids: ['n1'],
        cleared_node_ids: [],
        locked_node_ids: [],
        inventory: { counts: { boss_reroll: 0 } },
        debug_no_save: false,
      };

      return window.renderMap(d);
    });

    // Check SVG structure
    expect(result).toContain('<svg');
    expect(result).toContain('</svg>');
    expect(result).toContain('<circle');
    expect(result).toContain('<text');
  });
});
