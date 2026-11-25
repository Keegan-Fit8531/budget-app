# features/accounts/logic/

Plain functions for accounts (no React).

## Files
- `history.ts`: an account's history (`budget.accountHistory`): `setBalance` (a balance from your banking app, noted in the history), `recordCost` (a one-off cost: taken off the balance straight away), `removeCost` (optionally putting the money back), `accountHistory` (latest first).
- `history.test.ts`: balances and one-off costs.
- `billCheck.ts`: what the bill check asks after a bank sync (`billChecks`), each with its change (`apply`), an amount to ask (`asks`) and its "no" (`skip`): a bill on another day (`usualShift`, or `realStart` for one not started yet) or amount (`usualAmount`), money to move back for a bill paid on another card, a bill not seen 3 days after it was due, a held debt payment paid from another account (`held`), and the rest of a part-paid held payment (`rest`). `answeredChecks`: answers from the last 40 days, each with an `undo`.
- `newBill.ts`: `realStart`: a monthly bill set to start after today that the bank already shows on another day (Canva set for the 10th, charged on the 20th), for the bill check's 'day' question. `usualShift` can't see it: a bill has no matches before its start.
- `billCheck.test.ts`: the bill check.
- `asideSpends.ts`: what money put aside was spent on (Car maintenance → $200 to Weekly allowance → NZ Transport there): `unsortedAsideSpends` (money out this pay to ask about; not money that came back within a week, and only on an account with no bills), `asideSpends` (your answers, `budget.asideSpends`), `asideSpentSince`, `asideShopMatch` (rego → NZ Transport / VTNZ, maintenance → tyres, mechanics).
- `asideSpends.test.ts`: the above.
- `moneyFlow.ts`: `lastMonthFlow`, money out and in over 30 days for a card that isn't planned around (the pay account's): Spent leaves out money moved to your own accounts (`engine/transfers.ts`). `moneyFlow.test.ts`.
- `paydayModes.ts`: the labels and hints for the payday-amount choice (fixed / exact / steady): `PAYDAY_MODE_LABEL`, `PAYDAY_MODE_HINT`.

## Watch out for
- `matchBills` is cached per budget object: in a test, change a `structuredClone` of the budget (as the store does), not the one you already checked, or you get the old answer.
- A payment from another account only matches a bill when it's at least a quarter of the bill's size or less than 4× it (`r >= 0.25` in `engine/billMatch.ts`): a test with a $550 payment for a $101 bill won't match.
- `asideSpends.ts` never counts money out without an answer (unlike envelope transfers): the real car fund has had wedding and card payments go out of it too.
- A one-off cost changes the entered balance itself, so every projection drops by that much from then on.
- The bank connection and document reader also write balances and history (`services/bank/bank.ts`, `services/reader/apply.ts`) using these functions.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
