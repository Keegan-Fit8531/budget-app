# features/settings/

Settings (`#/settings`): pay and payday rules, the budget rule (50/30/20), groups, theme, backups, saved
copies, export, and the settings card of each outside service.

## Files
- `SettingsPage.tsx`: the page, in sections: Pay (payday day, weekend rules, expected pay, your next paydays), Budgeting rule (`RULES`, e.g. 50/30/20), Appearance (theme, `ui/theme.ts`), Pay history, Groups, Savings cost categories (`features/savings/CostCategories.tsx`), and Your data (Download / Restore backup, checked with `core/valid.ts`; start again). Places the service cards: sync (`services/sync/SyncCard.tsx`), bank (`services/bank/BankCard.tsx`), reading documents (`services/reader/ui/ReaderCard.tsx`).
- `ExportMonth.tsx`: export one pay as a spreadsheet (`logic/export.ts`).
- `SavedCopies.tsx`: the daily saved copies (`state/versions.ts`), to put one back.
- `logic/`: the spreadsheet export (its own README).

## Watch out for
- A restored backup goes through `replace()` in `state/store.tsx`, which brings it up to date (freezes locked pays, counts past payments as paid, re-balances). The current budget is kept as a saved copy first.
- Keys and tokens typed in here are kept in this browser's storage only, never in the budget.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
