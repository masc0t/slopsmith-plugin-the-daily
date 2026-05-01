const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './playwright',
  retries: 1,
  use: {
    headless: true,
  },
  // No webServer needed - tests use page.setContent()
});
