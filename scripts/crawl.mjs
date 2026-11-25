// Click everything on a page of the running dev server and report what breaks: page errors, console errors, a
// page that couldn't be shown, odd text (NaN, undefined, Infinity, [object Object], Invalid Date, "$-5") and
// anything sticking out sideways at the width given. Every button, tab and in-app link on the page is clicked,
// and every pop-up a click opens is crawled the same way (two levels deep), then closed.
//   npm run dev                                          (in another terminal first)
//   npm run crawl -- savings                             one page with the real budget, at phone width
//   npm run crawl -- planner,accounts --today 2026-11-22 --dark
//   npm run crawl -- debts --file other.json --width 1100 --verbose   (--verbose lists every click)
//   --max <n> stops after n clicks a page (default 400). --file blank starts from a blank budget.
// Confirm prompts ("Remove …?") are answered No, so nothing is deleted. Each page starts from the budget file again,
// and no sync is set up, so nothing is written back to the repo. Its findings can quote the owner's money: read
// them, don't paste them into commits, PRs or code. Don't edit code while it runs (hot reload breaks the open page).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const file = opt('--file', '../budget-data/budget.json');
const today = opt('--today');
const width = Number(opt('--width', '400'));
const maxClicks = Number(opt('--max', '400'));
const port = opt('--port', '5173');
const dark = args.includes('--dark');
const verbose = args.includes('--verbose');
const routes = (args.find((a) => !a.startsWith('--')) ?? 'planner,accounts,debts,savings,insights,settings')
  .split(',').map((r) => r.replace(/^#?\/?/, ''));

let playwright;
try {
  playwright = createRequire(import.meta.url)('playwright');
} catch {
  console.error('Playwright is not installed: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}
const budget = file === 'blank' ? null : readFileSync(resolve(file), 'utf8');

const ODD = [/\bNaN\b/, /\bundefined\b/, /\bInfinity\b/, /\[object Object\]/, /Invalid Date/, /\$-\d/, /-\$\d/, /\bnull\b/];
// Not clicked: what reloads, wipes or connects things, picks files, or only reorders (it hides the cards' own buttons).
const SKIP = /^(Reorder|Move .* (up|down)|Reload the app|Start over|Disconnect|Restore|Sync now|Connect|Upload|Read on this device|Download|Export)/i;
const findings = [];
const note = (route, where, msg) => {
  const f = `[${route}] ${where}: ${msg}`;
  if (!findings.includes(f)) { findings.push(f); console.log(f); }
};

/** Odd text, an error message in place of the page, and anything sticking out past the right edge. */
async function scan(page, route, where, root = 'body') {
  const res = await page.evaluate((sel) => {
    const el = document.querySelector(sel) ?? document.body;
    const wide = [];
    for (const e of el.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      if (!r.width || r.right <= window.innerWidth + 2) continue;
      let clipped = false;
      for (let p = e.parentElement; p && !clipped; p = p.parentElement) clipped = /(hidden|auto|scroll|clip)/.test(getComputedStyle(p).overflowX);
      if (!clipped) wide.push(`<${e.tagName.toLowerCase()} class="${e.className}"> "${(e.innerText || '').slice(0, 40).replace(/\s+/g, ' ')}"`);
    }
    return {
      text: el.innerText,
      over: Math.max(0, document.documentElement.scrollWidth - window.innerWidth - 1),
      wide: wide.slice(0, 3),
      alerts: [...document.querySelectorAll('[role=alert]')].map((a) => a.innerText.slice(0, 300)),
    };
  }, root).catch(() => null); // the page moved on mid-scan
  if (!res) return;
  for (const re of ODD) {
    const m = res.text.match(new RegExp(`.{0,50}${re.source}.{0,50}`));
    if (m) note(route, where, `odd text: "${m[0].replace(/\s+/g, ' ')}"`);
  }
  if (res.over) note(route, where, `the page scrolls sideways by ${res.over}px`);
  for (const w of res.wide) note(route, where, `sticks out: ${w}`);
  for (const a of res.alerts) if (/couldn.t be shown|went wrong/i.test(a)) note(route, where, `SHOWN AN ERROR: ${a.replace(/\s+/g, ' ')}`);
}

const labelOf = (loc) => loc.evaluate((e) => (e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || e.tagName)
  .trim().replace(/\s+/g, ' ').slice(0, 50)).catch(() => '?');
const modals = (page) => page.locator('.modal').count();

/** Close pop-ups until only `keep` are left: Escape, then their Close button. */
async function closeTo(page, keep) {
  for (let i = 0; i < 6 && (await modals(page)) > keep; i++) {
    const n = await modals(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if ((await modals(page)) === n) {
      await page.locator('.modal [aria-label=Close]').last().click({ timeout: 800 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

/** Click each thing in `scope` once (by its place in the list, as the page changes under it). */
async function clickAll(page, route, scope, where, depth, budgetLeft) {
  const sel = ['button', 'summary', '[role=tab]', 'a[href^="#"]'].map((s) => `${scope} ${s}:visible`).join(', ');
  const seen = new Set();
  let clicks = 0;
  for (let i = 0; i < 300 && clicks < budgetLeft; i++) {
    const all = page.locator(sel);
    if (i >= (await all.count())) break;
    const el = all.nth(i);
    const name = await labelOf(el);
    if (seen.has(`${name}#${i}`) || SKIP.test(name) || /^(Close|Cancel)$/.test(name)) continue;
    seen.add(`${name}#${i}`);
    // The menus' links go to other pages (crawled on their own); their Add button is crawled here.
    if (depth === 0 && (await el.evaluate((e) => e.tagName === 'A' && !!e.closest('nav, .mobile-top')))) continue;
    const before = await modals(page);
    const hash = await page.evaluate(() => location.hash);
    try {
      await el.click({ timeout: 3000 });
    } catch (e) {
      if (verbose) console.log(`${'  '.repeat(depth + 1)}couldn't click ${name}: ${String(e.message).split('\n')[0]}`);
      continue;
    }
    clicks++;
    if (verbose) console.log(`${'  '.repeat(depth + 1)}click ${name}`);
    await page.waitForTimeout(300);
    if ((await modals(page)) > before) {
      const title = await page.locator('.modal .h2').last().innerText().catch(() => '?');
      const w = `${where} → "${name}" → pop-up "${title}"`;
      await scan(page, route, w, '.modal:last-of-type');
      if (depth < 2) {
        const id = `qa${depth}`;
        await page.locator('.modal').last().evaluate((m, x) => m.setAttribute('data-crawl', x), id);
        clicks += await clickAll(page, route, `.modal[data-crawl=${id}]`, w, depth + 1, Math.min(60, budgetLeft - clicks));
      }
      await closeTo(page, before);
    } else {
      await scan(page, route, `${where} → "${name}"`);
    }
    if (depth > 0 && !(await page.locator(scope).count())) return clicks; // the pop-up closed itself (Save)
    if (depth === 0 && (await page.evaluate(() => location.hash)) !== hash) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(300);
    }
  }
  return clicks;
}

const browser = await playwright.chromium.launch();
let total = 0;
for (const route of routes) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Pacific/Auckland', colorScheme: dark ? 'dark' : 'light' });
  // The budget goes in once per page; reloads after that keep what the clicks changed.
  await ctx.addInitScript((s) => {
    if (sessionStorage.getItem('crawl')) return;
    sessionStorage.setItem('crawl', '1');
    localStorage.clear();
    if (s) localStorage.setItem('paydays.budget.v1', s);
  }, budget);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => note(route, 'page', `PAGE ERROR: ${e.message.split('\n')[0]}`));
  page.on('console', (m) => { if (m.type() === 'error') note(route, 'console', `console.error: ${m.text().split('\n')[0].slice(0, 300)}`); });
  page.on('dialog', (d) => { if (verbose) console.log(`  answered No: ${d.message().slice(0, 100)}`); d.dismiss().catch(() => {}); });
  if (today) await page.clock.setFixedTime(new Date(`${today}T09:00:00+13:00`));
  try {
    await page.goto(`http://localhost:${port}/#/${route}`);
  } catch {
    console.error(`Nothing at http://localhost:${port}. Start the app first: npm run dev`);
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(2000);
  // Bill check and Plan check open by themselves after a sync: crawl them, then close them.
  if (await modals(page)) {
    await scan(page, route, 'pop-up open on load', '.modal');
    await closeTo(page, 0);
  }
  await scan(page, route, 'on load');
  const n = await clickAll(page, route, '.app', 'page', 0, maxClicks);
  total += n;
  console.log(`[${route}] ${n} clicks`);
  await ctx.close();
}
await browser.close();
console.log(`${total} clicks, ${findings.length} finding${findings.length === 1 ? '' : 's'}.`);
process.exit(findings.length ? 1 : 0);
