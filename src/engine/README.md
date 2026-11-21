# engine/

The budget maths, as plain functions on a `Budget` (no React, no storage). Every page uses these. A pay
period runs from payday to the day before the next payday.

## Files
- `periods.ts`: paydays and pay periods. `paydayFor` (payday day + weekend rules + paydays that really moved), `periodContaining`, `shiftPeriod`, `budgetPeriod`, `firstBudgetPay`, `upcomingPayPeriod` (the Planner opens on it), `recordPayday` / `clearPaydayMove` (a payslip shows pay came early or late). `Period` and `PayRules` types. Periods are cached, since they're asked for thousands of times.
- `occurrences.ts`: when a cost (`Item`) happens: `occurrences` between two dates, `itemDates` (minus any skipped for landing within `skipIfWithin` days of payday), `skippedDates`, `daysToPayday`.
- `setAside.ts`: money that stays in its account instead of being paid out on a date. **Put aside** (a WOF, tyres: `isSetAside`, `setAsidePerPay`, `setAsidesOn`, `asideMaxSaved`) and **month envelopes** (Gas $200/month, reset each calendar month: `isMonthEnvelope`, `monthBudget`, `paydaysInMonth`, `monthEnvelopePerPay`, `monthEnvelopesOn`). `isHeldInAccount` covers both.
- `envelope.ts`: a month envelope's spending this month, from synced purchases (`matchesEnvelope`, `envelopeStatus`, `accountEnvelopes`, `envelopeHeld` = what's still unspent). Uses the shop categories in `features/insights/logic/spending.ts`.
- `frequency.ts`: `convert` an amount between frequencies and views (week, fortnight, month, year), `convertFromView`, `View`.
- `plan.ts`: `planFor(budget, period)`, the plan for one pay: pay (actual or estimated), each account's `AccountPlan` (what payday sends, what it needs, spare/short, end balance, costs due), everything due, total split and what's left over. Also `averageNeed`, `averageSplit`, `plannedAverage` (the next 12 pays averaged, for Month and Year views), `isAuto`.
- `rebalance.ts`: automatic balancing. `balancePay` works out one-pay changes that bring a short pay back to $0 or better, in a set order (top up short accounts, then trims), `applyBalance`, `restoreOverrides`. `autoBalance` re-balances the next `AUTO_PAYS` (12) pays from scratch after every change, undoing what it set last time but never your own edits. `balancedMode`, `clearAuto`, `clearOrphanAuto`.
- `balances/`: what payday sends each account and what's in each account over time (its own README).
- `periods.test.ts`, `setAside.test.ts`, `envelope.test.ts`, `rebalance.test.ts`: tests for the files above.

## Watch out for
- `state/store.tsx` runs `autoBalance` on every `update()`, so anything slow here slows every change. Keep heavy work cached (see `balances/steady.ts`).
- What payday sends a pay can be a one-pay adjustment (`budget.overrides`), a frozen split once the pay is locked (`budget.splitSent`), or the account's mode (fixed / exact / steady). Always ask `balances/deposits.ts` → `depositFor`, never read those fields directly.
- `autoBalanced` records what balancing set and why, so it can redo a pay without touching your changes. Keep that working when you change `rebalance.ts`.
- `engine` and `features/debts/logic` / `features/savings/logic` call each other (debt payments and goal amounts are part of the plan). That's fine; don't add new cycles.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
