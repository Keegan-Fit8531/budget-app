// Is a change live? Looks for some text in the published app's code and stylesheet.
//   npm run live -- parts-tip            once: found or not
//   npm run live -- parts-tip --wait     after merging to main: checks every 10s for up to 8 minutes
// Search for a CSS class you added, or a string built in a .ts file. Text written in JSX is split up when
// built, so a sentence from a page usually isn't found. Exits 1 if it isn't there (yet).
const SITE = 'https://keegan-fit8531.github.io/budget-app/';
const args = process.argv.slice(2);
const wait = args.includes('--wait');
const text = args.find((a) => !a.startsWith('--'));
if (!text) {
  console.error('Usage: npm run live -- <text to find> [--wait]');
  process.exit(2);
}

/** The published code and stylesheet files, read fresh (not from a cache). */
async function found() {
  const page = await (await fetch(`${SITE}?t=${Date.now()}`, { cache: 'no-store' })).text();
  const files = [...new Set(page.match(/assets\/index-[^"']+\.(?:js|css)/g) ?? [])];
  for (const f of files) {
    if ((await (await fetch(SITE + f)).text()).includes(text)) return f;
  }
  return undefined;
}

const until = Date.now() + 8 * 60 * 1000;
for (;;) {
  let f;
  try { f = await found(); } catch (e) { console.error(`Couldn't reach ${SITE}: ${e.message}`); }
  if (f) {
    console.log(`Live: "${text}" is in ${f}. Tell the owner to refresh (on a phone, close and reopen the app).`);
    process.exit(0);
  }
  if (!wait || Date.now() > until) {
    console.log(`Not live${wait ? ' after 8 minutes' : ''}: "${text}" isn't in the published app.${wait ? ' Check the Pages run in the repo\'s Actions tab.' : ' Add --wait to keep checking.'}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 10000));
}
