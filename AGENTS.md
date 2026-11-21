# AGENTS.md — start here

Guide for AI assistants (Claude Code, Cursor, others) working on **Paydays**, a payday-to-payday budget
planner (NZD): React 19 + TypeScript + Vite, no backend. Data lives in the browser and syncs to a private
GitHub repo (`budget-data`). `CLAUDE.md` points here.

## How to work in this repo without reading all of it

1. Read this file. Then find your task in **Where to look** below.
2. Read the `README.md` of that folder only. Every folder in `src/` has one, listing each file and what it does.
3. Open only the files the README points you to. Use search (`grep`) for a name before opening big files.
4. Don't read `package-lock.json`, `dist/`, `public/ocr/`, or the whole of `core/types.ts` (search it for the type you need).

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
  testing/      shared test fixtures, and the test that checks these READMEs
```

Outside `src/`: `public/` (icons, web manifest, `sw.js` service worker; no README there, because everything in
`public/` is published with the site), `scripts/` (`copy-ocr.mjs` copies the OCR engine into `public/ocr/`
before dev/build), `.github/workflows/pages.yml` (deploys `main` to GitHub Pages).

## Where to look

| To change… | Start in |
|---|---|
| What's saved (a new field on accounts, debts, goals…) | `core/types.ts`, then `state/store.tsx` → `tidy()` for older saves, `core/valid.ts` |
| Pay periods, paydays, weekend rules, a moved payday | `engine/periods.ts` |
| When a cost falls (weekly, monthly, skip near payday) | `engine/occurrences.ts` |
| Money put aside (WOF, tyres) or month envelopes (Gas) | `engine/setAside.ts`, `engine/envelope.ts` |
| What payday sends each account (fixed / exact / steady) | `engine/balances/` (README lists which file does what) |
| A pay's plan: totals, leftover, what each account needs | `engine/plan.ts` → `planFor()` |
| Automatic balancing, "Balance this pay" | `engine/rebalance.ts` |
| Planner page, Optimise the leftover | `features/planner/` |
| Accounts page, Deposits pop-up, balances, account history | `features/accounts/` |
| Debts: schedules, Gem Visa rules, payments, advice | `features/debts/logic/` (UI in `features/debts/`) |
| Savings goals, goal costs, gifts, KiwiSaver | `features/savings/` |
| Insights, spending categories, monthly review | `features/insights/` |
| Settings page, export to spreadsheet | `features/settings/` |
| Bank connection (Akahu), CSV exports, card payments seen in the bank | `services/bank/` |
| Sync to the GitHub repo, connect-a-device QR code | `services/sync/` (store side: `state/store.tsx`) |
| Reading documents (payslips, statements, screenshots) | `services/reader/` → `check/` (checks), `apply.ts` (changes), `ui/` (screens) |
| How things look: colours, spacing, a shared component | `ui/styles/tokens.css`, `ui/components.tsx` |
| Page routing, nav, the Add button | `app/` |
| Saved daily copies, Undo by restoring | `state/versions.ts` |

## Rules the code relies on

- **Money is whole cents** (`Cents` = number). Format with `core/money.ts` (`cash`, `money`); parse typed amounts with `parseMoney`.
- **Dates are `YYYY-MM-DD` strings** (`ISODate`), worked out in UTC by `core/dates.ts`. Do date maths with its helpers (`todayISO()`, `addDays()`, `diffDays()` …), not with `Date` directly, and pass `today` through so tests can fix the date.
- **Every change goes through `useBudget().update(fn)`** (`state/store.tsx`): it clones the budget, runs your `fn`, re-balances upcoming pays (`autoBalance`), keeps the day's saved copy and syncs. Don't mutate the budget anywhere else.
- **Logic is pure and testable.** `engine/`, `core/` and every `logic/` folder take a `Budget` and return values. No React and no storage there. Pages (`*.tsx`) call them.
- **Dependencies point inward**: `core` ← `engine` ← `features`/`services` ← `app`. `ui/` knows nothing about budgets. (`engine` and `features/debts|savings/logic` call each other; don't add new cycles.)
- **Design**: use the tokens and classes in `ui/styles/` and the pieces in `ui/components.tsx`, never new colours or sizes. Green/red only ever mean "fine"/"short". An account's colour is only a small mark beside its name.
- **Privacy**: the Gemini key, GitHub token and bank passphrase stay in the browser's storage only, never in the budget, the repo or the code. `src/personal/` (git-ignored) holds the owner's own data and is never committed.
- **Keep files small**: aim for under ~400 lines. When one grows past that, split it by its sections into files named for their job, and update the README.

## Commands

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # all tests (vitest); tests sit next to the code as *.test.ts
npx tsc -b         # type-check
npm run lint
npm run build      # production build in dist/ (pushing to main deploys it)
```

Run one test file with `npx vitest run src/engine/periods.test.ts`. Test budgets and helpers are in `src/testing/fixtures.ts`.

## Keeping the READMEs current (required)

The READMEs only save time if they're true. Treat them as part of the code:

- **Every change that adds, removes, renames or moves a file, or changes what a file is for, updates that folder's `README.md` in the same commit.** A new folder gets its own `README.md`.
- If a change adds a new "where do I go for X", add a row to **Where to look** above. If it changes a rule in **Rules the code relies on**, update that too.
- `src/testing/readmes.test.ts` fails when a folder has no README, or a README doesn't mention a file or folder in it. `npm test` must pass.
- Keep READMEs short and factual: what the folder is for, one line per file, what to watch out for. Don't paste code.

New folder README template:

```md
# <folder>/

One or two sentences: what this folder is for and when you'd come here.

## Files
- `file.ts`: what it does (key exports).

## Watch out for
- The non-obvious rules, gotchas and links to related folders.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
```
