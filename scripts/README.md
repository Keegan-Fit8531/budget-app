# scripts/

Node scripts run by `npm` (see `package.json`), not part of the app itself.

## Files
- `uses.mjs`: `npm run uses -- <name>` lists every file and line in `src/` that uses a function, type or field; `npm run uses -- engine/envelope.ts` does it for each thing a file exports. It's a whole-word search, so a field with the same name shows up too. Tests are listed apart.
- `copy-ocr.mjs`: copies the text-recognition engine (Tesseract.js and its English data) from `node_modules` into `public/ocr/` (git-ignored), so the on-device reader (`src/services/reader/documents.ts`) can load it. Runs automatically before `npm run dev` and `npm run build` (`npm run ocr`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
