# services/bank/

Bank transactions and balances, two ways: the **bank connection** (Akahu, read-only, through a small server
function you own on Supabase, so Akahu's tokens never reach the browser), and **exports** (CSV files) read on
the device and never sent anywhere.

## Files
- `bank.ts`: the bank connection: `fetchBank` (accounts and settled transactions since a day, using the passphrase in this browser), `applyBank` (adds new transactions to each linked account or card, and goals' balances), `suggestLink` (match a bank account by its number's ending), `addGoalFor` (a new goal for a bank account, e.g. KiwiSaver), `bankSync`, `sinceFor`, `BankError` / `bankMessage`. `AUTO_EVERY_MS`: synced at most hourly while open.
- `bankConfig.ts`: the connection's settings in this browser (`BANK_URL`, `readBankConfig`, `writeBankConfig`), kept apart so the QR code can set them without loading `bank.ts`.
- `BankCard.tsx`: Settings → Bank connection (`BankCard`: passphrase, and which account or card each bank account fills), `BankAutoSync` (mounted by `app/App.tsx`: syncs on open and hourly), `useBankSyncing`, and the "bank synced" event other parts follow.
- `csv.ts`: reading exports on the device: `readTransactionsCsv` (finds the date, description and amount columns by name), `parseCsv`, `csvDate` (NZ day-first dates), `csvAmount` (-$44.60, (12.40), 12.40 DR), `endingOf` (account number ending in a file name or header), `fromStatementRows` (rows read from a bank statement by Gemini, in the same form), `joinReads`.
- `cardPayments.ts`: payments to cards that can't be linked (Gem Visa, Q Mastercard), seen as transfers out of a linked bank account: `cardPaid`, `recordCardPayments` (takes what was paid over the plan off what's owed), `knownSince`.
- `goalMoves.ts`: money moved to or from a savings goal's fund at another provider, seen in a linked account (ANZ → Kernel): `goalMoved`, `goalWords`, `recordGoalMoves`, `settleGoalMoves`, `setGoalBankBalance`.
- `bank.test.ts`, `csv.test.ts`, `cardPayments.test.ts`: tests (all bank replies and files are made up).

## What the bank sends
- `Txn.description` is the bank's own text. Card purchases: "Skinny Fixed Card number: 4835 **** **** 3102" (the last 4 digits name the card, so they say which account's card paid). Transfers between your own accounts: "To: 06-0115-0324910-55 Debit Transfer 083615" / "From: … Credit Transfer …", read only by `engine/transfers.ts`. Older CSV rows say "06-0115-0324910-00 DEBIT TRANSFER" with no To/From.
- `merchant` and `category` come only from the bank connection, not from CSV exports.
- Where CSV imports and the bank connection overlap, the same payment can be stored twice with different text ("VT SPARK PAY MO" and "Spark Pay Mo Card number …"). Matching code should use each transaction once (see `engine/billMatch.ts`).
- Pending rows (`budget.pendingTransactions`) can post days later under a different date; the synced balance already includes them.

## Watch out for
- Where a bank account's transactions go is `budget.bankLinks` (`'account:<id>'`, `'debt:<id>'`, `'saving:<id>'` or `'ignore'`). When each last came through is `budget.bankSeen`.
- Pending (unsettled) transactions are replaced on every sync and never kept (`budget.pendingTransactions`).
- An export doesn't say which card or account it's for: you're asked, and its number's ending is remembered on that account for next time.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
