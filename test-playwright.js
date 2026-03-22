const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('https://example.com');
  await page.click('a');
  await page.goBack();
  await page.screenshot({ path: '/tmp/browse-test.png' });

  await browser.close();
})();
