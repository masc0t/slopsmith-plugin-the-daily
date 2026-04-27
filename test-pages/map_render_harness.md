Map Render Harness (MVP)

Goal: Provide a minimal, portable way to sanity-check the frontend map rendering without a full backend.

What it does:
- Loads screen.js from the The Daily plugin and renders a small mock map in an isolated HTML page.
- Verifies that lane-standard class appears when rendering nodes with a standard lane.

How to run:
- Open test-pages/map_test.html in a browser.
- Inspect the page output for the line "Contains lane-standard class: YES" and ensure it prints YES for the standard lane case.

Extending:
- You can modify test-data inside test-pages/map_test.html to add more nodes with different lanes or acts.
- For automated checks, consider loading the harness in a headless browser (Puppeteer) and asserting DOM text.
