# testing/

Shared test helpers, and the test that keeps the READMEs honest. A feature's own tests sit next to its code as `*.test.ts`.

## Files
- `fixtures.ts`: test budgets and helpers used across test files: `budget()` (blank, paid on the 19th, balancing off), `foodGasBudget()` (shaped like the real Food and gas account: three envelopes, Steady, an Everyday account money is moved to), `debtBudget()` (with Gem Visa, Q Mastercard, Afterpay and a student loan), `seq` (predictable ids), document-reading helpers (`checkDoc`, `upload`, `gemStatement`), `debt`, a made-up card export (`qExport`, `csvDoc`), and bills with bank transactions (`billsBudget`: Misc bills and Weekly allowance, both bank-connected; `billTxns` makes payments and transfers).
- `inspect.ts`: `inspectAll` / `inspectAccount`: a plain-text report of a budget the way the Accounts page sees it (allocated this pay, balance, spare, each bill paid or to come with the bank transaction that paid it (and where), money to move back, money put aside (each set-aside, and spare above the max), what Bill check asks (with its keys), envelopes and what counted (each transfer with the purchase it was matched to), transfers it asks about, next pays, Steady buffer, recent transactions). Printed by `npm run inspect` (`scripts/inspect.ts`). `inspect.test.ts` tests it.
- `readmes.test.ts`: fails if a folder in `src/` has no `README.md`, or a README doesn't mention a file or folder in it.
- `structure.test.ts`: fails if a file is over 500 lines, if `core/`, `engine/` or a `logic/` folder imports React or a component, if `ui/` imports budget code (`app/`, `engine/`, `state/`, `features/`, `services/`, `shared/`), or if `core/` imports code (not just types) from elsewhere. Each failure says what to change.

## Watch out for
- Tests never talk to real services: Gemini, GitHub and the bank are always faked, and all data is made up.
- Pass a fixed `today` to the functions you test, so a test gives the same answer every day.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
