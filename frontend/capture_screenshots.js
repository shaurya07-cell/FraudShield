import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DOCS_DIR = 'C:\\Users\\SHAURYA\\OneDrive\\Desktop\\FraudShield\\docs';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();

  // 1. Dashboard Desktop 1280x900
  console.log('Capturing Dashboard at 1280px...');
  await page.setViewport({ width: 1280, height: 960 });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(DOCS_DIR, 'dashboard_1280.png') });

  // 2. Open Drawer on click
  console.log('Capturing Drawer at 1280px...');
  const firstRow = await page.$('tbody tr[role="button"]');
  if (firstRow) {
    await firstRow.click();
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: path.join(DOCS_DIR, 'drawer_1280.png') });
  }

  // 3. Dashboard Mobile 390x844
  console.log('Capturing Dashboard at 390px...');
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(DOCS_DIR, 'dashboard_390.png') });

  // 4. Send Money Mobile 390x844
  console.log('Capturing Send Money at 390px...');
  await page.goto('http://localhost:5173/pay', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(DOCS_DIR, 'pay_390.png') });

  // 5. Test Fill Suspicious Payment & Pay
  console.log('Testing Suspicious Payment submission at 390px...');
  const suspiciousBtn = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find((b) => b.textContent?.includes('Fill suspicious payment'));
  });
  if (suspiciousBtn.asElement()) {
    await suspiciousBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 400));
    const payBtn = await page.$('button[type="submit"]');
    if (payBtn) {
      await payBtn.click();
      await new Promise((r) => setTimeout(r, 1500));
      await page.screenshot({ path: path.join(DOCS_DIR, 'pay_result_390.png') });
    }
  }

  // 6. Send Money Desktop 1280x800
  console.log('Capturing Send Money at 1280px...');
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:5173/pay', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(DOCS_DIR, 'pay_1280.png') });

  await browser.close();
  console.log('All screenshots captured successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
