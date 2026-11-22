# features/debts/

Debts (`#/debts`): cards (Gem Visa, Q Mastercard), buy-now-pay-later (Afterpay), loans (the student loan,
repaid from salary) and people you owe. Each debt has payment plans; payday sends each debt an amount.

## Files
- `DebtsPage.tsx`: the page: the total owed and the chart, then each debt's card (what's owed, what this pay sends against what's recommended, its plans, bank payments seen, transactions). `AllocationRow` shows one debt's recommended payment; `BankPayments` lists payments to the card seen in your bank.
- `DebtChart.tsx`: what's owed over the coming pays, by debt.
- `DebtModal.tsx`: add or edit a debt (name, kind, card rules, payday account, hold account, statement day, limit, rate). Also opened from the Add button.
- `DebtEditModal.tsx`: an existing debt's pop-up with tabs (`DebtTab`: balance, purchase, payment, details); `BalanceEditor` sets what's owed (plans adding up to more come down to it: `fitPlansToBalance`).
- `PlanModal.tsx`: add or edit a payment plan (interest-free, equal payments, Afterpay instalments, or a balance paid down each pay).
- `PaymentModal.tsx`: record a payment you've made (split across plans the way the card does it). Also opened from the Add button.
- `logic/`: schedules, amounts owed, which account pays, recording payments, Gem Visa's rules and payment advice (its own README).

## Watch out for
- Cards are read on a phone: the Gem card says why its amount in one line (`logic/advice.ts` → `reason`); don't add a second box repeating it.
- Plan types (`PlanType` in `core/types.ts`): `interest-free` (clear by a deadline), `equal` (equal monthly payments), `afterpay` (fixed instalments), `balance` (a set amount each pay).
- Some debts keep their payday money in another account until statement day (`Debt.holdAccountId`, e.g. Gem in Misc bills): sending it early would count as an extra payment. The Planner shows them under Debt.
- A payroll debt (`Debt.payroll`, the student loan) isn't part of the payday split; payslips bring its balance down.
- Payments to cards that can't be linked to the bank are picked up from your bank accounts (`services/bank/cardPayments.ts`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
