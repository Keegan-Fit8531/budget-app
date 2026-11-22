# features/accounts/logic/

Plain functions for accounts (no React).

## Files
- `history.ts`: an account's history (`budget.accountHistory`): `setBalance` (a balance from your banking app, noted in the history), `recordCost` (a one-off cost: taken off the balance straight away), `removeCost` (optionally putting the money back), `accountHistory` (latest first).
- `history.test.ts`: balances and one-off costs.
- `billCheck.ts`: what the bill check asks after a bank sync (`billChecks`): a bill that comes out on another day (`usualShift`, at least twice, weekends allowed for) or for another amount (`usualAmount`, the last two payments), money to move back for a bill paid on another card, a bill not seen 3 days after it was due, and a debt payment held in this account (Gem Visa in Misc bills) that the bank shows paid from another account (`held`: "Did Weekly allowance pay Gem Visa's $272?"; "Still to send" saves an `unpaid` key so it's to come again, "Yes" then asks to move the money back). Accounts with no regular bills (only a held debt) are checked too. Each with its change (`apply`) and its "no" (`skip`).
- `billCheck.test.ts`: the bill check.
- `paydayModes.ts`: the labels and hints for the payday-amount choice (fixed / exact / steady): `PAYDAY_MODE_LABEL`, `PAYDAY_MODE_HINT`.

## Watch out for
- `matchBills` is cached per budget object: in a test, change a `structuredClone` of the budget (as the store does), not the one you already checked, or you get the old answer.
- A payment from another account only matches a bill when it's at least a quarter of the bill's size or less than 4× it (`r >= 0.25` in `engine/billMatch.ts`): a test with a $550 payment for a $101 bill won't match.
- A one-off cost changes the entered balance itself, so every projection drops by that much from then on.
- The bank connection and document reader also write balances and history (`services/bank/bank.ts`, `services/reader/apply.ts`) using these functions.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
