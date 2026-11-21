# features/

One folder per page. Each holds the page (`<Name>Page.tsx`), its cards and pop-ups (`*.tsx`), and a `logic/`
folder of plain functions (no React) with their tests. Logic that several pages share lives in `engine/`.

## Folders
- `planner/`: Planner (`#/planner`, the home page): this pay's leftover, the payday split, what's due, Optimise.
- `accounts/`: Accounts (`#/accounts`): balances, the month tracker, account history, and the Deposits pop-up (what payday sends each account).
- `debts/`: Debts (`#/debts`): cards, buy-now-pay-later, loans and people owed, their payment plans, what to pay, Gem Visa's rules.
- `savings/`: Savings (`#/savings`): savings goals, a goal's costs and gifts (the wedding), KiwiSaver.
- `insights/`: Insights (`#/insights`): where pay goes by account, spending by category, the monthly cycle review.
- `settings/`: Settings (`#/settings`): pay and payday rules, backups, saved copies, export, and each service's settings card.

## Watch out for
- A page reads the budget with `useBudget()` and changes it only through `update(fn)` (`state/store.tsx`).
- Put a calculation in the feature's `logic/` (or `engine/` if more than one page needs it), not inside a component, so it can be tested.
- A pop-up used from more than one page goes in `shared/`.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a folder here (see AGENTS.md).
