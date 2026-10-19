import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

await page.goto('http://localhost:5175', { waitUntil: 'networkidle' });
await page.fill('#login-form input[name="username"]', 'ui_admin_test');
await page.fill('#login-form input[name="password"]', 'testpass123');
await page.click('#login-form button[type="submit"]');
await page.waitForSelector('#app-view:not([hidden])');
await page.click('a[data-nav="me"]');
await page.waitForSelector('#admin-entry:not([hidden])');
await page.click('#admin-entry');
await page.waitForSelector('#view-admin:not([hidden])');
await page.waitForSelector('.admin-user-card');
await page.waitForTimeout(700);
await page.screenshot({ path: 'admin-ui.png', fullPage: true });
await page.locator('[data-admin-records]').first().click();
await page.waitForSelector('.admin-record-row');
const recordText = await page.locator('.admin-record-row').first().innerText();
if (!recordText.includes('型')) throw new Error('管理员记录列表没有渲染');

const stats = await page.locator('#admin-stats').innerText();
const users = await page.locator('#admin-users').innerText();
if (!stats.includes('注册用户') || !users.includes('ui_admin_test')) {
  throw new Error('管理员页面内容不完整');
}
if (errors.length) throw new Error(`浏览器错误: ${errors.join(' | ')}`);
console.log('Admin UI test passed');
console.log(stats.replace(/\n/g, ' / '));
await browser.close();
