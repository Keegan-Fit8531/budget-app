# features/accounts/

Accounts (`#/accounts`): what's in each bank account, what it's for before next payday and where it's
heading; and the Deposits pop-up (`#/accounts/deposits/<id>`) that sets what payday sends each account.

## Files
- `AccountsPage.tsx`: the page: the total across accounts vs what this pay allocated them, and an account card per account (icon, name, next payday's amount, where the balance came from via `shared/SyncPill.tsx`, the balance beside what this pay allocated it (`depositFor`), the month tracker), typing in a balance, Reorder, and the + for a one-off cost.
- `Deposits.tsx`: the Deposits pop-up: each account's payday amount (`shared/PaydayControl.tsx`) and its costs (`shared/ItemModal.tsx`), by group (`DepositsModal`, `AccountSection`); `AccountPayday` is one account's version, used as a tab in the account's pop-up.
- `AccountEdit.tsx`: an account's pop-up with tabs (`AccountTab`: `balance`, `cost` (a one-off cost), `payday`): `AccountEditModal`. Also opened from the Planner's cards.
- `AccountHistory.tsx`: one-off costs (`OneOffCostModal`, `OneOffCostForm`: money spent outside the plan, like a tyre puncture) and the account's history list.
- `EnvelopeCards.tsx`: an account's envelopes. `EnvelopeSummary` (on the card): one line each, "Food shop · this week  $150 of $200 left" with a thin `PartsBar` (spent / left / over, tappable), and the question for a transfer out it couldn't place ("Was it for Food shop / Car gas … or just moving money?", saved in `budget.envelopeTransfers`). `EnvelopeDetails` (behind Details): how each works, the purchases counted, later weeks kept, each transfer counted (with Change). Used by `MonthTracker.tsx`.
- `AsideCards.tsx`: an account that only holds money put aside (Car maintenance): `AsideSummary` (on the card: the bar and Put aside / Next pay adds tiles, and "$200 to Weekly allowance on 23 Nov. Was it spent from the money put aside?" for money out this pay, saved in `budget.asideSpends`), `AsideSpendsDetail` (behind Details: "Spent from put aside", each answer with Change, and the 12 months' total per cost). Used by `MonthTracker.tsx`.
- `BankSeen.tsx`: what the bank shows on the tracker: how each paid bill went out (`paidHow`: "Weekly allowance card · made up 18 Nov"), money to move back for a bill paid on another card (`ToMoveNotes`), and money you moved in or out yourself (`MovesSummary`, the line that explains a big spare; `OtherMoves`, the list).
- `BillCheck.tsx`: the bill check pop-up (`BillCheckModal`, `BillCheckButton` in the page header, `useBillCheck`): after a bank sync, opens by itself when there's something new (including "Was Gem Visa's $272 paid from Weekly allowance?" for a held debt) (keys already shown are kept in this browser), from `logic/billCheck.ts`. Answers are saved in `budget.billChecks`; "Your answers" lists them with Undo, and the header button stays while there are answers to undo. `AskAmount`: the amount box for an answer that needs one (Gem's "No, Misc bills paid it").
- `MonthTracker.tsx`: an account's live tracker for this pay (from `engine/balances/billTracker.ts`): a `ui/PartsBar.tsx` with paid bills first (grey), then the balance split by what it's for, so everything after the paid bills adds up to the balance (red: what it can't cover); a one-line key under it; then the Details button (`toggle` prop) and the details. `PayProjectionView`: a future pay day by day. An account with only envelopes shows just its envelope lines.
- `logic/`: account history and the payday-mode labels (its own README).

## Watch out for
- The "To come" tile and figure include a held debt's payment (Gem Visa, before it's sent): it says "incl. Gem". Don't take it off the balance again.
- Misc bills' "Spare … above the max" is what's left after bills *and* the set-asides' max (Haircut $60): the set-aside is full. `npm run inspect -- misc` prints both.
- To check a bar part, tap it in a screenshot: `--click '.acct:has-text("Misc bills") .parts-bar button[aria-label^="Haircut"]' --only '.acct:has-text("Misc bills")'`.
- The tracker's key leaves out Paid and Spare (the tiles show them) and must fit one line on a 390px phone.
- Put a new part of the card in its own file, as `EnvelopeCards.tsx` and `AsideCards.tsx` are.
- Keep the card short on a phone: figures and one line per item, plus what needs doing (a transfer to place, money to move, short). Notes that explain go inside the Details `Collapse`, not above it. Check with `npm run screenshot -- '#/accounts' --width 400 --dark --click 'text="Later"' --only '.acct:has-text("Food and gas")'`.
- Balances you enter are kept with their date (`budget.balances`) and in the history; every projection carries on from the latest one.
- What payday sends comes from `engine/balances/deposits.ts` → `depositFor`. The labels for each payday mode are in `logic/paydayModes.ts`.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
