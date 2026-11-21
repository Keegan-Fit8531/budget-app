# features/insights/

Insights (`#/insights`): where pay goes by account, where money was spent by category (from bank and card
transactions), and the monthly cycle review written by Gemini.

## Files
- `InsightsPage.tsx`: the page: where pay goes by group, compared with the budgeting rule (50/30/20), by account, and suggestions; with the spending card and the cycle review.
- `SpendingCard.tsx`: "Where your money went": spending by category; tap a category to see its shops and change a shop's category (saved in `budget.shopCategories`).
- `MonthlyInsights.tsx`: the cycle review card (the latest review, past ones, and the cycle so far), and two jobs mounted by `app/App.tsx` that run while the app is open: `ReviewAutoRun` (makes the review after payday) and `ShopSortAutoRun` (asks Gemini to place shops the rules left in Other).
- `logic/`: spending categories and the review's numbers (its own README).

## Watch out for
- Shop categories: your own choice wins, then Gemini's guess (`budget.shopGuesses`), then the built-in rules (`logic/spending.ts`).
- Gemini only gets shop names and one example description each for sorting; for the review it gets the cycle's totals and account names, never account numbers.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
