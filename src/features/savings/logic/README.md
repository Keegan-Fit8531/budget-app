# features/savings/logic/

Plain functions for savings goals (no React). The engine uses `savings.ts`: goal amounts are part of every pay's plan.

## Files
- `savings.ts`: `forecast` (a goal's projection to its date), `requiredPerPay`, `savingsNeedIn` (what an auto savings account needs in a pay), `savedAsOf`, `firstPayToCome`, `accountHasGoals`.
- `goalcosts.ts`: a goal's costs: `summariseCosts`, `spentOn`, `leftOn`, `projectedAt` (the fund at a date), `savedToday`, `changeSaved` (money in or out today), `expectedGifts`, `spendFromGoal` / `removeSpend`, and cost categories (`DEFAULT_COST_CATEGORIES`, `groupCostCategories`, `costCategories`, `renameCostCategory`, `removeCostCategory`).
- `contributions.ts`: who put in how much: `contributions`, `peopleOf` (you first), `fromPay` (what payday sent), `paidShares` / `paidDirect` (costs paid outside the fund), `setPersonTotal`, `addPerson`, `renamePerson`, `removePerson`. `ME` and `UNASSIGNED` are the special people.
- `gifts.ts`: money in and out of a goal: `saveGift` (received money moves the saved balance), `signed`, `tracksPeople`, `personLabel`, `colorFor`, and the saved pie (`savedSlices`, `savedCentre`). `NEW_PERSON` / `NEW` mean "add a new person" in a picker.
- `kiwisaver.ts`: KiwiSaver: `isKiwiSaver`, `recordReading` (a balance on a day, one per day), `kiwiHistory` (balances with each fund's value and returns), `kiwiMonths` (the chart), `kiwiPerPay` and `slipContribution` (from payslips, with employer tax `esctRate`), `contributedBetween`, `statementIn`, `statementEarned`.
- `savings.test.ts`: forecasts, and undoing a spend from a goal. `kiwisaver.test.ts`: KiwiSaver readings, statements and the chart.

## Watch out for
- `savings.ts` and `engine/` call each other (a goal's per-pay amount depends on what payday sends its account).
- Money in or out of a goal (a spend, a gift, a cost paid from the fund, and undoing them) goes through `changeSaved`: it brings the balance up to today first, or the paydays since it was last updated would drop out of the fund.
- KiwiSaver readings come from the bank connection, statements read by the reader, or typing in. All of them go through `recordReading`.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
