# state/

Where the budget lives while the app runs, and the little shared state pages need.

## Files
- `store.tsx`: `BudgetProvider` and `useBudget()`. Holds the one `Budget`, saved to localStorage (`paydays.budget.v1`) on every change. `update(fn)` clones the budget, runs `fn`, re-balances upcoming pays (`engine/rebalance.ts` → `autoBalance`), keeps the day's saved copy (`versions.ts`) and stamps `updatedAt`. `replace`, `reset` and `restoreVersion` swap in a whole budget. Also syncs with the GitHub repo (`services/sync/sync.ts`): pulls when the app opens or comes back into view, pushes a moment after each change, and when both sides changed the newest wins (the other is kept as a saved copy). `tidy()` fills in what older saves are missing and converts renamed fields (e.g. `monthEnvelope` → `envelope`) and makes one-off fixes, each once behind a `budget.flags` entry (e.g. Scooter gas only takes fills under $50); `bringUpToDate()` freezes locked pays, counts payments due before today as paid, and re-balances. `newId()` makes ids.
- `versions.ts`: saved copies in IndexedDB: the whole budget as it was before each day's first change, kept 3 months (`KEEP_DAYS`). `keepCopy`, `listCopies`, `readCopy`, `needsCopy`, `toForget`. Settings → Saved copies puts one back.
- `period.tsx`: the pay being viewed, shared by Planner, Debts, Savings and Deposits: `PeriodProvider`, `useViewPeriod()` (offset, period, view mode), and the `PayNav` (‹ November pay ›) and `ViewModes` (This period · Week · Fortnight · Month avg · Year) controls.
- `versions.test.ts`: when a copy is taken and which ones are forgotten.

## Watch out for
- Never change the budget except through `update(fn)` (or `replace` / `restoreVersion`). `fn` gets a copy: change it and return it.
- `update` runs `autoBalance` every time, so a change to what's saved can change what payday sends in the next 12 pays. That's intended.
- `src/personal/migrate.ts` (git-ignored, owner's computer only) is picked up here with `import.meta.glob` and run on load.
- A connect link (QR code from Settings → Sync) is read before anything else runs (`takePairingFromUrl`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
