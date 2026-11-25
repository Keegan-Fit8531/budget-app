# scripts/

Node scripts run by `npm` (see `package.json`), not part of the app itself.

`inspect` and `screenshot` show the owner's own money: read the output, but never paste it into commits, PRs,
code or test fixtures (make up the numbers there, as `src/testing/fixtures.ts` does).

## Files
- `uses.mjs`: `npm run uses -- <name>` lists every file and line in `src/` that uses a function, type or field; `npm run uses -- engine/envelope.ts` does it for each thing a file exports. A whole-word search, so a field with the same name shows up too. Tests are listed apart.
- `inspect.ts`: `npm run inspect -- [account] [--today YYYY-MM-DD] [--file path]` prints the real budget (`../budget-data/budget.json` by default) as the app loads and sees it (`src/state/upgrade.ts`, `src/testing/inspect.ts`). Read-only.
- `screenshot.mjs`: `npm run screenshot -- '#/accounts' [--today …] [--file …] [--width 400] [--dark] [--out file.png]` pictures a page of the running dev server (`npm run dev` first) holding the real budget, in NZ time, and prints where it saved it. Options below.
- `live.mjs`: `npm run live -- <text> [--wait]` says whether some text is in the published app's code or stylesheet; `--wait` checks every 10s for up to 8 minutes.
- `stop-checks.sh`: the Stop hook (`.claude/settings.json`): when an agent finishes, runs tests, type-check and lint (about 10s) and hands failures back. Skips when nothing changed since its last pass (`.git/claude-checks-passed`); after 3 blocks in a row it lets the agent stop.
- `copy-ocr.mjs`: copies Tesseract.js and its English data into `public/ocr/` (git-ignored) for the on-device reader. Runs before `npm run dev` and `npm run build`.
- `crawl.mjs`: `npm run crawl -- savings[,planner] [--today …] [--file …|blank] [--width …] [--dark] [--verbose]` clicks everything on a page of the dev server, and in each pop-up it opens, and lists errors, odd text (NaN, undefined) and sideways overflow. Confirm prompts are answered No.

## Reading the real budget
- Match `../budget-data` to GitHub first (`git -C ../budget-data fetch origin main && git -C ../budget-data checkout -B main origin/main`): the app saves to `main`. Not `pull`: the history can be rewritten, so a pull stops ("divergent branches").
  `inspect`'s first line says when that copy was saved: older than the owner's screenshot means the browser has changes the repo hasn't got.
- Give `--today` as the NZ date: this container's clock is UTC, a day behind NZ until 1pm.
- A bill "to come" that's already gone was often paid on the EFTPOS card under a cut-off name ("Paypal *Canv"): look in `inspect -- weekly` for it and its make-up transfer.
- Every save is a commit, so compare saves to see what an upload or tap changed: `git -C ../budget-data show <commit>:budget.json | jq '.debts[] | select(.id=="gem")'`.
  One field across the last saves: `for c in $(git -C ../budget-data log --format=%h -20); do git -C ../budget-data show $c:budget.json | jq -c .billChecks; done`.
- A synced balance already has pending transactions out (don't take them off again), and can be ahead of its transactions (`services/bank/README.md`). A card is the other way round: the bank leaves pending purchases out, and the app adds `Debt.pending` back.
- The tracker's "To come" includes a held debt's payment (Gem) until the bank shows it gone.
- `inspect -- gem` shows a debt's payday account, not its plans: query them with `jq '.debts[]|select(.id=="gem")|{balance,plans,pending,t:.transactions[-20:]}' ../budget-data/budget.json`, or as the app loads it with `_try.ts` (below).
- To see a state the real budget isn't in yet (a card newly linked, a pending payment), make a changed copy in your scratchpad with `jq` and pass it with `--file`.

## Screenshot options
- Look as the owner does, on a phone in dark mode: `--width 400 --dark`.
- `--click <selector>` taps things first. On Accounts (Bill check) and Debts (Plan check) a pop-up covers the page: add `--click 'text="Later"'` (quoted, exact: `text=Later` hits "for later costs" under it).
  It can open after a bank sync, later than the clicks: if it's still there, or "Nothing to click" is printed, run it again.
- Open a card with `--click '.acct:has-text("Rent") >> text=Details'`, and picture only it with `--only '.acct:has-text("Rent")'` (Debts cards are `.acct` too).
  To see a pop-up itself, leave out the click and use `--only '.modal'`; tap an answer with `--click '.check-row:has-text("…") >> text=12 months'`.
- `--hover <selector>` / `--tap <selector>` picture a tip (a bar part). `--click`, `--hover` and `--tap` are repeatable and run in order.
- No sync is set up, so nothing is written back; what shows only with the bank connection (Debts cards' sync buttons) doesn't appear: for that, use a throwaway script that also sets `localStorage['paydays.bank']` to `{ url: 'http://localhost:1/none', key: 'test-key-123456', lastSync: <now> }`.
- For what it can't do (drag, type, check a pop-up stays open), write a throwaway Playwright script in your scratchpad set up the same way (budget in `localStorage`, `timezoneId: 'Pacific/Auckland'`, `page.clock.setFixedTime`), loading Playwright with `createRequire(import.meta.url)('playwright')`.

## Checking a deploy with live
- Built JSX text is split up, and comments are dropped: search a CSS class, a string prop (`sub="…"`), a `localStorage` key or a string from a `.ts` file, exactly as the code has it, or `--wait` runs 8 minutes for nothing.
- It also finds text the old build had, so pick something new to this change, and check the file it names (`assets/index-….js`) differs from before the merge: the same name means the deploy hasn't finished.

## Trying a change on the real budget
To see what an answer or a change would do ("what if Bill check is answered Still to send?"), write a throwaway
`scripts/_try.ts` (vite-node won't load a file outside the repo), run it with `npx vite-node scripts/_try.ts`, then delete it (it prints the owner's money; it's git-ignored, but lint still fails on an `any`):
```ts
import { readFileSync } from 'node:fs';
import { bringUpToDate } from '../src/state/upgrade';
let b = bringUpToDate(JSON.parse(readFileSync('../budget-data/budget.json', 'utf8')));
// change it as the app would (call a check's apply/undo, set a field), then look with a fresh copy:
b = structuredClone(b); // matching results are cached per budget object, so clone after each change
```
Then call what you need (`billTracker`, `billChecks`, `recordCardPayments`…) with a fixed `today`.
For anything a sync changes (`applyBank`), run it twice, then load the result again (`bringUpToDate(JSON.parse(JSON.stringify(b)))`): if the figures move, they'll drift on every sync.
A bank reply for a linked card can be rebuilt from what's saved (`accounts: [{ id, type: 'CREDITCARD', balance: -owed, … }]`, `pending` from `debt.pending`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
