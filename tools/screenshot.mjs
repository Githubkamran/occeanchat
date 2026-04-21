const url = process.argv[2] || 'http://localhost:3000';
const output = process.argv[3] || 'artifacts/oceanchat-home.png';
const selector = process.argv[4] || 'body';
let chromium;

try {
  ({ chromium } = await import('playwright'));
} catch (_) {
  console.error('Playwright is not installed.');
  console.error('Run: npm run screenshot:install');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator(selector).first().waitFor({ timeout: 10_000 });
  await page.screenshot({ path: output, fullPage: true });
  console.log(`Saved screenshot: ${output}`);
} finally {
  await browser.close();
}
