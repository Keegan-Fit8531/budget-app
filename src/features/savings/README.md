# features/savings/

Savings (`#/savings`): savings goals, each with its own account that payday sends money to; a goal's costs
and the money people put in (the wedding fund); and KiwiSaver, a goal payday sends nothing to.

## Files
- `SavingsPage.tsx`: the page: each goal's card (`GoalCard`: pie, saved, one status line, then tabs for costs, money in and out, and payday) and moves to or from the goal's fund seen in your bank (`BankMoves`). KiwiSaver goals get `KiwiSaver.tsx` instead.
- `GoalModal.tsx`: add or edit a goal (name, target, date, account). Also opened from the Add button.
- `SavingsChart.tsx`: the projected balance pay by pay against the goal's target and date.
- `GoalCosts.tsx`: costs paid from a goal (what's due when, and whether the fund covers it), one `CostRow` each.
- `CostModal.tsx`: add or edit a goal cost. `SpendModal.tsx`: spend from the goal on a cost (comes off the saved balance).
- `CostCategories.tsx`: rename, add and remove the cost categories (`CostCategoriesEditor`, and `CostCategoriesModal`; also on Settings).
- `GoalGifts.tsx`: money in and out of a goal and who it was from: `GoalGifts`, `PeopleChips`, `PersonPicker`, `AddMoneyButton`. Its plain helpers are in `logic/gifts.ts`.
- `GiftModals.tsx`: the pop-ups for it: `GiftModal` (an amount in or out), `PersonModal` (a person's total, rename, remove), `SplitModal` (share the saved balance between people).
- `KiwiSaver.tsx`: the KiwiSaver card: balances over time with each fund, what went in, gains and losses; typing in a balance.
- `logic/`: forecasts, costs, contributions and KiwiSaver maths (its own README).

## Watch out for
- A goal's saved balance is "as at" a date (`savedAsOf`); pays after that date add on top in projections.
- Received money goes straight into the saved balance; expected money is shown separately until it arrives.
- KiwiSaver is never sent anything on payday (it comes from salary); payslips and statements add to it.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
