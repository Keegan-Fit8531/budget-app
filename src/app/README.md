# app/

The app shell: which page is showing, the navigation around it, and the Add button. No budget maths here.

## Files
- `App.tsx`: routing by URL hash: `#/planner` (default), `#/accounts`, `#/debts`, `#/savings`, `#/insights`, `#/settings`; `#/accounts/deposits/<accountId>` opens Deposits (older `#/deposits/…` links still work). Draws the sidebar and phone bars from `MAIN` and `SETUP`, wraps each page in an `ErrorBoundary`, provides the viewed pay (`state/period.tsx`), and mounts the jobs that run while open: `BankAutoSync`, `ReviewAutoRun`, `ShopSortAutoRun`.
- `AddMenu.tsx`: the Add button's pop-up: add a cost (`shared/ItemModal.tsx`), a debt or a payment (`features/debts/DebtModal.tsx`, `PaymentModal.tsx`), a savings goal (`features/savings/GoalModal.tsx`), or upload documents (starts a read with `services/reader/job.ts` and shows `services/reader/ui/UploadFlow.tsx`).

## Watch out for
- A new page: add it to `MAIN` or `SETUP` and to the `content` switch in `App.tsx`, and give it a folder in `features/`.
- The upload flow is loaded only when used (`lazy(() => import(...))`), so it isn't in the app's first load. Keep it that way.
- Going to another page scrolls to the top, but opening Deposits on Accounts doesn't (see `useHash`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
