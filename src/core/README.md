# core/

The data model and the small helpers everything else uses. Nothing here depends on React or on the rest of the app.

## Files
- `types.ts`: the shape of the saved budget: `Budget` (at the bottom), `Settings`, `Group`, `Account`, `Item` (a cost), `SplitLine` (what payday sends an account), `SavingsGoal`, `Txn`, `BalanceEntry`, `AccountEvent`. Re-exports `debtTypes.ts`, so always import from `types.ts`. Search it for the type you need; each field has a comment.
- `debtTypes.ts`: `Debt`, `DebtPlan`, `PlanType`, `StatementDue`, `BankPayment`, `PaidPayment` (split out of `types.ts` for size). A new debt field goes here.
- `dates.ts`: dates as `ISODate` strings (`YYYY-MM-DD`), worked in UTC: `todayISO`, `addDays`, `diffDays`, `addMonths`, `dateInMonth`, `weekday`, formatting (`fmtShort`, `fmtDay`, `fmtSpan`, `monthName`, `ordinal`), and Gem Visa's cycle-end dates (`gemCycleEndOnOrAfter`, `gemEndsFromMonthsLeft`).
- `money.ts`: amounts are whole cents. `money` / `cash` (no ".00" on whole dollars) to show them, `moneyParts` for the big figures, `parseMoney` for typed amounts (null if invalid), `centsToInput`.
- `colors.ts`: the palette for accounts, groups, categories and people (`PALETTE`, `tone` maps a saved hex onto its `--pal-*` token, `nextColor`, `colorAt`, `NEUTRAL_COLOR`).
- `order.ts`: `moveAmong`, what the Reorder buttons do (swap with the next one shown).
- `valid.ts`: `looksLikeBudget`, checked before a backup or the repo's copy replaces the budget.
- `seed.ts`: `seedBudget`, the blank budget a new install starts with.
- `core.test.ts`: tests for `parseMoney`, `looksLikeBudget` and `moveAmong`.

## Watch out for
- A new field on the budget: make it optional in `types.ts`, fill it in for older saves in `state/upgrade.ts` → `tidy()`, and check `valid.ts` still accepts old and new saves.
- Renaming a field: keep the old one in `types.ts` marked "Older saves … don't use it" (see `Item.monthEnvelope`), and have `tidy()` move its value to the new one and delete it. Saves in the repo and on other devices still have the old name.
- When `types.ts` nears 400 lines, move a group of types into its own file the same way (re-exported from `types.ts`).
- `types.ts` takes two types from elsewhere: `Payslip` (`services/reader/payslip.ts`) and `MonthlyReview` (`features/insights/logic/review.ts`).
- Never store dollars or `Date` objects in the budget: cents and `ISODate` strings only.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
