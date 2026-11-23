# features/planner/logic/

Plain functions behind the Planner (no React).

## Files
- `plannerFigures.ts`: everything the Planner shows for one pay and view: `plannerFigures` (totals, leftover, what needs balancing, whether Optimise is offered), `viewScale` (amounts per week, fortnight, month or year), `payNotes` ("What's different this pay"), `paydayCards`, `chartSlices` (a held debt counts under Debt and comes off its hold account, so it's counted once).
- `plannerFigures.test.ts`: the view scale, notes and their reasons, which cards show, the chart, and when to balance or optimise.
- `allocate.ts`: Optimise. `allocationTargets` (where leftover money can go: goals, the weekly allowance, debts, spending), `applyAllocation`, `undoAllocation` (puts back only what Optimise changed), `existingExtras` (extra already added for this pay only), `allowancePerWeek`.
- `allocate.test.ts`: optimising the leftover, then changing it.
- `weeks.ts`: the weeks view: `calendarWeeks` (Mon–Sun weeks spanning a pay) and `weeklyCoverage` (weekly costs switched on for it).
- `modeMemory.ts`: the payday modes "Balance this pay" changed (e.g. Fixed → Steady), remembered per pay in localStorage so "Reset to defaults" can put them back: `rememberModes`, `takeModes`, `modesChangedIn`.

## Watch out for
- Optimise only runs on a balanced pay (nothing short, nothing left to re-balance) with at least $1 left.
- One-pay amounts go in `budget.overrides` (accounts) or a debt's `DebtPay.byPeriod`; every-pay amounts change the account's usual amount.
- Once a pay is locked (payday passed or payslip in), `planFor` freezes it in `budget.splitSent`, one-pay amounts there at the time included. Removing an override alone leaves the frozen figure in place, so `undoAllocation` takes the undone amount out of `splitSent` too (as the Planner's "this pay only" edit does). Tests here fix "today" both before and after payday, so they don't depend on the real date.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
