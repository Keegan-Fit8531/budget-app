# state/

Where the budget lives while the app runs, and the little shared state pages need.

## Files
- `store.tsx`: `BudgetProvider` and `useBudget()`: the one `Budget`, saved to localStorage (`paydays.budget.v1`). `update(fn)` clones it, runs `fn`, re-balances (`autoBalance`), keeps the day's copy (`versions.ts`) and stamps `updatedAt`; `replace`, `reset` and `restoreVersion` swap in a whole budget. Syncs with the GitHub repo (`services/sync/sync.ts`): pulls on open and on coming back into view, pushes after each change, newest wins. Loads through `upgrade.ts`. `newId()`.
- `upgrade.ts`: how a loaded budget is made current, with no React (so `scripts/inspect.ts` and tests load a budget exactly as the app does). `tidy()` fills in what older saves are missing, converts renamed fields (e.g. `monthEnvelope` → `envelope`) and makes one-off fixes, each once behind a `budget.flags` entry (e.g. Scooter gas only takes fills under $40; `plans-fit-balance` brought plans down to a newer, lower balance; `early-paid-redated` re-dates early card payments); `bringUpToDate()` runs `tidy`, freezes locked pays, counts payments due before today as paid, and re-balances.
- `upgrade.test.ts`: older envelope fields converted; a one-off fix runs once; early card payments re-dated.
- `versions.ts`: saved copies in IndexedDB: the whole budget as it was before each day's first change, kept 3 months (`KEEP_DAYS`). `keepCopy`, `listCopies`, `readCopy`, `needsCopy`, `toForget`. Settings → Saved copies puts one back.
- `period.tsx`: the pay being viewed, shared by Planner, Debts, Savings and Deposits: `PeriodProvider`, `useViewPeriod()` (offset, period, view mode), and the `PayNav` (‹ November pay ›) and `ViewModes` (This period · Week · Fortnight · Month avg · Year) controls. `PayNav` draws the whole page header of Planner, Savings and Insights (title, its `children` such as the page's buttons, then the arrows); `compact` is the small one in Deposits.
- `versions.test.ts`: when a copy is taken and which ones are forgotten.

## Watch out for
- Never change the budget except through `update(fn)` (or `replace` / `restoreVersion`). `fn` gets a copy: change it and return it.
- `update` runs `autoBalance` every time, so a change to what's saved can change what payday sends in the next 12 pays. That's intended.
- `src/personal/migrate.ts` (git-ignored, owner's computer only) is picked up here with `import.meta.glob` and run on load.
- A connect link (QR code from Settings → Sync) is read before anything else runs (`takePairingFromUrl`).
- Once a pay is locked, the first change after it (each pay, once) puts that pay's split back as this morning's saved copy had it (`restoreSplitFromMorningCopy`), unless the change was to that split by hand (`engine/balances/freeze.ts` → `keepSplitChange`).
- Editing `store.tsx`, or anything it imports (`upgrade.ts` takes in most of `engine/` and debts logic), while the dev server has a page open makes a new context there (hot reload): "useBudget must be inside BudgetProvider" until you reload. Don't edit while a browser check runs.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
