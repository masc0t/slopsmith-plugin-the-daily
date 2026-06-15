// Map render tests - no server required
// Run with: node tests/map_render_test.js

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// Read screen.js
const screenJsPath = path.join(__dirname, '..', 'screen.js');
const screenJs = fs.readFileSync(screenJsPath, 'utf8');

const html = `<!doctype html>
<html>
<head>
  <style>
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="ds-live-region" aria-live="polite" aria-atomic="true" class="sr-only"></div>
  <div id="output"></div>
  <div id="ds-map-panel"></div>
  <script>${screenJs}<\/script>
  <script>
    // Mock window.slopsmith for testing
    window.slopsmith = {
      on: function() {},
      emit: function() {}
    };
  </script>
</body>
</html>`;

const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable' });
const window = dom.window;
const document = window.document;

// Wait for scripts to load
setTimeout(() => {
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.log(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  console.log('\n=== Map Render Tests ===\n');

  // Test 1: Icon Mapping
  console.log('Test 1: Icon Mapping');
  const iconTests = [
    { type: 'forced', expected: '🎸' },
    { type: 'elite', expected: '⚔️' },
    { type: 'treasure', expected: '💎' },
    { type: 'rest', expected: '🛌' },
    { type: 'shop', expected: '🏪' },
    { type: 'choice', expected: '◇' },
    { type: 'mystery', expected: '?' },
    { type: 'boss', expected: '👑' },
    { type: 'unknown', expected: '●' },
    { type: undefined, expected: '●' },
    { type: null, expected: '●' },
  ];

  iconTests.forEach(t => {
    const node = { type: t.type };
    const icon = window.dsNodeIcon(node);
    assert(icon === t.expected, `dsNodeIcon({type: "${t.type}"}}) should return "${t.expected}", got "${icon}"`);
  });

  // Test 2: Act Labels Presence
  console.log('\nTest 2: Act Labels Presence');

  const dataWithAct = {
    date: '2026-04-26',
    map: {
      nodes: [
        { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0, act: 'Intro' },
        { id: 'n2', type: 'rest', lane: 'standard', col: 1, row: 0, act: 'Act 1' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
      lanes: { standard: '' }
    },
    songs: [],
    available_node_ids: ['n1', 'n2'],
    cleared_node_ids: [],
    locked_node_ids: []
  };

  const htmlWithAct = window.dsMapView(dataWithAct);
  assert(htmlWithAct.includes('Intro'), 'Should contain "Intro" act label');
  assert(htmlWithAct.includes('Act 1'), 'Should contain "Act 1" act label');
  assert(htmlWithAct.includes('ds-svg-act'), 'Should have ds-svg-act class for act labels');

  // Test without act label
  const dataWithoutAct = JSON.parse(JSON.stringify(dataWithAct));
  dataWithoutAct.map.nodes[0].act = undefined;
  dataWithoutAct.map.nodes[1].act = null;
  const htmlWithoutAct = window.dsMapView(dataWithoutAct);
  assert(!htmlWithoutAct.includes('ds-svg-act'), 'Should NOT have ds-svg-act class when no acts');

  // Test 3: Lane Classes
  console.log('\nTest 3: Lane Classes');

  const laneTests = [
    { lane: 'standard', shouldHave: 'lane-standard' },
    { lane: 'drop', shouldHave: 'lane-drop' },
    { lane: 'flat', shouldHave: 'lane-flat' },
    { lane: 'sprint', shouldHave: 'lane-sprint' },
    { lane: 'marathon', shouldHave: 'lane-marathon' },
    { lane: undefined, shouldHave: 'lane-standard' },
    { lane: 'unknown', shouldHave: 'lane-unknown' },
  ];

  laneTests.forEach(t => {
    const data = {
      date: '2026-04-26',
      map: {
        nodes: [
          { id: 'n1', type: 'forced', lane: t.lane, col: 0, row: 0 },
        ],
        edges: [],
        lanes: {}
      },
      songs: [],
      available_node_ids: ['n1'],
      cleared_node_ids: [],
      locked_node_ids: []
    };

    const html = window.dsMapView(data);
    assert(html.includes(`lane-${t.lane || 'standard'}`), `Node with lane="${t.lane}" should have class "lane-${t.lane || 'standard'}"`);
    assert(html.includes('ds-svg-lane-group'), 'Should have ds-svg-lane-group class');
    assert(html.includes('data-lane='), 'Should have data-lane attribute');
  });

  // Test 4: Node States
  console.log('\nTest 4: Node States');

  const data = {
    date: '2026-04-26',
    map: {
      nodes: [
        { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0 },
        { id: 'n2', type: 'rest', lane: 'standard', col: 1, row: 0 },
        { id: 'n3', type: 'elite', lane: 'drop', col: 2, row: 0 },
        { id: 'n4', type: 'boss', lane: 'standard', col: 3, row: 0 },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4' }
      ],
      lanes: { standard: '', drop: '' }
    },
    songs: [],
    available_node_ids: ['n1', 'n2'],
    cleared_node_ids: ['n1'],
    locked_node_ids: ['n3', 'n4']
  };

  const htmlWithStates = window.dsMapView(data);
  assert(htmlWithStates.includes('cursor:pointer'), 'Available/cleared nodes should have cursor:pointer');
  assert(htmlWithStates.includes('#14532d'), 'Cleared nodes should have green fill');
  assert(htmlWithStates.includes('#1d4ed8'), 'Available nodes should have blue fill');
  assert(htmlWithStates.includes('#111827'), 'Locked nodes should have dark fill');

  // Test 5: Lane Label
  console.log('\nTest 5: Lane Label Function');

  const labelTests = [
    { input: 'standard', expected: 'Standard' },
    { input: 'drop', expected: 'Drop' },
    { input: 'flat', expected: 'Flat' },
    { input: 'sprint', expected: 'Sprint' },
    { input: 'marathon', expected: 'Marathon' },
    { input: 'daily', expected: 'Daily' },
    { input: undefined, expected: '' },
    { input: null, expected: '' },
    { input: 'decade_1980s', expected: '1980s' },
    { input: 'some_lane', expected: 'some lane' },
  ];

  labelTests.forEach(t => {
    const result = window.dsLaneLabel(t.input);
    assert(result === t.expected, `dsLaneLabel("${t.input}") should return "${t.expected}", got "${result}"`);
  });

  // Test 6: SVG Structure
  console.log('\nTest 6: SVG Structure');

  const svgData = {
    date: '2026-04-26',
    map: {
      nodes: [
        { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0, edges: ['n2'] },
        { id: 'n2', type: 'rest', lane: 'drop', col: 1, row: 1 },
      ],
      lanes: { standard: '', drop: '' }
    },
    songs: [],
    available_node_ids: ['n1', 'n2'],
    cleared_node_ids: [],
    locked_node_ids: []
  };

  const htmlWithSvg = window.dsMapView(svgData);
  assert(htmlWithSvg.includes('<svg'), 'Should contain SVG element');
  assert(htmlWithSvg.includes('<line'), 'Should contain line elements for edges');
  assert(htmlWithSvg.includes('<circle'), 'Should contain circle elements for nodes');
  assert(htmlWithSvg.includes('<text'), 'Should contain text elements for labels');
  assert(htmlWithSvg.includes('viewBox='), 'Should have viewBox attribute');

  // Test 7: Accessibility - Map node aria-label with song info
  console.log('\nTest 7: Accessibility - Node ARIA');

  const accessibilityData = {
    date: '2026-04-26',
    map: {
      nodes: [
        { id: 'n1', type: 'forced', lane: 'sprint', col: 0, row: 0 },
      ],
      edges: [],
      lanes: { sprint: '⚡' }
    },
    songs: [
      { cf_id: 'song1', title: 'Back in Black', artist: 'AC/DC' }
    ],
    available_node_ids: ['n1'],
    cleared_node_ids: [],
    locked_node_ids: []
  };
  accessibilityData.map.nodes[0].cf_id = 'song1';

  const accessibilityHtml = window.dsMapView(accessibilityData);
  assert(accessibilityHtml.includes('aria-label='), 'Should have aria-label attribute');
  assert(accessibilityHtml.includes('Back in Black'), 'Should include song title in aria-label');
  assert(accessibilityHtml.includes('AC/DC'), 'Should include artist in aria-label');
  assert(accessibilityHtml.includes('role="button"'), 'Interactive nodes should have role="button"');
  assert(accessibilityHtml.includes('tabindex="0"'), 'Interactive nodes should have tabindex="0"');

  // Future nodes should NOT have interactive attributes
  const futureData = {
    date: '2026-04-26',
    map: {
      nodes: [
        { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0 },
      ],
      edges: [],
      lanes: {}
    },
    songs: [],
    available_node_ids: [],
    cleared_node_ids: [],
    locked_node_ids: []
  };

  const futureHtml = window.dsMapView(futureData);
  assert(!futureHtml.includes('role="button"'), 'Future nodes should NOT have role="button"');
  assert(!futureHtml.includes('tabindex="0"'), 'Future nodes should NOT have tabindex="0"');

  // Test 8: Accessibility - dsAnnounce function
  console.log('\nTest 8: Accessibility - Live Region Announcements');

  assert(typeof window.dsAnnounce === 'function', 'dsAnnounce should be a function');

  // Test that dsAnnounce updates the live region
  const liveRegion = document.getElementById('ds-live-region');
  assert(liveRegion !== null, 'Live region element should exist');

  window.dsAnnounce('Test announcement message');
  assert(liveRegion.textContent === 'Test announcement message', 'dsAnnounce should update live region text');

  // Test 9: Accessibility - Panel aria-live
  console.log('\nTest 9: Accessibility - Panel aria-live');

  const panelData = {
    date: '2026-04-26',
    map: {
      nodes: [
        { id: 'n1', type: 'forced', lane: 'standard', col: 0, row: 0 },
      ],
      edges: [],
      lanes: {}
    },
    songs: [],
    available_node_ids: ['n1'],
    cleared_node_ids: [],
    locked_node_ids: []
  };

  const panelHtml = window.dsMapView(panelData);
  assert(panelHtml.includes('aria-live="polite"'), 'Map panel should have aria-live="polite"');

  // Test 10: Focus ring CSS exists in screen.html
  console.log('\nTest 10: Accessibility - Focus Ring CSS');

  const screenHtmlPath = path.join(__dirname, '..', 'screen.html');
  const screenHtml = fs.readFileSync(screenHtmlPath, 'utf8');
  // The focusable element (tabindex="0") is the node group, so the focus ring
  // must target .ds-svg-node-group:focus — that is the element keyboard nav lands on.
  assert(screenHtml.includes('.ds-svg-node-group:focus'), 'screen.html should have focus ring CSS for the focusable SVG node groups');

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed > 0) {
    console.log('\n✗ Some tests failed!');
    process.exit(1);
  } else {
    console.log('\n✓ All tests passed!');
    process.exit(0);
  }
}, 100);
