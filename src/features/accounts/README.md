# features/accounts/

Accounts (`#/accounts`): what's in each bank account, what it's for before next payday and where it's
heading; and the Deposits pop-up (`#/accounts/deposits/<id>`) that sets what payday sends each account.

## Files
- `AccountsPage.tsx`: the page: the total across accounts vs what this pay allocated them, and an account card per account (icon, name, next payday's amount, where the balance came from via `shared/SyncPill.tsx`, the balance beside what this pay allocated it (`depositFor`), the month tracker), typing in a balance, Reorder, and the + for a one-off cost.
- `Deposits.tsx`: the Deposits pop-up: each account's payday amount (`shared/PaydayControl.tsx`) and its costs (`shared/ItemModal.tsx`), by group (`DepositsModal`, `AccountSection`); `AccountPayday` is one account's version, used as a tab in the account's pop-up.
- `AccountEdit.tsx`: an account's pop-up with tabs (`AccountTab`: `balance`, `cost` (a one-off cost), `payday`): `AccountEditModal`. Also opened from the Planner's cards.
- `AccountHistory.tsx`: one-off costs (`OneOffCostModal`, `OneOffCostForm`: money spent outside the plan, like a tyre puncture) and the account's history list.
- `EnvelopeCards.tsx`: an account's envelopes. `EnvelopeSummary` (on the card): one line each, "Food shop · this week  $150 of $200 left" with a thin bar, and the question for a transfer out it couldn't place ("Was it for Food shop / Car gas … or just moving money?", saved in `budget.envelopeTransfers`). `EnvelopeDetails` (behind Details): how each works, the purchases counted, later weeks kept, each transfer counted (with Change). Used by `MonthTracker.tsx`.
- `BankSeen.tsx`: what the bank shows on the tracker: how each paid bill went out (`paidHow`: "Weekly allowance card · made up 18 Nov"), money to move back for a bill paid on another card (`ToMoveNotes`), and money you moved in or out yourself (`MovesSummary`, the line that explains a big spare; `OtherMoves`, the list).
- `BillCheck.tsx`: the bill check pop-up (`BillCheckModal`, `BillCheckButton` in the page header, `useBillCheck`): after a bank sync, opens by itself when there's something new (including "Did Weekly allowance pay Gem Visa's $272?" for a held debt) (keys already shown are kept in this browser), from `logic/billCheck.ts`. Answers are saved in `budget.billChecks`.
- `MonthTracker.tsx`: an account's live tracker for this pay (bills paid and to come, against what's in it, from `engine/balances/billTracker.ts`) and a future pay day by day (`PayProjectionView`). Each shows a short summary, then the card's Details button (`toggle` prop), then the details. An account with only envelopes shows just its envelope lines.
- `logic/`: account history and the payday-mode labels (its own README).

## Watch out for
- Keep the card short on a phone: figures and one line per item, plus what needs doing (a transfer to place, money to move, short). Notes that explain go inside the Details `Collapse`, not above it. Check with `npm run screenshot -- '#/accounts' --width 400 --dark --click 'text=Later' --only '.acct:has-text("Food and gas")'`.
- Balances you enter are kept with their date (`budget.balances`) and in the history; every projection carries on from the latest one.
- What payday sends comes from `engine/balances/deposits.ts` → `depositFor`. The labels for each payday mode are in `logic/paydayModes.ts`.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
