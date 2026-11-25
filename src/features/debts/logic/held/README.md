# features/debts/logic/held/

A debt whose payday money waits in a bank account until statement day (`Debt.holdAccountId`: Gem Visa's
payment kept in Misc bills), because paying Gem early can go on its oldest plan instead of that month's payment.
Come here when a held debt's payment, Misc bills' tracker, or the bill check's held question is wrong.

## Files
- `held.ts`: a held debt's payment this pay (`heldNow`: paid and still to send, from the hold account's tracker), `endHeld` ("No more this month": `heldPay` is what was paid, plus a `rest` key so the bill check stops asking) and `resumeHeld` (Undo); `setHeld` (set or take off one statement's `heldPay`, also used by the bill check).
- `held.test.ts`: paid in part, No more this month and its Undo, the bill check's question.

## How the money flows (most of it lives in other files)
- `../funding.ts` → `debtPaymentsIn`: its payments (paid ones in `debt.paid` included, and an extra for one pay set on its card, e.g. by Optimise) leave the hold account, so Accounts lists them there. The debt's own card only shows the amount (`isHoldDisplayAccount`); the payday total counts it once, in the hold account.
- The hold account's own one-pay amount is its whole send (its bills too), never the debt's payment: `../amounts.ts` → `debtPay` reads only the debt's card. A $0 on the card (left by older versions) is ignored, or it would stop that pay's payment though the money is held.
- `engine/balances/outflows.ts` → the hold top-up: at least Gem's recommended amount, or `Debt.heldPay` (set for one statement in the bill check) instead. Only in the pay holding a range's start: a projection over several pays uses the plans' own payments.
- Balancing (`engine/rebalance.ts`) trims the hold account only by what the debt's own card is sent over its recommended amount, never by the hold account's own bills.
- A payment seen in the bank: `services/bank/cardPayments.ts` → `gem/gem.ts` → `gemApply`. An early or extra payment that clears this pay's statement payment logs it in `debt.paid`, so the hold account shows it paid.
- When that payment came from another account, the Accounts bill check asks if it was the one (`features/accounts/logic/billCheck.ts`, kind `held`); answers can be undone there.
- Paid only in part from the hold account: the tracker counts what was paid and the rest as to come (`billTracker.ts` → `splitPartPaid`). The bill check asks about the rest, and the Debts card has "No more this month"; both save `heldPay` plus a `rest` key.

## Watch out for
- A part payment never pays a whole plan; it counts in the tracker's `toMove` only once the bill check's "Yes, that paid it" is answered.
- `isHoldDisplayAccount` is true only when every debt on that account is held: check it before treating an account's one-pay amount as a debt's.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
