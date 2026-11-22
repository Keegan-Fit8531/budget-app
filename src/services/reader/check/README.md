# services/reader/check/

Checking what was read. The reader's answer (`Extraction`) becomes a `Draft` you can correct in the rundown;
every field is checked here, and only a draft with no blocking problems becomes a `Proposal`, the exact changes
`../apply.ts` makes. Nothing in this folder changes the budget.

## Files
- `draft.ts`: the types: `Draft` (one per document kind), `DraftBalances`, `DraftKiwiSaver`, `DraftTransactions`, `DraftPlanRow`, `DraftOrder`, `DraftPurchase`, `Proposal` (what will change), `Review` and `Issue` (`block` stops Confirm, `note` doesn't). Constants: `NEW_DEBT`, `NEW_GOAL`, `NOT_MINE` (rundown choices), `MAX_CENTS`, `ENDS_SLACK_DAYS`.
- `figures.ts`: `toCents` (text as printed → cents; "CR" or a minus means in credit), `validDate`, and which debts a document can be for (`statementDebts`, `isStudentLoan`, `afterpayDebt`, `ordersOnly`, `keepsPlans`).
- `toDraft.ts`: `toDraft` (the reader's answer → a draft, matched to your debts, accounts and goals) and `guessDebt` (the card from the name on it).
- `review.ts`: `review(draft, budget, today)`, the entry point: picks the check for the document's kind. Also KiwiSaver statements, payslips, and matching statement rows and Afterpay orders to your plans (`resolvePlanRow`, `resolveOrder`, `purchaseRows`).
- `statement.ts`: the two biggest checks: card and loan statements, and card-app screenshots (`reviewStatement`), and Afterpay (`reviewAfterpay`).
- `balances.ts`: a bank's list of accounts and balances: `balanceTargets`, `matchAccount` (by number, else by name), `balancesDraft`, `reviewBalances`.
- `transactions.ts`: bank and card exports and bank statements: `csvTargets`, `matchEnding`, `newTransactions` (skip ones already saved), `csvBalance` (what's owed after them), `checkedBalance`, `reviewTransactions`.
- `check.test.ts`: statements, Afterpay, payslips, card screenshots, telling cards apart, and bank balances. Each test reads a made-up answer through `toDraft` → `review` → `applyProposal`.

## Watch out for
- Any new kind of document needs: a `Raw…` type in `../types.ts` and the form in `../prompt.ts`, a `Draft` case here, its check reached from `review()`, a `Proposal` case, and its change in `../apply.ts`.
- A plan row with $0 left is a finished plan: matched, it's taken off; unmatched, it's skipped (never added). Gemini is told to send completed plans as 0 (`../prompt.ts`).
- Amounts are kept as typed text in a draft (so you can correct them) and turned into cents only when checked.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
