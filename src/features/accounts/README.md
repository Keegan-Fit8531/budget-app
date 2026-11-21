# features/accounts/

Accounts (`#/accounts`): what's in each bank account, what it's for before next payday and where it's
heading; and the Deposits pop-up (`#/accounts/deposits/<id>`) that sets what payday sends each account.

## Files
- `AccountsPage.tsx`: the page: an account card per account (icon, name, payday amount, where the balance came from via `shared/SyncPill.tsx`, the month tracker), typing in a balance, Reorder, and the + for a one-off cost.
- `Deposits.tsx`: the Deposits pop-up: each account's payday amount (`shared/PaydayControl.tsx`) and its costs (`shared/ItemModal.tsx`), by group (`DepositsModal`, `AccountSection`); `AccountPayday` is one account's version, used as a tab in the account's pop-up.
- `AccountEdit.tsx`: an account's pop-up with tabs (`AccountTab`: `balance`, `cost` (a one-off cost), `payday`): `AccountEditModal`. Also opened from the Planner's cards.
- `AccountHistory.tsx`: one-off costs (`OneOffCostModal`, `OneOffCostForm`: money spent outside the plan, like a tyre puncture) and the account's history list.
- `MonthTracker.tsx`: an account's live tracker for this pay (bills paid and to come, against what's in it, from `engine/balances/billTracker.ts`) and a future pay day by day (`PayProjectionView`).
- `logic/`: account history and the payday-mode labels (its own README).

## Watch out for
- Balances you enter are kept with their date (`budget.balances`) and in the history; every projection carries on from the latest one.
- What payday sends comes from `engine/balances/deposits.ts` → `depositFor`. The labels for each payday mode are in `logic/paydayModes.ts`.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
