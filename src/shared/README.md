# shared/

Components that know about the budget and are used by more than one page. (Generic pieces with no budget
logic go in `ui/` instead; a component only one page uses goes in that page's folder.)

## Files
- `ItemModal.tsx`: add or edit a cost (`Item`): name, amount, how often, account, put aside or an envelope (with its timeframe: week, fortnight or month), skip near payday. Used by the Add button and Deposits.
- `PaydayControl.tsx`: "Sent each payday": a fixed amount or worked out each pay (`PaydayControl`), and an account's rounding (`RoundSetting`). Used by Deposits, Debts and Savings.
- `DayPicker.tsx`: pick a day to see a balance on (`useDayView`, `DayPicker`). Used by Accounts and Debts.
- `Transactions.tsx`: a list of transactions, latest first, each with its spending category (`TransactionList`). Used by Accounts and Debts.
- `SyncPill.tsx`: the pill that says where a balance came from (bank connection, entered, none) and how current it is; tapping it syncs. Used by Accounts, Debts and Savings.

## Watch out for
- If a component here ends up used by one page only, move it into that page's folder (and update both READMEs).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
