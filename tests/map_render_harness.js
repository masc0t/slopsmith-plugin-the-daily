// Lightweight test harness for map rendering (CSS-driven MVP)
// Requires jsdom if running in Node: npm i -D jsdom
try {
  const { JSDOM } = require('jsdom');
  const fs = require('fs');
  const path = require('path');
  const scriptPath = path.resolve(__dirname, '..', 'the_daily', 'screen.js');
  const html = `<div id="app"></div>`;
  const dom = new JSDOM(html, { resources: 'usable', runScripts: 'dangerously', url: 'http://localhost/' });
  const { window } = dom;
  const { document } = window;
  // Expose a minimal window for the module
  global.window = window;
  global.document = document;
  // Load the script in the dom context
  const fsAsync = fs.readFileSync(scriptPath, 'utf8');
  const vm = require('vm');
  const script = new vm.Script(fsAsync);
  script.runInThisContext();
  // Simple mock payload
  const d = {
    date: '2026-04-26',
    map: {
      nodes: [ { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0, act: 'Intro' }, { id: 'n2', type: 'rest', lane: 'standard', col: 1, row: 0 } ],
      edges: [ { from: 'n1', to: 'n2' } ],
      lanes: { standard: '' }
    },
    available_node_ids: ['n1','n2'],
  };
  // Call the map renderer function
  const htmlOut = window.dsMapView(d);
  console.log(htmlOut ? 'OK' : 'NO-OUTPUT');
} catch (e) {
  console.error('Map render harness failed:', e.message);
}
