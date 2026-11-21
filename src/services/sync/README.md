# services/sync/

Sync: the budget is saved to a file (`budget.json`) in your own private GitHub repo (`budget-data`), so every
browser and device sees the same budget. Each browser keeps the repo name and a GitHub token (one that can
only read and write that repo) in its own storage.

## Files
- `sync.ts`: the GitHub contents API, with plain `fetch`: `pullBudget` (the repo's copy and its version, `sha`), `pushBudget` (save, replacing version `sha`), `readSyncConfig` / `writeSyncConfig`, `SyncError`. Connecting another device: `pairingLink` (a link for the QR code, optionally carrying the Gemini key and bank settings too) and `takePairingFromUrl` (reads that link when the app opens from it, then removes it from the address bar).
- `SyncCard.tsx`: Settings → Sync: connect a repo, the sync status, and the connect-another-device QR code (`ConnectQr`; `guessRepo` suggests the repo name).
- `sync.test.ts`: pairing links and the config they carry.

## Watch out for
- When to pull and push, and which copy wins, is decided in `state/store.tsx` (the newest `updatedAt` wins; the other is kept as a saved copy). This folder only talks to GitHub.
- Every repo copy is checked with `core/valid.ts` → `looksLikeBudget` before it can replace the budget.
- The app writes `budget.json` at the repo root by default (`SyncConfig.path`). Moving it in the repo breaks sync for every connected device.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
