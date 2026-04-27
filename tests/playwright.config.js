module.exports = {
  testDir: './tests/playwright',
  retries: 1,
  use: {
    baseURL: 'http://localhost',
    headless: true,
  },
};
