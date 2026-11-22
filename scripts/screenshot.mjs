// See a page of the running app with the real budget, as the owner would (New Zealand time).
//   npm run dev                                                  (in another terminal first)
//   npm run screenshot -- '#/accounts'                           whole page
//   npm run screenshot -- '#/accounts' --today 2026-11-22        as if it were that day
//   npm run screenshot -- '#/planner' --file other.json --width 400
//   npm run screenshot -- '#/accounts' --width 400 --click 'text=Later' \
//     --click '.acct:has-text("Food and gas") >> text=Details' --only '.acct:has-text("Food and gas")'
//   --click <selector> (repeatable, in order) taps something first: a pop-up's Later, a card's Details.
//   --dark: dark mode, as the owner's phone.
//   --only <selector> pictures just that element (one card) instead of the whole page.
// Saves the picture outside the repo (it shows the owner's money) and prints where. Needs Playwright
// (installed in Claude's cloud sessions; elsewhere `npm i -D playwright` and `npx playwright install chromium`).
// The page has no sync set up, so nothing is written back to the repo.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const file = resolve(opt('--file', '../budget-data/budget.json'));
const today = opt('--today');
const width = Number(opt('--width', '900'));
// Every --click, in order (Playwright selectors: 'text=Later', '.acct:has-text("Rent") >> text=Details').
const clicks = [];
for (let c = opt('--click'); c !== undefined; c = opt('--click')) clicks.push(c);
const only = opt('--only');
const dark = args.includes('--dark'); // as on a phone in dark mode
const out = resolve(opt('--out', join(tmpdir(), `paydays-${Date.now()}.png`)));
const url = `http://localhost:${opt('--port', '5173')}/${args.find((a) => !a.startsWith('--')) ?? '#/planner'}`;

let playwright;
try {
  // require, not import: it also finds a globally installed Playwright (NODE_PATH), as in Claude's cloud sessions.
  playwright = createRequire(import.meta.url)('playwright');
} catch {
  console.error('Playwright is not installed: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}
const budget = readFileSync(file, 'utf8');
const browser = await playwright.chromium.launch();
// The app works out "today" from the device's own clock and time zone: use the owner's.
const ctx = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'Pacific/Auckland', deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' });
await ctx.addInitScript((s) => { localStorage.setItem('paydays.budget.v1', s); }, budget);
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('Page error:', e.message));
if (today) await page.clock.setFixedTime(new Date(`${today}T12:00:00+13:00`));
try {
  await page.goto(url);
} catch {
  console.error(`Nothing at ${url}. Start the app first: npm run dev`);
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(1500);
for (const sel of clicks) {
  try {
    await page.locator(sel).first().click({ timeout: 3000 });
    await page.waitForTimeout(500); // let it open (Collapse animates)
  } catch {
    console.error(`Nothing to click for ${sel}; carrying on.`);
  }
}
if (only) await page.locator(only).first().screenshot({ path: out });
else await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
