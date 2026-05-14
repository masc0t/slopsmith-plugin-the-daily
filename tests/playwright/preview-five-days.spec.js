const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const days = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'five_days_data.json'), 'utf-8')
);

const screenJs = fs.readFileSync(path.join(__dirname, '../../screen.js'), 'utf-8');
const screenHtml = fs.readFileSync(path.join(__dirname, '../../screen.html'), 'utf-8');

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; }
    .hidden { display: none !important; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
    .max-w-2xl { max-width: 672px; }
    .mx-auto { margin-left: auto; margin-right: auto; }
    .px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
    .pt-24 { padding-top: 2rem; }
    .pb-16 { padding-bottom: 4rem; }
    .flex { display: flex; }
    .items-center { align-items: center; }
    .justify-center { justify-content: center; }
    .justify-between { justify-content: space-between; }
    .gap-3 { gap: 0.75rem; }
    .mb-8 { margin-bottom: 2rem; }
    .mb-6 { margin-bottom: 1.5rem; }
    .mb-4 { margin-bottom: 1rem; }
    .mb-2 { margin-bottom: 0.5rem; }
    .mb-1 { margin-bottom: 0.25rem; }
    .mt-2 { margin-top: 0.5rem; }
    .mt-1 { margin-top: 0.25rem; }
    .space-y-3 > * + * { margin-top: 0.75rem; }
    .space-y-2 > * + * { margin-top: 0.5rem; }
    .text-4xl { font-size: 2.25rem; }
    .text-2xl { font-size: 1.5rem; }
    .text-xl { font-size: 1.25rem; }
    .text-sm { font-size: 0.875rem; }
    .text-xs { font-size: 0.75rem; }
    .font-bold { font-weight: 700; }
    .font-semibold { font-weight: 600; }
    .font-medium { font-weight: 500; }
    .font-mono { font-family: monospace; }
    .uppercase { text-transform: uppercase; }
    .tracking-widest { letter-spacing: 0.1em; }
    .italic { font-style: italic; }
    .text-white { color: #fff; }
    .text-gray-300 { color: #cbd5e1; }
    .text-gray-400 { color: #94a3b8; }
    .text-gray-500 { color: #64748b; }
    .text-gray-600 { color: #475569; }
    .text-accent { color: #4080e0; }
    .text-accent-light { color: #60a5fa; }
    .text-yellow-400 { color: #facc15; }
    .text-green-500 { color: #22c55e; }
    .bg-dark-800 { background-color: #0f172a; }
    .bg-dark-700 { background-color: #1e293b; }
    .bg-dark-700\\/40 { background-color: rgba(30,41,59,0.4); }
    .bg-dark-700\\/50 { background-color: rgba(30,41,59,0.5); }
    .bg-dark-600 { background-color: #334155; }
    .bg-dark-500 { background-color: #475569; }
    .bg-accent { background-color: #4080e0; }
    .bg-accent\\/10 { background-color: rgba(64,128,224,0.1); }
    .bg-accent\\/20 { background-color: rgba(64,128,224,0.2); }
    .border { border-width: 1px; border-style: solid; }
    .border-t { border-top-width: 1px; border-top-style: solid; }
    .border-gray-700 { border-color: #334155; }
    .border-gray-800 { border-color: #1e293b; }
    .border-gray-800\\/40 { border-color: rgba(30,41,59,0.4); }
    .border-dark-700 { border-color: #1e293b; }
    .border-accent\\/30 { border-color: rgba(64,128,224,0.3); }
    .border-accent\\/50 { border-color: rgba(64,128,224,0.5); }
    .border-green-800\\/30 { border-color: rgba(22,101,52,0.3); }
    .border-purple-700\\/40 { border-color: rgba(126,34,206,0.4); }
    .rounded-full { border-radius: 9999px; }
    .rounded-2xl { border-radius: 1rem; }
    .rounded-xl { border-radius: 0.75rem; }
    .rounded-lg { border-radius: 0.5rem; }
    .p-3 { padding: 0.75rem; }
    .p-4 { padding: 1rem; }
    .px-4 { padding-left: 1rem; padding-right: 1rem; }
    .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
    .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
    .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
    .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
    .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
    .py-1\\.5 { padding-top: 0.375rem; padding-bottom: 0.375rem; }
    .py-0\\.5 { padding-top: 0.125rem; padding-bottom: 0.125rem; }
    .py-16 { padding-top: 4rem; padding-bottom: 4rem; }
    .overflow-x-auto { overflow-x: auto; }
    .w-full { width: 100%; }
    .min-w-\\[520px\\] { min-width: 520px; }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .flex-1 { flex: 1; }
    .flex-shrink-0 { flex-shrink: 0; }
    .min-w-0 { min-width: 0; }
    .flex-wrap { flex-wrap: wrap; }
    .gap-2 { gap: 0.5rem; }
    .gap-1 { gap: 0.25rem; }
    .opacity-60 { opacity: 0.6; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { background: none; border: none; cursor: pointer; color: inherit; font: inherit; }
    button:disabled { cursor: not-allowed; }
    .disabled\\:opacity-40:disabled { opacity: 0.4; }
    .daily-root {}
    #ds-map-panel { margin-top: 0.75rem; }
  </style>
</head>
<body>
  <div id="plugin-the_daily-container">
    ${screenHtml}
  </div>
  <audio id="audio"></audio>
  <script>
    // Minimal stubs
    window.showScreen = () => {};
    window.playSong = async () => {};
    window.slopsmith = { on: () => {}, emit: () => {}, off: () => {} };
    window._dsReturnAfterPlayback = false;
    window._dsReturnListenerRegistered = true;
  </script>
  <script>${screenJs}</script>
</body>
</html>`;

test.describe('Map Preview - First 5 Days', () => {
    test.setTimeout(30000);

    for (const day of days) {
        test(`Day ${day.day_number} — ${day.date}`, async ({ page }) => {
            await page.setContent(PAGE_HTML, { waitUntil: 'domcontentloaded' });

            await page.evaluate((d) => {
                // Build songMap from songs array
                const songMap = {};
                (d.songs || []).forEach(s => { songMap[s.cf_id] = s; });

                // Attach the full data object
                window._dsData = {
                    ...d,
                    map: d.map,
                    available_node_ids: d.available_node_ids,
                    cleared_node_ids: d.cleared_node_ids,
                    committed_node_ids: d.committed_node_ids,
                    locked_node_ids: d.locked_node_ids,
                    boss_revealed: d.boss_revealed,
                    debug_no_save: false,
                };
                window.dsRender();
            }, day);

            // Wait for map SVG to appear
            await page.waitForSelector('svg', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(300);

            const screenshotsDir = require('path').join(__dirname, '..', 'screenshots');
            require('fs').mkdirSync(screenshotsDir, { recursive: true });

            await page.screenshot({
                path: require('path').join(screenshotsDir, `day-${day.day_number}-${day.date}.png`),
                fullPage: true,
            });
        });
    }
});
