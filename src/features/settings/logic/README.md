# features/settings/logic/

Plain functions behind Settings (no React).

## Files
- `export.ts`: export a pay as a spreadsheet (.xlsx): `exportablePeriods` (which pays can be exported), `periodLabel` ("November 2026 pay"), `exportFileName`, `monthSheets` (a summary, what payday sends each account, every payment due), `downloadMonth` (loads the spreadsheet writer, `write-excel-file`, only when used).
- `export.test.ts`: which pays can be exported, and that the sheets' numbers add up.

## Watch out for
- Keep the spreadsheet library lazily loaded (dynamic `import()`), so it isn't in the app's first load.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
