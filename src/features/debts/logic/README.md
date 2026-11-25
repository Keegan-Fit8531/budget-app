# features/debts/logic/

Plain functions for debts (no React). The engine uses these too: debt payments are part of every pay's plan.
Gem Visa's own rules and its plans are in `gem/`; a debt whose money is held in another account until statement
day (Gem in Misc bills) is in `held/`. Read those READMEs only when your change is about them.

## Files and folders
- `schedule.ts`: each plan's payments, pay by pay: `planSchedule`, `debtSchedules` (every plan on a debt, given what payday sends it), Mastercard-style cards (`mastercardPurchases`: every purchase 3 months interest-free). `PerPay` / `DebtPay` (a steady amount, plus one-pay amounts by pay start), `usualPay`, `payFor`, `PLAN_LABEL`, `fmt` ($1,234.56 for messages).
- `amounts.ts`: what's owed and sent: `owed` (the entered balance, else the plans added up), `plannedOwed`, `unplanned`, `debtPerPay` / `debtPay` (what payday sends, one-pay amounts included), `projectedOwed`, `historyOwed`, `recordHistory`, `paidIn`, `suggestPlan`, `exactForFirstPlan`.
- `funding.ts`: which account pays: `fundingAccountId` (the hold account if there is one), `debtPaymentsIn` (debt payments leaving an account between two dates), `heldDebtPaymentsIn`, `isHoldDisplayAccount`, `accountHasPlans`, `syncGemToRecommended` (Gem's payday amount follows its recommended allocation).
- `payments.ts`: recording payments: `applyPayment` (soonest due first, across plans; a part that clears a later pay's payment counts as paid on the day it was made, or that pay would count it twice), `redateEarlyPaid` (the one-off fix for ones saved under the later payday), `settleDue` (payments are automatic, so anything due before today counts as paid), `applyPayrollDeduction` (a payslip's student loan deduction), `fitPlansToBalance` (plans that add up to more than the balance come down to it, the way the card applies a payment; $0 plans go), `Applied`.
- `labels.ts`: `KIND_LABEL`, the name shown for each kind of debt (card, buy now pay later, person, loan).
- `advice.ts`: the recommended payment per debt for a pay, each by the lowest that keeps every plan on track (`debtAdvice`, `DebtAdvice`, `offRecommended`).
- `activity.ts`: what a card shows of its activity: `planProgress` (paid of total, months left), `planAt` (a plan at a later pay), `monthsUntil`, `paymentRows` (each payment Pending or Received, matched to the card's own credit of the same amount within a week), `paydayHistory` (what payday sent it, pays already sent).
- `gem/`: Gem Visa's payment rules, its 6-month plans built from the card's transactions, and Plan check (its own README).
- `held/`: a debt whose payday money waits in another account until statement day (its own README).
- Tests: `activity.test.ts`, and `debts.test.ts` (schedules, payments, Gem held until statement day, one-pay amounts on a held debt).

## Watch out for
- These files import each other (schedule ↔ gem ↔ amounts). Add a function to the file whose job it matches.
- A one-pay amount for a debt is always on the debt's own card (`overrides[pay][debt.accountId]`): `debtPay` reads it for forecasts and `settleDue`, and `depositFor` sends it. Change one and grep the other, or the forecast counts money that's never sent.
- Amounts are cents; `fmt` is only for the sentences shown to you.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
