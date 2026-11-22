# scripts/

Node scripts run by `npm` (see `package.json`), not part of the app itself.

`inspect` and `screenshot` show the owner's own money: read the output, but never paste it into commits, PRs,
code or test fixtures (make up the numbers there, as `src/testing/fixtures.ts` does).

## Files
- `uses.mjs`: `npm run uses -- <name>` lists every file and line in `src/` that uses a function, type or field; `npm run uses -- engine/envelope.ts` does it for each thing a file exports. It's a whole-word search, so a field with the same name shows up too. Tests are listed apart.
- `inspect.ts`: `npm run inspect -- [account] [--today YYYY-MM-DD] [--file path]` prints the real budget (`../budget-data/budget.json` by default) the way the app sees it, after the same loading steps (`src/state/upgrade.ts`), using `src/testing/inspect.ts`. Read-only. Run with `vite-node`, so it can use the app's TypeScript.
- `screenshot.mjs`: `npm run screenshot -- '#/accounts' [--today YYYY-MM-DD] [--file path] [--width 400] [--out file.png]` opens the running dev server (`npm run dev` first) in a browser holding the real budget, in New Zealand time, and saves a full-page picture outside the repo (it prints the path). No sync is set up there, so nothing is written back. Needs Playwright.
- `copy-ocr.mjs`: copies the text-recognition engine (Tesseract.js and its English data) from `node_modules` into `public/ocr/` (git-ignored), so the on-device reader (`src/services/reader/documents.ts`) can load it. Runs automatically before `npm run dev` and `npm run build` (`npm run ocr`).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
