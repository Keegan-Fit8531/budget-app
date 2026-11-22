# services/

The app's connections to the outside world. Each folder holds the connection's code, its tests, and its own
settings card (shown on Settings).

## Folders
- `bank/`: the bank connection (Akahu, NZ open banking, through your own Supabase function), bank and card exports (CSV) read on the device, and what bank transactions tell us (card payments, savings-fund moves).
- `sync/`: syncing the budget with a file in a private GitHub repo (`budget-data`), and connecting another device by QR code.
- `reader/`: reading documents (payslips, card and loan statements, Afterpay and card-app screenshots, KiwiSaver statements, bank balances) with Google's Gemini or on the device, checking what was read, and applying it.

## Watch out for
- Secrets (GitHub token, Gemini key, bank passphrase) live in this browser's localStorage only, set from the settings cards. Never put them in the budget, the repo or the code.
- These call the outside world with plain `fetch`. Tests fake every reply; no test talks to a real service.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a folder here (see AGENTS.md).
