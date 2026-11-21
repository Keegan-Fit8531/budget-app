# scripts/

Node scripts run by `npm` (see `package.json`), not part of the app itself.

## Files
- `copy-ocr.mjs`: copies the text-recognition engine (Tesseract.js and its English data) from `node_modules` into `public/ocr/` (git-ignored), so the on-device reader (`src/services/reader/documents.ts`) can load it. Runs automatically before `npm run dev` and `npm run build` (`npm run ocr`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
