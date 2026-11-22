# features/debts/logic/

Plain functions for debts (no React). The engine uses these too: debt payments are part of every pay's plan.

## Files
- `schedule.ts`: each plan's payments, pay by pay: `planSchedule`, `debtSchedules` (every plan on a debt, given what payday sends it), Mastercard-style cards (`mastercardPurchases`: every purchase 3 months interest-free). `PerPay` / `DebtPay` (a steady amount, plus one-pay amounts by pay start), `usualPay`, `payFor`, `PLAN_LABEL`, `fmt` ($1,234.56 for messages).
- `amounts.ts`: what's owed and sent: `owed` (the entered balance, else the plans added up), `plannedOwed`, `unplanned`, `debtPerPay` / `debtPay` (what payday sends), `projectedOwed`, `historyOwed`, `recordHistory`, `paidIn`, `suggestPlan`, `exactForFirstPlan`.
- `funding.ts`: which account pays: `fundingAccountId` (the hold account if there is one), `debtPaymentsIn` (debt payments leaving an account between two dates), `heldDebtPaymentsIn`, `isHoldDisplayAccount`, `accountHasPlans`, `syncGemToRecommended` (Gem's payday amount follows its recommended allocation).
- `payments.ts`: recording payments: `applyPayment` (soonest due first, across plans), `settleDue` (payments are automatic, so anything due before today counts as paid), `applyPayrollDeduction` (a payslip's student loan deduction), `Applied`.
- `gem.ts`: Gem Visa (Latitude NZ) rules from its Conditions of Use, clause 14: how a payment is split (instalments due, then expiring interest-free purchases by expiry date…), the minimum payment, plan lengths (`GEM_PLAN_MONTHS`, `gemPlanType`, `gemPlanEnds`), `gemPlan` (the recommended payment that clears each plan before it ends), `gemApply` (a payment before the statement that clears this pay's statement payment logs it in `debt.paid`, so the hold account counts it paid), `beforeStatement`.
- `labels.ts`: `KIND_LABEL`, the name shown for each kind of debt (card, buy now pay later, person, loan).
- `advice.ts`: the recommended payment per debt for a pay, each by the lowest that keeps every plan on track (`debtAdvice`, `DebtAdvice`, `offRecommended`).
- `debts.test.ts`: schedules, payments gone out, recording a payment, Gem held until statement day, extra paid for one pay.

## Watch out for
- These files import each other (schedule ↔ gem ↔ amounts). Add a function to the file whose job it matches.
- Gem's split can't be directed at one plan; `gem.ts` reproduces Latitude's order. Keep it in line with the clause quoted at the top of that file.
- Amounts are cents; `fmt` is only for the sentences shown to you.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
