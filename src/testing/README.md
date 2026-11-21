# testing/

Shared test helpers, and the test that keeps the READMEs honest. A feature's own tests sit next to its code as `*.test.ts`.

## Files
- `fixtures.ts`: test budgets and helpers used across test files: `budget()` (blank, paid on the 19th, balancing off), `debtBudget()` (with Gem Visa, Q Mastercard, Afterpay and a student loan), `seq` (predictable ids), document-reading helpers (`checkDoc`, `upload`, `gemStatement`), `debt`, and a made-up card export (`qExport`, `csvDoc`).
- `readmes.test.ts`: fails if a folder in `src/` has no `README.md`, or a README doesn't mention a file or folder in it.

## Watch out for
- Tests never talk to real services: Gemini, GitHub and the bank are always faked, and all data is made up.
- Pass a fixed `today` to the functions you test, so a test gives the same answer every day.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
