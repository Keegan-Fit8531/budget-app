# features/planner/

The Planner (`#/planner`, the home page): one pay at a time (it opens on the next pay to come). What's left
after the plan, the pay itself, where it goes, the payday split card by card, and what's due.

## Files
- `PlannerPage.tsx`: the page. The leftover and pay figures (type the pay in, or upload a payslip), the "Not balanced yet / Re-balance / Reset to defaults" note, the chart of where pay goes by group, the payday split, the weeks view and the due list. Its figures come from `logic/plannerFigures.ts`; the page keeps only what's typed or clicked (pay, Balance this pay, Optimise's Undo); amounts for one pay only change through `logic/thisPay.ts`.
- `PaydayCard.tsx`: one account in the payday split, and its details pop-up: what payday sends it (or on average), the Short / Spare / Ends / Buffer pill (buffer from `engine/balances/buffer.ts`), each cost this pay, and links to its debt, goal or settings. `PlannerView` is the view it's given.
- `PayNotes.tsx`: "What's different this pay": accounts sending more or less than usual and why, with Change / Reset for an amount set for this pay only.
- `ShortAlert.tsx`: "Gem Visa needs $182 more this pay", with Dismiss (kept in localStorage until what's short changes).
- `DueList.tsx`: "Coming up before next pay" / "Due this period", grouped by day.
- `WeeksView.tsx`: the pay as a calendar, with the weekly costs you chose to show ("Show in Weeks this pay").
- `OptimiseModal.tsx`: Optimise: hand out what's left over to goals, debts, the allowance or spending, for this pay or every pay, with Undo (kept in localStorage: `readOptimiseUndo`, `clearOptimiseUndo`).
- `logic/`: the page's figures, allocation for Optimise, the weeks view, and what balancing changed (its own README).

## Watch out for
- A new figure on the page goes in `logic/plannerFigures.ts` with a test, not in `PlannerPage.tsx`.
- Amounts follow the view mode (`state/period.tsx`): this period, or per week / fortnight (this pay split by its days), or month / year (the next 12 pays averaged). Use `view.v()` for a pay's figure in the view's terms.
- The pay account (where pay lands) isn't in the split: what's left there is the big number.
- Once payday has passed, a change isn't sent by payday any more, so the Planner says to make it as a transfer.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
