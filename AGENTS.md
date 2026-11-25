# AGENTS.md — start here

Guide for AI assistants (Claude Code, Cursor, others) working on **Paydays**, a payday-to-payday budget
planner (NZD): React 19 + TypeScript + Vite, no backend. Data lives in the browser and syncs to a private
GitHub repo (`budget-data`). `CLAUDE.md` points here.

## How to work in this repo without reading all of it

1. Read this file. Then find your task in **Where to look** below.
2. Read the `README.md` of that folder only. Every folder in `src/` has one, listing each file and what it does.
3. Open only the files the README points you to. Use search (`grep`) for a name before opening big files.
4. Before changing what a shared function returns, or the words a page shows for it, run `npm run uses -- <name>`
   (or `-- engine/envelope.ts` for a whole file): every file and line that uses it, so you reach every page.
5. Don't read `package-lock.json`, `dist/`, `public/ocr/`, or the whole of `core/types.ts` (search it for the type you need).
6. Keep track of what in these notes was wrong, missing or cost you time, and fix it before you finish.

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

Outside `src/`: `public/` (icons, manifest, `sw.js`; no README, as all of it is published), `scripts/` (dev tools, own README),
`.github/workflows/` (`checks.yml` tests every PR; `pages.yml` tests, then deploys `main`), `.claude/settings.json` (the Stop hook).

## Where to look

Each row names the folder or file to start in; its README has the detail.

| To change… | Start in |
|---|---|
| What's saved (a new or renamed field) | `core/types.ts` (debts: `core/debtTypes.ts`), `state/upgrade.ts` → `tidy()`, `core/valid.ts`; `core/README.md` |
| Pay periods, paydays, weekend rules, a moved payday | `engine/periods.ts` |
| When a cost falls (weekly, monthly, skip near payday) | `engine/occurrences.ts` |
| Money put aside (WOF), envelopes (Gas, Food) and what counts against one | `engine/setAside.ts`, `engine/envelope.ts`, `engine/envelopeMatch.ts` |
| Which bank transaction paid a bill; the Accounts Bill check pop-up | `engine/billMatch.ts`, `features/accounts/logic/billCheck.ts` |
| What payday sends each account (fixed / exact / steady), "allocated this pay", a Steady account's Buffer | `engine/balances/` |
| A pay's plan: totals, leftover, what each account needs | `engine/plan.ts` → `planFor()` |
| Automatic balancing, "Balance this pay", rounding, an odd one-pay amount | `engine/rebalance.ts` (`budget.autoBalanced[pay]` says what set it and why) |
| Planner page, Optimise the leftover | `features/planner/` |
| Accounts page, Deposits pop-up, balances, account history | `features/accounts/` |
| Debts: schedules, payments, advice | `features/debts/logic/` (UI: `features/debts/`) |
| Gem Visa's rules, its plans, Plan check; a debt held in Misc bills | `features/debts/logic/gem/`, `features/debts/logic/held/`; a bank-linked card: `services/bank/` |
| Savings goals, goal costs, gifts, KiwiSaver | `features/savings/` |
| Insights, spending categories, monthly review | `features/insights/` |
| Settings page, export to spreadsheet | `features/settings/` |
| Bank connection (Akahu), CSV exports, card payments seen in the bank | `services/bank/` |
| Sync to the GitHub repo, connect-a-device QR code | `services/sync/` (store side: `state/store.tsx`) |
| Reading documents (payslips, statements, screenshots) | `services/reader/` |
| How things look: colours, spacing, a shared component | `ui/styles/tokens.css`, `ui/components.tsx` |
| Page routing, nav, the Add button | `app/` |
| Saved daily copies, Undo by restoring; how a loaded budget is upgraded | `state/versions.ts`; `state/upgrade.ts` |

## Checking a change against the real budget

Most "why does it show X?" questions are answered by the owner's real budget in `../budget-data` (its README says what
each account is for). `scripts/README.md` has the how-to and gotchas:

- `git -C ../budget-data fetch origin main && git -C ../budget-data checkout -B main origin/main` first: the app saves to `main`.
- `npm run inspect -- <account> --today <NZ date>`: an account as the app sees it. The container's clock is UTC, a day behind NZ until 1pm.
  Any other figure (old vs new numbers across pays): a throwaway `scripts/_try.ts` (`scripts/README.md`).
- `npm run dev`, then `npm run screenshot -- '#/accounts' --today <NZ date> --width 400 --dark`: the page as the owner sees it on their phone;
  `npm run crawl -- planner` clicks every button and pop-up on a page and reports crashes and broken text. Don't edit code while either runs.
- For a card's plans, the card's own app is the truth: ask the owner for a screenshot and compare plan by plan.

That output is private: never put it in commits, PRs, code, fixtures or notes. Tests use made-up amounts (`testing/fixtures.ts`:
`foodGasBudget()` and `heldGemBudget()` are shaped like the real Food and gas and Misc bills accounts).

## Rules the code relies on

- **Money is whole cents** (`Cents` = number). Format with `core/money.ts` (`cash`, `money`); parse typed amounts with `parseMoney`.
- **Dates are `YYYY-MM-DD` strings** (`ISODate`), worked out in UTC by `core/dates.ts`. Use its helpers (`todayISO()`, `addDays()` …), not `Date`, and pass `today` through so tests can fix the date.
- **Every change goes through `useBudget().update(fn)`** (`state/store.tsx`): it clones, runs `fn`, re-balances, keeps the day's copy and syncs. Don't mutate the budget anywhere else.
  The engine caches per budget object: give it the store's own `budget`, never a copy made while drawing, or every tap works it all out again.
- **Logic is pure and testable.** `engine/`, `core/` and every `logic/` folder take a `Budget` and return values: no React, no storage.
- **Dependencies point inward**: `core` ← `engine` ← `features`/`services` ← `app`. `ui/` knows nothing about budgets.
  `engine` and `features/debts|savings/logic` call each other; don't add new cycles. A page may use a service and a service may use a page's `logic/`.
  `engine/` and `core/` never import a service (`core/types.ts` borrows a type).
- **One reader per bank format**: own-account transfers via `engine/transfers.ts` → `ownTransfer`; shop categories via `features/insights/logic/spending.ts` → `categorizeTxn`. Don't parse descriptions again.
- **A pay payday has already sent is locked** (`engine/balances/freeze.ts`). Pages say what it sent ("Payday sent $133 on 19 Nov"), never short.
- **Design**: use the tokens and classes in `ui/styles/` and the pieces in `ui/components.tsx` (every pop-up is its `Modal`), never new colours or sizes. Green/red only mean "fine"/"short".
  An account's colour is only a small mark by its name. A bar of amounts is `ui/PartsBar.tsx`. Cards are read on a phone: figures and one line per item;
  explanations go behind Details, which sits above what it opens (`ui/README.md`).
- **Privacy**: keys, tokens and the bank passphrase stay in the browser's storage only. `src/personal/` (git-ignored, the owner's data) is never committed.
- **Keep files small**: under 400 lines; split by section into files named for their job. A file over 400 may not grow (split it first), and over 500 fails.
  Size counts characters too, so joining lines doesn't make room.
- **Agents copy the code around them.** Leave a file in the shape you'd want copied: if a page does maths inline, move it to `logic/` as you go.
  A rule with two halves in two files (where an amount is stored, where it's read) keeps both comments true: `grep` the other half when you change one.

`src/testing/structure.test.ts` checks the folder rules (file size, no React in `core/`/`engine/`/`logic/`, a generic `ui/`, `core/` only borrowing types, `Modal`).
A rule that matters gets a test; a rule only written here drifts. When you find one broken, add a check rather than another sentence.

## Where new code goes

- A calculation on the budget: the page's `logic/` folder, or `engine/` if more than one page needs it. Never inside a component.
- A new screen or pop-up: the page's folder in `features/`. If a second page needs it, move it to `shared/`.
- A generic visual piece (no budget rules): `ui/`, styled with the tokens in `ui/styles/`.
- A new outside connection: its own folder in `services/`, with its settings card.
- A new kind of saved data: `core/types.ts` first (see `core/README.md`).
- A date, money or colour helper: one is probably in `core/` already.
- Tests go next to the code (`name.test.ts`), using `src/testing/fixtures.ts`, with a fixed `today` (or `vi.setSystemTime`).
- Remove code you've replaced instead of leaving it beside the new code.

## Before you finish a change

1. `npm test`, `npx tsc -b` and `npm run lint` pass (lint warnings are OK, errors aren't). A Stop hook runs them when you
   finish; GitHub runs them on every PR and before every deploy.
2. Every folder you touched has its README updated: new, renamed, moved or deleted files, and changed purposes.
3. Fix the notes in the same change (see **Keeping the notes short**), and tell the owner in a line what you changed in them and why.
   If you shortened a note, say what it lost.

## Keeping the notes short (required)

The notes only save time if they're true and quick to read: every agent reads all of this file and its folders' READMEs.
`src/testing/notes.test.ts` fails when a folder has no README, a README misses a file in it, or a note is over its size limit.

- **Put a note where the next agent looks first, once.** This file is a router: only what applies to most tasks. A feature's
  detail goes in its folder's README, a tool's in `scripts/README.md`; link to them here.
- **A README line per file: what it's for and its main exports.** Not every export or every case: `npm run uses` and `grep` find those.
  Why and what to watch for go under **Watch out for**, one bullet each.
- **Adding means editing.** Before you add a note, find the one it overlaps and rewrite that. A new bullet must earn its place: something
  that cost you time and isn't obvious from the code. Delete what's wrong, out of date, or said elsewhere.
- **Write the rule as it is now, not its history.** No "since", "used to", "was missing" or dates: git keeps the history.
- **When a note doesn't fit, in this order:** (1) delete notes that are wrong, out of date, said twice, or enforced by a test
  (its failure message explains them); (2) move a note most tasks don't need down a level: AGENTS.md → a folder README → a comment
  by the code; (3) split a folder whose README is full by purpose (`features/debts/logic/gem/`, `held/`), each with its own README;
  (4) only then tighten wording. A note always keeps its rule, when it applies, and why (the consequence or one example):
  a rule with no reason gets ignored or misapplied. Raise a limit only if the owner agrees.
- A new folder needs a README: `notes.test.ts` shows the shape when it's missing.

## Commands

```bash
npm install        # a fresh session has none: tsc fails with "Cannot find module 'react'"
npm run dev        # http://localhost:5173
npm test           # all tests; one file: npx vitest run src/engine/periods.test.ts
npx tsc -b         # type-check (app code is ES2020: no .at())
npm run lint
npm run build      # production build in dist/ (pushing to main deploys it)
npm run uses -- envelopeHeld   # every file and line that uses a name (or a file's exports)
npm run inspect -- food        # the real budget (../budget-data) as the app sees it, one account
npm run screenshot -- '#/accounts' --today 2026-11-22   # a page with the real budget (needs npm run dev)
npm run crawl -- savings --today 2026-11-22   # click everything on a page, report crashes (needs npm run dev)
npm run live -- parts-tip --wait   # after merging: waits until the published app has that text
```

Edit code with the Edit and Write tools, not a Python or sed heredoc in Bash: a heredoc holding JS (`delete x[k]`, `${…}`) can be refused by Claude Code's removal check.
To check a new test catches the bug, run it with the fix set aside: `git stash push <file>`, run, `git stash pop`.

## Other sessions change `main` too

Several chats merge often. Before you edit a shared file (`ui/`, `engine/`), and before you push, run
`git fetch origin main && git log --oneline HEAD..origin/main --stat`; if main moved, `git merge origin/main` and check the files you both touched.

## Making a change live

The owner asks for changes "live" (or "push live"): push the session branch, open a PR into `main`, wait for its Checks
(never merge a red ✗) and merge it. `pages.yml` checks again and publishes in 2–3 minutes. Check it with
`npm run live -- <text> --wait` in the background (`scripts/README.md`), then tell the owner to refresh (a phone can need a reopen: `public/sw.js`).
