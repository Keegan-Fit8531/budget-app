# testing/

Shared test helpers, and the tests that keep the notes honest and short. A feature's own tests sit next to its code as `*.test.ts`.

## Files
- `fixtures.ts`: test budgets and helpers: `budget()` (blank, paid on the 19th, balancing off), `foodGasBudget()` (shaped like the real Food and gas account), `debtBudget()` (Gem Visa, Q Mastercard, Afterpay, a student loan), `billsBudget()` / `billTxns` (bank-connected bills), `seq` (predictable ids), `debt`, document helpers (`checkDoc`, `upload`, `gemStatement`), a made-up card export (`qExport`, `csvDoc`).
- `inspect.ts`: `inspectAll` / `inspectAccount`: a plain-text report of a budget the way the Accounts page sees it (allocated this pay, balance, spare, each bill paid or to come with the bank transaction that paid it (and where), money to move back, money put aside (each set-aside, and spare above the max), what Bill check asks (with its keys), envelopes and what counted (each transfer with the purchase it was matched to), transfers it asks about, next pays, Steady buffer, recent transactions). Printed by `npm run inspect` (`scripts/inspect.ts`). `inspect.test.ts` tests it.
- `notes.test.ts`: fails if a folder in `src/` has no `README.md`, a README doesn't mention a file or folder in it, or AGENTS.md or a README is over its size limit (see AGENTS.md → Keeping the notes short).
- `structure.test.ts`: fails if a file is over 500 lines, if `core/`, `engine/` or a `logic/` folder imports React or a component, if `ui/` imports budget code (`app/`, `engine/`, `state/`, `features/`, `services/`, `shared/`), or if `core/` imports code (not just types) from elsewhere. Each failure says what to change.

## Watch out for
- Tests never talk to real services: Gemini, GitHub and the bank are always faked, and all data is made up.
- Pass a fixed `today` to the functions you test, so a test gives the same answer every day.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
