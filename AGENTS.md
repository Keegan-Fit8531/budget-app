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
   and line that uses it, so you reach every page that shows it. The READMEs say what a file does, not
   who uses it: the script answers that from the code, so it's never out of date.
5. Don't read `package-lock.json`, `dist/`, `public/ocr/`, or the whole of `core/types.ts` (search it for the type you need).
6. **Every change also improves these notes** (this file and the READMEs). As you work, keep track of what
   was wrong, missing or cost you time. Fix it before you finish (see **Before you finish a change**, step 4).

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
| What's saved (a new field on accounts, debts, goals…) | `core/types.ts`, then `state/upgrade.ts` → `tidy()` for older saves, `core/valid.ts` |
| Pay periods, paydays, weekend rules, a moved payday | `engine/periods.ts` |
| When a cost falls (weekly, monthly, skip near payday) | `engine/occurrences.ts` |
| Money put aside (WOF, tyres) or envelopes (Gas a month, Food a week) | `engine/setAside.ts`, `engine/envelope.ts`; what counts against one (purchases, transfers that paid for one): `engine/envelopeMatch.ts`; a shop counted as the wrong kind (a fuel station as food): the shop rules in `features/insights/logic/spending.ts` (`FUEL_SHOPS`); Accounts card: `features/accounts/EnvelopeCards.tsx` |
| A card linked to the bank (Gem Visa through Akahu): linking it, its pending purchases (owed too), plans read from its transactions, payments Pending vs Received, plan progress, payday history, a statement's amount to avoid interest; Plan check (asks the plan of a big purchase the bank can't say) | `services/bank/bank.ts` → `newCardLinks`, `applyBank`; `features/debts/logic/cardPlans.ts`, `activity.ts`, `planCheck.ts` (pop-up: `features/debts/PlanCheck.tsx`); card: `features/debts/DebtPlans.tsx`, `DebtActivity.tsx`; what the bank server sends: `services/bank/README.md` |
| Which bank transaction paid a bill (card on another account, made-up transfers), bills not seen, a held debt (Gem) paid from another account; the Accounts bill check pop-up | `engine/billMatch.ts`; suggestions: `features/accounts/logic/billCheck.ts`; pop-up: `features/accounts/BillCheck.tsx` |
| What payday sends each account (fixed / exact / steady); "allocated this pay" (what it sent this pay: `depositFor`) | `engine/balances/` (README lists which file does what) |
| A pay's plan: totals, leftover, what each account needs | `engine/plan.ts` → `planFor()` |
| Automatic balancing, "Balance this pay"; an odd one-pay amount (a Steady account sending more than usual for one pay: `budget.autoBalanced[pay]` says what set it and why) | `engine/rebalance.ts` |
| Rounding what payday sends (whole dollars, $50): `Account.round`, set in Deposits | balancing: `engine/rebalance.ts` → `step`; Steady: `engine/balances/steady.ts` → `steadyStep` |
| Planner page, Optimise the leftover | `features/planner/` |
| Accounts page, Deposits pop-up, balances, account history | `features/accounts/` |
| Debts: schedules, Gem Visa rules, payments, advice | `features/debts/logic/` (UI in `features/debts/`) |
| A statement or typed balance vs the plans (plans too high, finished plans) | `features/debts/logic/payments.ts` → `fitPlansToBalance`, called from `services/reader/apply.ts` → `applyStatement` |
| A debt's payment held in a bank account until statement day (Gem in Misc bills: `Debt.holdAccountId`); paid in part, "No more this month" | `features/debts/logic/README.md` → **Held debts** (how the money flows, file by file); the card's Payday section: `features/debts/DebtPayday.tsx` |
| Savings goals, goal costs, gifts, KiwiSaver | `features/savings/` |
| Insights, spending categories, monthly review | `features/insights/` |
| Settings page, export to spreadsheet | `features/settings/` |
| Bank connection (Akahu), CSV exports, card payments seen in the bank | `services/bank/` |
| Sync to the GitHub repo, connect-a-device QR code | `services/sync/` (store side: `state/store.tsx`) |
| Reading documents (payslips, statements, screenshots) | `services/reader/` → `check/` (checks), `apply.ts` (changes), `ui/` (screens) |
| How things look: colours, spacing, a shared component | `ui/styles/tokens.css`, `ui/components.tsx` |
| Page routing, nav, the Add button | `app/` |
| Saved daily copies, Undo by restoring | `state/versions.ts` |
| Every page that uses a function, type or file | `npm run uses -- <name or src-relative file>` |
| What the owner's real budget shows, and why | `npm run inspect` / `npm run screenshot` (see **Checking a change against the real budget**) |
| How a loaded budget is upgraded (older saves, one-off fixes) | `state/upgrade.ts` → `tidy()`, `bringUpToDate()` |
| Renaming a saved field | `core/types.ts` (keep the old one, marked "Older saves"), `state/upgrade.ts` → `tidy()` converts it |

## Checking a change against the real budget

Tests use made-up budgets. To see what a change does to the owner's real one (most "why does it show X?"
questions are answered there):

1. Get the latest copy. The app saves to **`main`** of `budget-data`, so if that repo is checked out next to
   this one, run `git -C ../budget-data checkout main && git -C ../budget-data pull` (a session branch there is
   usually older). Its README says how the owner's accounts are used (which one is the EFTPOS card, what each
   holds) and how to query `budget.json` without reading all of it. Every save is a commit, so to see what an
   upload or tap changed, compare saves: `git -C ../budget-data show <commit>:budget.json | jq '.debts[] | select(.id=="gem")'`.
   To see what the owner tapped, one field across saves: `for c in $(git -C ../budget-data log --format=%h -20); do git -C ../budget-data show $c:budget.json | jq -c .billChecks; done`.
2. `npm run inspect` (every account) or `npm run inspect -- food --today 2026-11-22` (one account in detail; give `--today`
   as the NZ date: this container's clock is UTC, a day behind NZ until 1pm):
   the tracker (each bill paid or to come, and the bank transaction that paid it), what Bill check asks, envelopes and what counted against them (each transfer with the purchase it was matched to), transfers the card asks about, next pays and any
   Steady buffer, and the last 14 days of transactions with what each counted as. It loads the budget the
   way the app does (`state/upgrade.ts`). The first line says when that copy was saved: if it's older than
   the owner's screenshot, the browser has changes the repo hasn't got yet. A bank-synced account balance already has
   pending transactions taken out (they're marked `[pending]`), so don't take them off again; a card's is the other way
   round (the bank leaves pending purchases out, the app adds `Debt.pending` back). For a debt, `inspect -- gem` shows
   its payday account, not its plans: query it in `../budget-data` with `jq '.debts[]|select(.id=="gem")|{balance,plans,pending,t:.transactions[-20:]}' budget.json`
   (as saved), or as the app loads it with a `scripts/_try.ts` (step 5). For "is X counted?"
   questions, add up the tracker rows yourself: "To come" includes a held debt's payment (Gem) until the bank
   shows it gone.
3. `npm run dev`, then `npm run screenshot -- '#/accounts' --today 2026-11-22` to see the page itself, in New
   Zealand time. (A browser left on UTC is on yesterday's date until 1pm in NZ, which changes what's shown.)
   The owner uses a phone in dark mode, so for a layout change look as they do: `--width 400 --dark`. On
   Accounts the Bill check pop-up, and on Debts the Plan check one, opens by itself and covers the page: add `--click 'text=Later'` (it can open after
   a bank sync, later than the clicks: if it's still there, or "Nothing to click" is printed, run it again). Open a card
   with `--click '.acct:has-text("Rent") >> text=Details'`, and picture just it with `--only '.acct:has-text("Rent")'` (Debts cards are `.acct` too: `'#/debts'`, `.acct:has-text("Gem Visa")`)
   (see `scripts/README.md`). To see either pop-up itself, leave out the click and use `--only '.modal'` (tap an answer with `--click '.check-row:has-text("…") >> text=12 months'`). Look before and after your change.
   For a card's plans, the card's own app is the truth, not the bank data: ask the owner for a screenshot (Gem's
   "My plans") and compare plan by plan before shipping.
4. To see a state the real budget isn't in yet (a card newly linked, a pending payment), make a changed copy in your
   scratchpad with `jq` (`.bankLinks["x"]="debt:gem" | (.debts[]|select(.id=="gem")).pending=[…]`) and pass it with `--file`.
5. To try what a change or an answer would do to the real budget without the app, see `scripts/README.md` →
   **Trying a change on the real budget**.

That output is private: never put it in commits, PRs, code, fixtures or notes, and a test that copies a real case uses made-up amounts (a $400 rent, not the real one). `testing/fixtures.ts` →
`foodGasBudget()` is a made-up budget shaped like the real Food and gas account, for tests.

## Rules the code relies on

- **Money is whole cents** (`Cents` = number). Format with `core/money.ts` (`cash`, `money`); parse typed amounts with `parseMoney`.
- **Dates are `YYYY-MM-DD` strings** (`ISODate`), worked out in UTC by `core/dates.ts`. Do date maths with its helpers (`todayISO()`, `addDays()`, `diffDays()` …), not with `Date` directly, and pass `today` through so tests can fix the date.
- **Every change goes through `useBudget().update(fn)`** (`state/store.tsx`): it clones the budget, runs your `fn`, re-balances upcoming pays (`autoBalance`), keeps the day's saved copy and syncs. Don't mutate the budget anywhere else.
- **Logic is pure and testable.** `engine/`, `core/` and every `logic/` folder take a `Budget` and return values. No React and no storage there. Pages (`*.tsx`) call them.
- **Dependencies point inward**: `core` ← `engine` ← `features`/`services` ← `app`. `ui/` knows nothing about budgets. (`engine` and `features/debts|savings/logic` call each other; don't add new cycles.) `features/` and `services/` sit side by side: a page may use a service (Accounts uses `bankSync` and the bank's `SYNCED` event), and a service may use a page's `logic/`. `engine/` and `core/` never import a service's code (`core/types.ts` only borrows the `Payslip` type).
- **One reader per bank format**: transfers between your own accounts are read by `engine/transfers.ts` → `ownTransfer` only; shop categories by `features/insights/logic/spending.ts` → `categorizeTxn`. Use them; don't parse descriptions again.
- **A pay payday has already sent is locked** (`engine/balances/freeze.ts` → `paySplitLocked`): what it sent is frozen.
  Pages say what it sent ("Payday sent $133 on 19 Nov") and never call it short; warnings are for pays still to come.
- **Design**: use the tokens and classes in `ui/styles/` and the pieces in `ui/components.tsx`, never new colours or sizes. Green/red only ever mean "fine"/"short". An account's colour is only a small mark beside its name.
  A bar of amounts is `ui/PartsBar.tsx`, so each part can be tapped to see what it is.
  Cards are read on a phone: the summary is figures and one line per item, plus anything to act on; explanations go
  behind Details, and the Details button sits above what it opens (`ui/README.md`).
- **Privacy**: the Gemini key, GitHub token and bank passphrase stay in the browser's storage only, never in the budget, the repo or the code. `src/personal/` (git-ignored) holds the owner's own data and is never committed.
- **Keep files small**: aim for under ~400 lines. When one grows past that, split it by its sections into files named for their job, and update the README. Over 500 lines fails `npm test`.

The folder rules above (file size, no React in `core/`/`engine/`/`logic/`, a generic `ui/`, `core/` only borrowing types) are checked by `src/testing/structure.test.ts`.

## Where new code goes

- A calculation on the budget: the page's `logic/` folder, or `engine/` if more than one page needs it. Never inside a component.
- A new screen or pop-up: the page's folder in `features/`. If a second page needs it, move it to `shared/`.
- A generic visual piece (no budget rules): `ui/`, styled with the tokens in `ui/styles/`.
- A new outside connection: its own folder in `services/`, with its settings card.
- A new kind of saved data: `core/types.ts` first (see the rule above).
- A date, money or colour helper: check `core/` first; one probably exists. Don't write a second one.
- Tests go next to the code (`name.test.ts`), using `src/testing/fixtures.ts` for test budgets. A test must not depend on the real date: pass a fixed `today`, or fix the clock with `vi.setSystemTime` (see `features/planner/logic/allocate.test.ts`).
- Remove code you've replaced instead of leaving it beside the new code.

## Before you finish a change

1. `npm test`, `npx tsc -b` and `npm run lint` pass (lint warnings are OK, errors aren't).
2. Every folder you touched has its README updated: new, renamed, moved or deleted files, and changed purposes.
3. If you added a new kind of task or a new rule, update **Where to look** or **Rules the code relies on** here.
4. **Leave the notes more accurate than you found them, every time.** Look back on the task: what went well
   and what didn't. Then fix the notes for the next agent, in the same change:
   - Anything in this file or a README that was wrong or out of date: correct it.
   - Anything you had to search for, guess, or learn the hard way (a gotcha, a missing tool, a step that
     wasn't written down): add it where the next agent will look first (the folder's README, or **Where to
     look** / **Rules** / **Commands** here).
   - Anything that misled you or wasn't needed: shorten it or remove it. Keep notes short. One sentence
     beats a paragraph.
   - When you finish, tell the owner in one or two lines what you changed in the notes and why.

## Commands

```bash
npm install        # a fresh session has no node_modules: tsc then fails with "Cannot find module 'react'"
npm run dev        # http://localhost:5173
npm test           # all tests (vitest); tests sit next to the code as *.test.ts
npx tsc -b         # type-check
npm run lint
npm run build      # production build in dist/ (pushing to main deploys it)
npm run uses -- envelopeHeld   # every file and line that uses a name (or a file's exports)
npm run inspect -- food        # the real budget (../budget-data) as the app sees it, one account
npm run screenshot -- '#/accounts' --today 2026-11-22   # a page with the real budget (needs npm run dev); --tap / --hover for tips
npm run live -- parts-tip --wait   # after merging: waits until the published app has that text
```

Edit code with the Edit and Write tools, not a Python or sed heredoc in Bash: a heredoc holding JS (`delete x[k]`, `${…}`) can be refused by Claude Code's removal check, though it deletes nothing.
Run one test file with `npx vitest run src/engine/periods.test.ts`. To check a new test catches the bug, run it with the fix set aside: `git stash push <file>`, run, `git stash pop`. Test budgets and helpers are in `src/testing/fixtures.ts`.

## Other sessions change `main` too

Several chats work on this repo at once and merge often. Before you edit a shared file (`ui/`, `engine/`), and
again before you push, run `git fetch origin main && git log --oneline HEAD..origin/main --stat`. If main has
moved, merge it in (`git merge origin/main`) and look at the files you both touched, rather than overwriting them.

## Making a change live

The owner asks for changes "live" (or "push live"): push the session branch, open a PR into `main` and merge it.
PRs have no CI (the workflow only runs on `main`), so run the checks in **Before you finish a change** yourself first.
Merging to `main` runs `.github/workflows/pages.yml`, which publishes to GitHub Pages in about 1–2 minutes. Two
merges close together cancel the first run, which is fine: the second builds everything. To check it's live,
run `npm run live -- <a CSS class you added, or a string from a .ts file> --wait` (in the background: it takes 1–2
minutes). Text in JSX is split up when built, so search a class name or a `logic/` string, not a sentence from a page.
Search it exactly as the code has it (`/plan transfer/i` is in the build; "PLAN TRANSFER" from a comment isn't: comments are dropped), or `--wait` runs 8 minutes for nothing.
It finds text the old build already had too, so pick something new to this change, and check the file it names
(`assets/index-….js`) differs from before the merge: the same name means the deploy hasn't finished.
Then tell the owner to refresh. The app keeps an offline copy (`public/sw.js`), so on a phone it can take a
reopen to show the new version.

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
