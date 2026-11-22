# scripts/

Node scripts run by `npm` (see `package.json`), not part of the app itself.

`inspect` and `screenshot` show the owner's own money: read the output, but never paste it into commits, PRs,
code or test fixtures (make up the numbers there, as `src/testing/fixtures.ts` does).

## Files
- `uses.mjs`: `npm run uses -- <name>` lists every file and line in `src/` that uses a function, type or field; `npm run uses -- engine/envelope.ts` does it for each thing a file exports. It's a whole-word search, so a field with the same name shows up too. Tests are listed apart.
- `inspect.ts`: `npm run inspect -- [account] [--today YYYY-MM-DD] [--file path]` prints the real budget (`../budget-data/budget.json` by default) the way the app sees it, after the same loading steps (`src/state/upgrade.ts`), using `src/testing/inspect.ts`. Read-only. Run with `vite-node`, so it can use the app's TypeScript.
- `screenshot.mjs`: `npm run screenshot -- '#/accounts' [--today YYYY-MM-DD] [--file path] [--width 400] [--out file.png]` opens the running dev server (`npm run dev` first) in a browser holding the real budget, in New Zealand time, and saves a full-page picture outside the repo (it prints the path). `--click <selector>` (repeatable) taps things first: `'text=Later'` closes the Bill check pop-up that opens by itself on Accounts and covers the page; `'.acct:has-text("Rent") >> text=Details'` opens a card. `--only <selector>` pictures one element (a card); `--dark` uses dark mode, as the owner's phone does; `--width 400` is a phone. `--hover <selector>` points the mouse at something and `--tap <selector>` taps it on a touch screen, to picture a tip (a bar part); all three are repeatable and run in order. No sync is set up there, so nothing is written back, and anything shown only with the bank connection set up (sync buttons on Debts cards) doesn't appear: for that, use a throwaway script that also sets `localStorage['paydays.bank']` to `{ url: 'http://localhost:1/none', key: 'test-key-123456', lastSync: <now> }`. Needs Playwright. For what it can't do (drag, type, check a pop-up stays open), write a throwaway Playwright script in your scratchpad set up the same way (budget in `localStorage`, `timezoneId: 'Pacific/Auckland'`, `page.clock.setFixedTime`), loading Playwright with `createRequire(import.meta.url)('playwright')`: a plain `import` fails outside the repo.
- `live.mjs`: `npm run live -- <text> [--wait]` says whether some text (a CSS class, a string from a `.ts` file) is in the published app's code or stylesheet; `--wait` keeps checking every 10s for up to 8 minutes after a merge.
- `copy-ocr.mjs`: copies the text-recognition engine (Tesseract.js and its English data) from `node_modules` into `public/ocr/` (git-ignored), so the on-device reader (`src/services/reader/documents.ts`) can load it. Runs automatically before `npm run dev` and `npm run build` (`npm run ocr`).

## Trying a change on the real budget
To see what an answer or a change would do ("what if Bill check is answered Still to send?"), write a throwaway
`scripts/_try.ts`, run it with `npx vite-node scripts/_try.ts`, then delete it (it prints the owner's money; `.gitignore` keeps it out of commits, but `npm run lint` still checks it and fails on an `any`):
```ts
import { readFileSync } from 'node:fs';
import { bringUpToDate } from '../src/state/upgrade';
let b = bringUpToDate(JSON.parse(readFileSync('../budget-data/budget.json', 'utf8')));
// change it as the app would (call a check's apply/undo, set a field), then look with a fresh copy:
b = structuredClone(b); // matching results are cached per budget object, so clone after each change
```
Then call what you need (`billTracker`, `billChecks`, `recordCardPayments`…) with a fixed `today`.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
