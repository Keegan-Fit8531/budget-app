# services/bank/

Bank transactions and balances, two ways: the **bank connection** (Akahu, read-only, through a small server
function you own on Supabase, so Akahu's tokens never reach the browser), and **exports** (CSV files) read on
the device and never sent anywhere.

## Files
- `bank.ts`: the bank connection: `fetchBank` (accounts and transactions since a day, with this browser's passphrase), `applyBank` (new transactions onto each linked account or card, a card's pending ones to `Debt.pending`, goals' balances), `suggestLink` (by account number ending, or a card's name and bank), `newCardLinks` (a new card that's clearly one debt links itself), `addGoalFor`, `bankSync`, `BankError`. Syncs at most hourly while open (`AUTO_EVERY_MS`).
- `bankConfig.ts`: the connection's settings in this browser (`BANK_URL`, `readBankConfig`, `writeBankConfig`), kept apart so the QR code can set them without loading `bank.ts`.
- `BankCard.tsx`: Settings → Bank connection (`BankCard`: passphrase, and which account or card each bank account fills), `syncBank` (the hourly sync and tapping a Synced pill; links new cards, then fetches their full history once: `backfill`), `BankAutoSync` (mounted by `app/App.tsx`: syncs on open and hourly), `useBankSyncing`, and the "bank synced" event other parts follow.
- `csv.ts`: reading exports on the device: `readTransactionsCsv` (finds the date, description and amount columns by name), `parseCsv`, `csvDate` (NZ day-first dates), `csvAmount` (-$44.60, (12.40), 12.40 DR), `endingOf` (account number ending in a file name or header), `fromStatementRows` (rows read from a bank statement by Gemini, in the same form), `joinReads`.
- `cardPayments.ts`: payments to cards (Gem Visa, Q Mastercard), seen as transfers out of a linked bank account: `cardPaid`, `debtLinked`, `debtNamed`, `recordCardPayments` (for a card not linked itself (Q), takes what was paid over the plan off what's owed; a linked card's (Gem) are only noted; a planned payment the bill check says is still to send (`unpaid` key) doesn't count as planned, so the later payment for it all comes off), `knownSince`.
- `goalMoves.ts`: money moved to or from a savings goal's fund at another provider, seen in a linked account (ANZ → Kernel): `goalMoved`, `goalWords`, `recordGoalMoves`, `settleGoalMoves`, `setGoalBankBalance`.
- `bank.test.ts`, `csv.test.ts`, `cardPayments.test.ts`: tests (all bank replies and files are made up).

## What the bank sends
- `Txn.description` is the bank's own text. Card purchases: "Skinny Fixed Card number: 4835 **** **** 3102" (the last 4 digits name the card, so they say which account's card paid). Transfers between your own accounts: "To: 06-0115-0324910-55 Debit Transfer 083615" / "From: … Credit Transfer …", read only by `engine/transfers.ts`. Older CSV rows say "06-0115-0324910-00 DEBIT TRANSFER" with no To/From.
- `merchant` and `category` come only from the bank connection, not from CSV exports.
- Where CSV imports and the bank connection overlap, the same payment can be stored twice with different text ("VT SPARK PAY MO" and "Spark Pay Mo Card number …"). Matching code should use each transaction once (see `engine/billMatch.ts`).
- Pending rows (`budget.pendingTransactions`) can post days later under a different date; the synced balance already includes them.
- The balance can move before the transactions behind it arrive (an account at $0 whose transactions still add up to $200): the bank sends some transfers out a day or two late, in neither list. Don't fix the app for it; test the case on a copy with the missing rows added (`scripts/README.md`).

## Watch out for
- A new kind of account (a card just linked): look at what it really sent in `../budget-data` (its transactions and `pending`) before building on it: Gem's moves purchases onto plans ("PLAN TRANSFER OUT/IN" pairs), and its balance leaves pending purchases out.
- The server function (`akahu-sync` in the owner's Supabase project) isn't in this repo: read it with the Supabase tools (`get_edge_function`). It sends each account's `balance.current`/`available`, settled transactions and pending ones, nothing else. Akahu has no field for a card's minimum or amount to avoid interest (those come from statements).
- After an app update, the hourly sync still waits an hour from the last one (`AUTO_EVERY_MS`, `lastSync` in this browser): something new in a sync only shows on the next one, or on tapping a sync pill.
- A card's `balance.current` leaves out purchases still pending (Gem: a big one can stay pending for days), so a linked card's owed is that plus `Debt.pending`. After that, `features/debts/logic/cardPlans.ts` builds Gem's 6-month plans from its plan transfers (one per statement month), and the balance is applied as a statement: what's over comes off those guesses first, then plans set by the owner or a statement, never a pending purchase's plan. Check a change like this with two syncs and a reload (`scripts/README.md`): the plans must not move.
- Akahu supports Gem Visa (Latitude) but not Q Mastercard (humm), so Q's balance still comes from statements and payments seen in ANZ.
- Where a bank account's transactions go is `budget.bankLinks` (`'account:<id>'`, `'debt:<id>'`, `'saving:<id>'` or `'ignore'`). When each last came through is `budget.bankSeen`.
- Pending (unsettled) transactions are replaced on every sync and never kept (`budget.pendingTransactions`).
- An export doesn't say which card or account it's for: you're asked, and its number's ending is remembered on that account for next time.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
