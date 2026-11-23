# engine/

The budget maths, as plain functions on a `Budget` (no React, no storage). Every page uses these. A pay
period runs from payday to the day before the next payday.

## Files
- `periods.ts`: paydays and pay periods. `paydayFor` (payday day + weekend rules + paydays that really moved), `periodContaining`, `shiftPeriod`, `budgetPeriod`, `firstBudgetPay`, `upcomingPayPeriod` (the Planner opens on it), `recordPayday` / `clearPaydayMove` (a payslip shows pay came early or late). `Period` and `PayRules` types. Periods are cached, since they're asked for thousands of times.
- `occurrences.ts`: when a cost (`Item`) happens: `occurrences` between two dates, `itemDates` (minus any skipped for landing within `skipIfWithin` days of payday), `skippedDates`, `daysToPayday`.
- `setAside.ts`: money that stays in its account instead of being paid out on a date. **Put aside** (a WOF: `isSetAside`, `setAsidePerPay`, `asideSplit` for the Accounts bar) and **envelopes** (`Item.envelope` = `'month' | 'week' | 'fortnight'`, Food $200 a week: `isEnvelope`, `envelopeBudget`, `envelopeWindow`, `envelopePerPay`). A month envelope is split across the month's paydays; a week or fortnight one is funded by the payday whose pay it starts in. `isHeldInAccount` covers both.
- `envelope.ts`: an envelope's spending in its current week, fortnight or month (`envelopeStatus`, `accountEnvelopes`), `envelopeHeld` (what's spoken for: unspent this span, plus later weeks this pay already funded), and `unsortedTransfers` (transfers out the Accounts card asks about). Re-exports `envelopeMatch.ts`.
- `envelopeMatch.ts`: which transactions count against an envelope. Purchases: `matchesEnvelope` (Gas → fuel, Food → supermarkets, by the shop categories in `features/insights/logic/spending.ts`), `purchaseEnvelope` (each to one envelope; `Item.envelopeUnder` splits by size). Transfers out that paid for one: `guessTransfer` (purchases on the account it went to within 3 days), `transferEnvelope` (your choice in `budget.envelopeTransfers`, else a sure guess).
- `billMatch.ts`: which bank transaction paid each bill (`matchBills`): from its own account ('direct'), on another account's card ('card', with its `cover` transfer), or money moved across first ('moved'); one payment can cover several bills (`shared`). `nameMatch` copes with typos, cut-off names (PayPal's "Paypal *Canv") and known payees. Also `otherMoves` (money you moved yourself this pay), `bankFed`, `businessDay`, `checkKey` (keys for `budget.billChecks`).
- `transfers.ts`: **the one place that reads transfers between your own accounts** from the account number in the description ("To: 06-0115-0324910-55 …", "From: …", an older export's "06-… DEBIT TRANSFER"): `ownTransfer` (the account at the other end, and which way), `numberKey` (06-0115-0324910-055 and -55 are the same).
- `frequency.ts`: `convert` an amount between frequencies and views (week, fortnight, month, year), `convertFromView`, `View`.
- `plan.ts`: `planFor(budget, period)`, the plan for one pay: pay (actual or estimated), each account's `AccountPlan` (what payday sends, what it needs, spare/short, end balance, costs due), everything due, total split and what's left over. Also `averageNeed`, `averageSplit`, `plannedAverage` (the next 12 pays averaged, for Month and Year views), `isAuto`.
- `rebalance.ts`: automatic balancing. `balancePay` works out one-pay changes that bring a short pay back to $0 or better, in a set order (top up short accounts, then trims; with money left over, a Steady account (Rent) gets just enough that its balance stays above $0 at the usual amount for the next 12 pays: `levelAmount`), `applyBalance`, `restoreOverrides`. `autoBalance` re-balances the next `AUTO_PAYS` (12) pays from scratch after every change, undoing what it set last time but never your own edits. `balancedMode`, `clearAuto`, `clearOrphanAuto`.
- `balances/`: what payday sends each account and what's in each account over time (its own README).
- `periods.test.ts`, `setAside.test.ts`, `envelope.test.ts`, `rebalance.test.ts`, `billMatch.test.ts`: tests for the files above.

## Watch out for
- What these return is shown on several pages (an envelope appears on the Planner card, the Accounts tracker, Deposits and the cost pop-up). Before changing a result or its meaning, run `npm run uses -- engine/<file>.ts` to see every page that uses it.
- A transfer's envelope depends on the other transfers near it (they share out the purchases), so test several transfers together, as the real account makes them (`envelope.test.ts` → "several transfers after several purchases").
- `state/store.tsx` runs `autoBalance` on every `update()`, so anything slow here slows every change. Keep heavy work cached (see `balances/steady.ts`).
- What payday sends a pay can be a one-pay adjustment (`budget.overrides`), a frozen split once the pay is locked (`budget.splitSent`), or the account's mode (fixed / exact / steady). Always ask `balances/deposits.ts` → `depositFor`, never read those fields directly.
- `autoBalanced` records what balancing set and why, so it can redo a pay without touching your changes. Keep that working when you change `rebalance.ts`.
- `engine` and `features/debts/logic` / `features/savings/logic` call each other (debt payments and goal amounts are part of the plan). That's fine; don't add new cycles.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
