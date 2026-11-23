# AGENTS.md — start here

Guide for AI assistants (Claude Code, Cursor, others) working on **Paydays**, a payday-to-payday budget
planner (NZD): React 19 + TypeScript + Vite, no backend. Data lives in the browser and syncs to a private
GitHub repo (`budget-data`). `CLAUDE.md` points here.

## How to work in this repo without reading all of it

1. Read this file. Then find your task in **Where to look** below.
2. Read the `README.md` of that folder only. Every folder in `src/` has one, listing each file and what it does.
3. Open only the files the README points you to. Use search (`grep`) for a name before opening big files.
4. Before changing what a shared function returns, or the words a page shows for it, run
   `npm run uses -- <name>` (or `npm run uses -- engine/envelope.ts` for a whole file). It lists every file
   and line that uses it, so you reach every page that shows it.
5. Don't read `package-lock.json`, `dist/`, `public/ocr/`, or the whole of `core/types.ts` (search it for the type you need).
6. Keep track of what in these notes was wrong, missing or cost you time, and fix it before you finish (see **Keeping the notes short**).

## Folder map

```
src/
  main.tsx      entry: theme, store, App, service worker            (index.html loads it)
  app/          app shell: page routing (#/planner …), nav, the Add button
  core/         data types (types.ts = the saved budget's shape), dates, money, colours, ordering, validation
  engine/       the budget maths: pay periods, cost dates, money put aside, what payday sends (balances/), rebalancing
  state/        the budget store (useBudget), saved daily copies, the pay being viewed
  features/     one folder per page: planner, accounts, debts, savings, insights, settings
                each = page + its pop-ups (*.tsx) and logic/ (pure functions, with tests)
  services/     outside connections: bank (Akahu + CSV), sync (GitHub), reader (Gemini / on-device document reading)
  shared/       budget-aware components used by more than one page
  ui/           design system: shared components, icons, charts, styles/ (tokens + CSS), theme
  testing/      shared test fixtures, and the tests that check these notes
```

Outside `src/`: `public/` (icons, web manifest, `sw.js` service worker; no README there, because everything in
`public/` is published with the site), `scripts/` (dev tools: `uses`, `inspect`, `screenshot`, `live`; its own README),
`.github/workflows/` (`checks.yml` tests every PR; `pages.yml` tests, then deploys `main` to GitHub Pages),
`.claude/settings.json` (runs `scripts/stop-checks.sh` when a Claude Code agent finishes).

## Where to look

Each row names the folder or file to start in; its README has the detail.

| To change… | Start in |
|---|---|
| What's saved (a new field on accounts, debts, goals…) | `core/types.ts` (debts: `core/debtTypes.ts`), then `state/upgrade.ts` → `tidy()`, `core/valid.ts` |
| Renaming a saved field | `core/README.md` → Watch out for |
| Pay periods, paydays, weekend rules, a moved payday | `engine/periods.ts` |
| When a cost falls (weekly, monthly, skip near payday) | `engine/occurrences.ts` |
| Money put aside (WOF) or envelopes (Gas a month, Food a week), what counts against one | `engine/setAside.ts`, `engine/envelope.ts`, `engine/envelopeMatch.ts`; shop kinds: `features/insights/logic/spending.ts` |
| Which bank transaction paid a bill; the Accounts Bill check pop-up | `engine/billMatch.ts`, `features/accounts/logic/billCheck.ts` |
| What payday sends each account (fixed / exact / steady), "allocated this pay" | `engine/balances/` |
| A pay's plan: totals, leftover, what each account needs | `engine/plan.ts` → `planFor()` |
| Automatic balancing, "Balance this pay", rounding, an odd one-pay amount | `engine/rebalance.ts` (`budget.autoBalanced[pay]` says what set it and why) |
| Planner page, Optimise the leftover | `features/planner/` |
| Accounts page, Deposits pop-up, balances, account history | `features/accounts/` |
| Debts: schedules, Gem Visa rules, payments, advice, held debts (Gem in Misc bills) | `features/debts/logic/` (UI: `features/debts/`) |
| A bank-linked card (Gem): its plans, pending purchases, Plan check | `features/debts/logic/README.md`, then `services/bank/README.md` |
| Savings goals, goal costs, gifts, KiwiSaver | `features/savings/` |
| Insights, spending categories, monthly review | `features/insights/` |
| Settings page, export to spreadsheet | `features/settings/` |
| Bank connection (Akahu), CSV exports, card payments seen in the bank | `services/bank/` |
| Sync to the GitHub repo, connect-a-device QR code | `services/sync/` (store side: `state/store.tsx`) |
| Reading documents (payslips, statements, screenshots) | `services/reader/` |
| How things look: colours, spacing, a shared component | `ui/styles/tokens.css`, `ui/components.tsx` |
| Page routing, nav, the Add button | `app/` |
| Saved daily copies, Undo by restoring; how a loaded budget is upgraded | `state/versions.ts`; `state/upgrade.ts` |
| What the owner's real budget shows, and why | `scripts/README.md` (see below) |

## Checking a change against the real budget

Tests use made-up budgets. Most "why does it show X?" questions are answered by the owner's real one, in
`../budget-data` (its README says what each account is for). `scripts/README.md` has the how-to and the gotchas:

- `git -C ../budget-data fetch origin main && git -C ../budget-data checkout -B main origin/main` first: the app saves to `main`.
- `npm run inspect -- <account> --today <NZ date>`: an account as the app sees it. The container's clock is UTC, a day behind NZ until 1pm.
- `npm run dev`, then `npm run screenshot -- '#/accounts' --today <NZ date> --width 400 --dark`: the page as the owner sees it on their phone.
- For a card's plans, the card's own app is the truth: ask the owner for a screenshot and compare plan by plan.

That output is private: never put it in commits, PRs, code, fixtures or notes. A test that copies a real case
uses made-up amounts (`testing/fixtures.ts` → `foodGasBudget()` is shaped like the real Food and gas account).

## Rules the code relies on

- **Money is whole cents** (`Cents` = number). Format with `core/money.ts` (`cash`, `money`); parse typed amounts with `parseMoney`.
- **Dates are `YYYY-MM-DD` strings** (`ISODate`), worked out in UTC by `core/dates.ts`. Use its helpers (`todayISO()`, `addDays()` …), not `Date`, and pass `today` through so tests can fix the date.
- **Every change goes through `useBudget().update(fn)`** (`state/store.tsx`): it clones, runs `fn`, re-balances (`autoBalance`), keeps the day's copy and syncs. Don't mutate the budget anywhere else.
- **Logic is pure and testable.** `engine/`, `core/` and every `logic/` folder take a `Budget` and return values: no React, no storage. Pages (`*.tsx`) call them.
- **Dependencies point inward**: `core` ← `engine` ← `features`/`services` ← `app`. `ui/` knows nothing about budgets.
  `engine` and `features/debts|savings/logic` call each other; don't add new cycles. A page may use a service and a service may use a page's `logic/`.
  `engine/` and `core/` never import a service (`core/types.ts` only borrows the `Payslip` type).
- **One reader per bank format**: own-account transfers via `engine/transfers.ts` → `ownTransfer`; shop categories via `features/insights/logic/spending.ts` → `categorizeTxn`. Don't parse descriptions again.
- **A pay payday has already sent is locked** (`engine/balances/freeze.ts` → `paySplitLocked`). Pages say what it sent ("Payday sent $133 on 19 Nov") and never call it short.
- **Design**: use the tokens and classes in `ui/styles/` and the pieces in `ui/components.tsx`, never new colours or sizes. Green/red only mean "fine"/"short".
  An account's colour is only a small mark by its name. A bar of amounts is `ui/PartsBar.tsx`. Cards are read on a phone: figures and one line per item;
  explanations go behind Details, which sits above what it opens (`ui/README.md`).
- **Privacy**: the Gemini key, GitHub token and bank passphrase stay in the browser's storage only. `src/personal/` (git-ignored) holds the owner's own data and is never committed.
- **Keep files small**: under 400 lines; split by section into files named for their job. A file over 400 may not grow (split it first), and over 500 fails.
  Size counts characters too, so joining lines doesn't make room.
- **Agents copy the code around them.** Leave a file in the shape you'd want copied: if a page does maths inline, move it to `logic/` as you go.

`src/testing/structure.test.ts` checks the folder rules (file size, no React in `core/`/`engine/`/`logic/`, a generic `ui/`, `core/` only borrowing types).
A rule that matters gets a test; a rule only written here drifts. When you find one broken, add a check rather than another sentence.

## Where new code goes

- A calculation on the budget: the page's `logic/` folder, or `engine/` if more than one page needs it. Never inside a component.
- A new screen or pop-up: the page's folder in `features/`. If a second page needs it, move it to `shared/`.
- A generic visual piece (no budget rules): `ui/`, styled with the tokens in `ui/styles/`.
- A new outside connection: its own folder in `services/`, with its settings card.
- A new kind of saved data: `core/types.ts` first (see `core/README.md`).
- A date, money or colour helper: check `core/` first; one probably exists.
- Tests go next to the code (`name.test.ts`), using `src/testing/fixtures.ts`. Never depend on the real date: pass a fixed `today` or use `vi.setSystemTime`.
- Remove code you've replaced instead of leaving it beside the new code.

## Before you finish a change

1. `npm test`, `npx tsc -b` and `npm run lint` pass (lint warnings are OK, errors aren't). In Claude Code a Stop hook runs
   them when you finish and hands back any failure; GitHub runs them on every PR and before every deploy.
2. Every folder you touched has its README updated: new, renamed, moved or deleted files, and changed purposes.
3. Fix the notes in the same change, not a follow-up PR (see **Keeping the notes short**). Tell the owner in a line what you changed in them and why.

## Keeping the notes short (required)

The notes only save time if they're true and quick to read. Every agent reads all of this file, and the README of each folder it works in.
`src/testing/notes.test.ts` fails when a folder has no README, a README doesn't name a file in it, or a note is over its size limit.

- **Put a note where the next agent looks first, once.** This file is a router: only what applies to most tasks. A feature's detail and
  gotchas go in its folder's README; a tool's in `scripts/README.md`. Here, link to them, don't repeat them.
- **A README line per file: what it's for and its main exports.** Not every export or every case: `npm run uses` and `grep` find those.
  Why and what to watch for go under **Watch out for**, one bullet each.
- **Adding means editing.** Before you add a note, find the one it overlaps and rewrite that. A new bullet must earn its place: something
  that cost you time and isn't obvious from the code. Delete what's wrong, out of date, or said elsewhere.
- **Write the rule as it is now, not its history.** No "since", "used to", "was missing" or dates: git keeps the history.
- **When a size limit fails, cut; don't raise the limit.** Shorten the longest lines, drop export lists, move feature detail to its folder.
  Raise a limit only if the owner agrees.
- New folder README:

```md
# <folder>/

One or two sentences: what this folder is for and when you'd come here.

## Files
- `file.ts`: what it does (key exports).

## Watch out for
- The non-obvious rules, gotchas and links to related folders.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
```

## Commands

```bash
npm install        # a fresh session has no node_modules: tsc then fails with "Cannot find module 'react'"
npm run dev        # http://localhost:5173
npm test           # all tests (vitest); one file: npx vitest run src/engine/periods.test.ts
npx tsc -b         # type-check (app code is ES2020: no .at())
npm run lint
npm run build      # production build in dist/ (pushing to main deploys it)
npm run uses -- envelopeHeld   # every file and line that uses a name (or a file's exports)
npm run inspect -- food        # the real budget (../budget-data) as the app sees it, one account
npm run screenshot -- '#/accounts' --today 2026-11-22   # a page with the real budget (needs npm run dev)
npm run live -- parts-tip --wait   # after merging: waits until the published app has that text
```

Edit code with the Edit and Write tools, not a Python or sed heredoc in Bash: a heredoc holding JS (`delete x[k]`, `${…}`) can be refused by Claude Code's removal check.
To check a new test catches the bug, run it with the fix set aside: `git stash push <file>`, run, `git stash pop`.

## Other sessions change `main` too

Several chats work on this repo at once and merge often. Before you edit a shared file (`ui/`, `engine/`), and
again before you push, run `git fetch origin main && git log --oneline HEAD..origin/main --stat`. If main has
moved, merge it in (`git merge origin/main`) and look at the files you both touched, rather than overwriting them.

## Making a change live

The owner asks for changes "live" (or "push live"): push the session branch, open a PR into `main` and merge it.
Wait for the PR's Checks to pass (`checks.yml`): don't merge a red ✗. Merging runs `.github/workflows/pages.yml`, which
runs the checks again and publishes to GitHub Pages in 2–3 minutes (a second merge close behind cancels the first run, which is fine).
Check it with `npm run live -- <text> --wait` in the background (`scripts/README.md` says what text to pick), then
tell the owner to refresh. The app keeps an offline copy (`public/sw.js`), so a phone can take a reopen to update.
