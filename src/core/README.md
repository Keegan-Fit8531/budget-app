# core/

The data model and the small helpers everything else uses. Nothing here depends on React or on the rest of the app.

## Files
- `types.ts`: the shape of the saved budget: `Budget` (at the bottom) and everything in it: `Settings` (payday day, weekend rules, pay account), `Group`, `Account`, `Item` (a cost: amount, frequency, account, put aside, or an `envelope` with its `EnvelopeSpan`), `SplitLine` (what payday sends an account, and its `PaydayMode`: fixed / exact / smooth), `Debt` and `DebtPlan`, `SavingsGoal` (with its costs, gifts and KiwiSaver readings), `Txn` (a transaction), `BalanceEntry`, `AccountEvent`, and on `Budget` `envelopeTransfers` (which envelope a transfer out paid for). Search it for the type you need rather than reading all 400 lines. Each field has a comment saying what it is.
- `dates.ts`: dates as `ISODate` strings (`YYYY-MM-DD`), worked in UTC: `todayISO`, `addDays`, `diffDays`, `addMonths`, `dateInMonth`, `weekday`, formatting (`fmtShort`, `fmtDay`, `fmtSpan`, `monthName`, `ordinal`), and Gem Visa's cycle-end dates (`gemCycleEndOnOrAfter`, `gemEndsFromMonthsLeft`).
- `money.ts`: amounts are whole cents. `money` / `cash` (no ".00" on whole dollars) to show them, `moneyParts` for the big figures, `parseMoney` for typed amounts (null if invalid), `centsToInput`.
- `colors.ts`: the palette for accounts, groups, categories and people (`PALETTE`, `tone` maps a saved hex onto its `--pal-*` token, `nextColor`, `colorAt`, `NEUTRAL_COLOR`).
- `order.ts`: `moveAmong`, what the Reorder buttons do (swap with the next one shown).
- `valid.ts`: `looksLikeBudget`, checked before a backup or the repo's copy replaces the budget.
- `seed.ts`: `seedBudget`, the blank budget a new install starts with.
- `core.test.ts`: tests for `parseMoney`, `looksLikeBudget` and `moveAmong`.

## Watch out for
- A new field on the budget: make it optional in `types.ts`, fill it in for older saves in `state/store.tsx` → `tidy()`, and check `valid.ts` still accepts old and new saves.
- Renaming a field: keep the old one in `types.ts` marked "Older saves … don't use it" (see `Item.monthEnvelope`), and have `tidy()` move its value to the new one and delete it. Saves in the repo and on other devices still have the old name.
- `types.ts` takes two types from elsewhere: `Payslip` (`services/reader/payslip.ts`) and `MonthlyReview` (`features/insights/logic/review.ts`).
- Never store dollars or `Date` objects in the budget: cents and `ISODate` strings only.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
