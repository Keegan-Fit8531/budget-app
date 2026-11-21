# features/accounts/logic/

Plain functions for accounts (no React).

## Files
- `history.ts`: an account's history (`budget.accountHistory`): `setBalance` (a balance from your banking app, noted in the history), `recordCost` (a one-off cost: taken off the balance straight away), `removeCost` (optionally putting the money back), `accountHistory` (latest first).
- `history.test.ts`: balances and one-off costs.
- `paydayModes.ts`: the labels and hints for the payday-amount choice (fixed / exact / steady): `PAYDAY_MODE_LABEL`, `PAYDAY_MODE_HINT`.

## Watch out for
- A one-off cost changes the entered balance itself, so every projection drops by that much from then on.
- The bank connection and document reader also write balances and history (`services/bank/bank.ts`, `services/reader/apply.ts`) using these functions.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
