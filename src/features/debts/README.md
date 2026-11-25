# features/debts/

Debts (`#/debts`): cards (Gem Visa, Q Mastercard), buy-now-pay-later (Afterpay), loans (the student loan,
repaid from salary) and people you owe. Each debt has payment plans; payday sends each debt an amount.

## Files
- `DebtsPage.tsx`: the page: the total owed and the chart, then each debt's card (what's owed, what this pay sends against what's recommended, its plans, payments, transactions, payday history). `AllocationRow` shows one debt's recommended payment.
- `DebtPlans.tsx`: a card's Payment plans: all of them paid of their total, then each plan's paid of total, months left of its length, and next payment (`logic/activity.ts` → `planProgress`). Looking at a later pay, each plan is as it will be then (`planAt`: after the scheduled payments before it).
- `PlanCheck.tsx`: Plan check, the Debts pop-up for big card purchases the bank can't say the plan of (a special deal, an older 6-month plan): tap its plan length, or "No plan"; what's left isn't asked (it's worked out from the balance and shown under Your answers, "6 months, paid off"); answers can be undone. Opens by itself after a sync when there's a new one (`usePlanCheck`), like Bill check on Accounts; `PlanCheckButton` in the page header. Logic: `logic/planCheck.ts`.
- `DebtActivity.tsx`: `DebtPayments` (payments to the card: from which account, Pending until the card shows it, then Received), `DebtPaydayHistory` (what payday sent for it each pay), `StatementDueLine` (the latest statement's amount to avoid interest and minimum, beside the recommendation).
- `DebtChart.tsx`: what's owed over the coming pays, by debt.
- `DebtModal.tsx`: add or edit a debt (name, kind, card rules, payday account, hold account, statement day, limit, rate). Also opened from the Add button.
- `DebtEditModal.tsx`: an existing debt's pop-up with tabs (`DebtTab`: balance, purchase, payment, details); `BalanceEditor` sets what's owed (plans adding up to more come down to it: `fitPlansToBalance`).
- `PlanModal.tsx`: add or edit a payment plan (interest-free, equal payments, Afterpay instalments, or a balance paid down each pay).
- `DebtPayday.tsx`: a debt card's Payday section: what payday sends it (`PaydayControl`), and for a held debt (Gem in Misc bills) what's been paid from there this month, with "No more this month" (`logic/held.ts`). A pay payday has already sent says "Payday sent $X" and is never called short.
- `PaymentModal.tsx`: record a payment you've made (split across plans the way the card does it). Also opened from the Add button.
- `logic/`: schedules, amounts owed, which account pays, recording payments, Gem Visa's rules and payment advice (its own README).

## Watch out for
- Cards are read on a phone: the Gem card says why its amount in one line (`logic/advice.ts` → `reason`); don't add a second box repeating it.
- Plan types (`PlanType` in `core/types.ts`): `interest-free` (clear by a deadline), `equal` (equal monthly payments), `afterpay` (fixed instalments), `balance` (a set amount each pay).
- Some debts keep their payday money in another account until statement day (`Debt.holdAccountId`, e.g. Gem in Misc bills): sending it early would count as an extra payment. The Planner shows them under Debt.
- A payroll debt (`Debt.payroll`, the student loan) isn't part of the payday split; payslips bring its balance down.
- Payments to cards are picked up from your bank accounts (`services/bank/cardPayments.ts`). A card linked to the bank itself (Gem Visa through Akahu) keeps the card's own balance: payments are only noted, and show Pending until the card has them. Its pending purchases are `Debt.pending`.
- Akahu doesn't send a card's minimum or the amount to avoid interest: those come from an uploaded statement (`Debt.statementDue`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
