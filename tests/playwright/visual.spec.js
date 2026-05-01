const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const testHtmlPath = path.join(__dirname, '../../tests/test-pages/e2e_test.html');
let testHtml = fs.readFileSync(testHtmlPath, 'utf-8');

const screenJsPath = path.join(__dirname, '../../screen.js');
const screenJs = fs.readFileSync(screenJsPath, 'utf-8');

testHtml = testHtml.replace('<script src="/screen.js"></script>', `<script>${screenJs}</script>`);

test.describe('Visual Regression', () => {
  /*
  test('setlist view matches baseline', async ({ page }) => {
    await page.setContent(testHtml, { waitUntil: 'networkidle' });
    
    // Mock the data
    await page.evaluate(() => {
      window._dsData = {
        date: '2026-04-30',
        songs: [
          { cf_id: 1, title: 'Test Song 1', artist: 'Artist 1', has_locally: true, duration: 180 },
          { cf_id: 2, title: 'Test Song 2', artist: 'Artist 2', has_locally: true, duration: 200 }
        ],
        modifier: { icon: '🎸', label: 'Standard', description: 'Standard daily setlist' },
        progress: { done: 1, total: 2 },
        day_name: 'Visual Test Day',
        day_number: 1,
        seed: 'test12',
        inventory: { counts: {} }
      };
      window.dsRender();
    });

    await expect(page).toHaveScreenshot('setlist-view.png');
  });
*/
});
