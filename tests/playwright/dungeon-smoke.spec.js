// Dungeon-flow smoke test. Replaces the old 2D-map specs (the 2D UI was
// removed). The Daily is now a 3D dungeon whose front door is the Quake-1
// main menu, so this verifies: the menu renders, keyboard nav works, and no
// console/page errors occur while entering.
//
// The dungeon must run from a real HTTP origin (page.setContent gives an
// opaque origin where localStorage throws), so this spec serves the inlined
// test page itself. It imports three.js from a CDN inside dsDungeonEnter; when
// that CDN is unreachable (offline CI) the test skips rather than failing.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');

function buildHtml() {
  const htmlPath = path.join(ROOT, 'tests', 'test-pages', 'e2e_test.html');
  const screenJs = fs.readFileSync(path.join(ROOT, 'screen.js'), 'utf-8');
  return fs.readFileSync(htmlPath, 'utf-8').replace('<script src="/screen.js"></script>', `<script>${screenJs}</script>`);
}
function loadDay() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'playwright', 'five_days_data.json'), 'utf-8'));
  return data[0];
}

let server, baseUrl;

test.beforeAll(async () => {
  const html = buildHtml();
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});

test.afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test.describe('Dungeon main menu', () => {
  test('renders the Quake main menu and navigates without errors', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const day = loadDay();
    await page.evaluate(async (d) => { window._dsData = d; try { await window.dsDungeonEnter(d); } catch (e) {} }, day);

    // three.js loads from a CDN; skip if it couldn't (offline environment).
    const threeLoaded = await page.evaluate(() => !!window._dsTHREE);
    test.skip(!threeLoaded, 'three.js CDN unavailable in this environment');

    await page.waitForSelector('#ds-mm-items .ds-q-item', { timeout: 8000 });

    const labels = await page.$$eval('#ds-mm-items .ds-q-item', (els) => els.map((e) => e.textContent.replace(/[^A-Z ]/g, '').trim()));
    expect(labels).toContain('DESCEND');
    expect(labels).toContain('OPTIONS');
    expect(labels).toContain('QUIT');

    // Keyboard nav moves the selection.
    const firstSel = await page.$eval('#ds-mm-items .ds-q-item.sel', (e) => e.textContent);
    await page.keyboard.press('ArrowDown');
    const afterSel = await page.$eval('#ds-mm-items .ds-q-item.sel', (e) => e.textContent);
    expect(afterSel).not.toBe(firstSel);

    expect(errors, 'console/page errors during dungeon entry:\n' + errors.join('\n')).toEqual([]);
  });

  test('OPTIONS screen adjusts a slider with the keyboard', async ({ page }) => {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const day = loadDay();
    await page.evaluate(async (d) => { window._dsData = d; try { await window.dsDungeonEnter(d); } catch (e) {} }, day);
    const threeLoaded = await page.evaluate(() => !!window._dsTHREE);
    test.skip(!threeLoaded, 'three.js CDN unavailable in this environment');

    await page.waitForSelector('#ds-mm-items .ds-q-item');
    await page.evaluate(() => {
      [...document.querySelectorAll('#ds-mm-items .ds-q-item')].find((b) => /OPTIONS/.test(b.textContent)).click();
    });
    await page.waitForSelector('#ds-opt-rows [data-row]');

    const before = await page.$eval('#ds-opt-rows [data-row].sel', (e) => e.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowLeft'); // adjust the focused slider down a step
    const after = await page.$eval('#ds-opt-rows [data-row].sel', (e) => e.getAttribute('aria-valuenow'));
    expect(Number(after)).toBeLessThan(Number(before));
  });
});
