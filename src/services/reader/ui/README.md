# services/reader/ui/

The screens for reading documents: reading, the rundown to check and correct, and the Settings card.

## Files
- `UploadFlow.tsx`: the one upload flow, used by the Add button and the Planner (loaded only when a document is chosen): `UploadQueue` (several files, one after another) and `UploadFlow` (reading with progress → rundown → Confirm, or a clear error with Try again, Read on this device, or Type it in instead).
- `Rundown.tsx`: the rundown: every change the document would make, each field editable, problems shown (from `../check/`), and Confirm. `Money` is its amount field.
- `RundownChecks.tsx`: the rundown's sections for bank balances (`BalancesCheck`), KiwiSaver (`KiwiSaverCheck`) and exports or bank statements (`TransactionsCheck`).
- `ReaderCard.tsx`: Settings → Reading documents: the Gemini key (kept in this browser only) and the model.

## Watch out for
- Confirm re-checks the preview's `fingerprint` (`../apply.ts`), so what's applied is what you saw.
- A change can be undone from Settings → Saved copies; say so after a document is applied.
- Keep `UploadFlow.tsx` loaded lazily (`lazy(() => import(...))` in `app/AddMenu.tsx` and `features/planner/PlannerPage.tsx`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
