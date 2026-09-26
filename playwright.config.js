const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test',
  timeout: 30_000,
  use: {
    viewport: { width: 390, height: 844 },
    headless: true,
  },
});
