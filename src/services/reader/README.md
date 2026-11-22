# services/reader/

Reading documents: payslips, card and loan statements (PDF or photo), Afterpay and card-app screenshots,
KiwiSaver statements, bank account statements, and screenshots of a bank's balances. Read by Google's Gemini
with the owner's own key, or on the device when Gemini can't be used. Nothing changes until you've checked a
rundown and pressed Confirm.

## How a read flows
1. `job.ts` → `startRead(file, budget)`, called from a file picker (Add button or Planner). A CSV export is read on the device (`../bank/csv.ts`). A long PDF with real text is read as text, a few pages at a time (`pdftext.ts`).
2. `prepare.ts` gets the file ready (photos shrunk to JPEG, PDFs as they are); `gemini.ts` sends it with `prompt.ts`'s instructions and form; `parseReply` turns the answer into an `Extraction` (`types.ts`).
3. `check/` turns that into a `Draft` you can correct in the rundown (`ui/Rundown.tsx`), checks every field, and makes a `Proposal`: the exact changes.
4. `apply.ts` → `preview` runs the proposal on a copy (the rundown shows what will change); Confirm runs `applyProposal` inside `useBudget().update()`.

## Files
- `job.ts`: starting a read (`startRead`, `ReadJob`, `ReadStage`), `isCsv`, `testKey` (check a Gemini key). Loads the reader code only when a read starts.
- `config.ts`: the model (`DEFAULT_MODEL`, the only place it's named), limits (`TIMEOUT_MS`, `MAX_PDF_BYTES`, `MAX_IMAGE_EDGE`) and the key, kept in this browser only (`readReaderConfig`, `writeReaderConfig`, `modelOf`).
- `prepare.ts`: `prepareFile`, `isPdf`.
- `prompt.ts`: what Gemini is told (`instructions`), the fixed form it answers in (`RESPONSE_SCHEMA`), and `buildContext` (only the debts' and plans' names and ids are sent).
- `gemini.ts`: the Gemini API with plain `fetch` (`call`; the key goes in a header, never the URL), `parseReply`, `geminiProvider`, long documents in parts (`PAGES_AT_ONCE`, `REQUESTS_AT_ONCE`, `mergeReads`, `splitRow`).
- `pdftext.ts`: a PDF's text page by page with its columns kept by spacing (`readPdfPages`, `layoutPage`, `hasText`).
- `types.ts`: the reader's form: `Extraction` and its parts (`RawPayslip`, `RawStatement`, `RawAfterpay`, `RawKiwiSaver`, `RawBalances`), `DocKind`, `Provider`, `ReadContext`.
- `errors.ts`: every way a read can fail, each with its own message (`ReaderError`, `ReaderErrorKind`, `classifyHttpError`, `blockedError`, `errorMessage`); `DEVICE_FALLBACK` lists the ones where reading on the device is offered.
- `local.ts`: the on-device reader (`readOnDevice`, `toExtraction`): fills in the same form, so it goes through the same checks.
- `documents.ts`: on-device reading itself: PDF text or text recognised in a photo (Tesseract OCR, copied to `public/ocr/` by `scripts/copy-ocr.mjs`), `classifyText`, `parseStatementText`, `parseDate`, `matchDebt`, and recording a payslip or statement (`recordPayslip`, `recordStatement`).
- `payslip.ts`: the `Payslip` type and reading the one known payslip layout (`parsePayslipText`, `readPdfText`, `readPayslipPdf`).
- `sortShops.ts`: asking Gemini to place shops the rules left in Other (only shop names and one example each are sent): `sortShops`, `sortInput`, `parseSorted`, `allTxns`.
- `apply.ts`: making the changes: `applyProposal`, `applyStatement`, `applyKiwiSaver`, `windBack` (a debt as it was on a date), `preview` and `fingerprint` (to tell whether the preview changed before Confirm).
- `check/`: the checks between the reader's answer and the changes (its own README).
- `ui/`: the upload screens and the Settings card (its own README).
- `gemini.test.ts`, `bankStatements.test.ts`, `documents.test.ts`: tests. Gemini is always faked.

## Watch out for
- Savings goals, deposits and account balances aren't edited by `apply.ts` directly: they move when the next 12 pays re-balance.
- Reading a document twice must not double anything (transactions are de-duplicated in `check/transactions.ts` → `newTransactions`).
- Google retires models: change `DEFAULT_MODEL` in `config.ts` only.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
