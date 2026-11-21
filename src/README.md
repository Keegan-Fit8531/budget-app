# src/

The whole app. `AGENTS.md` at the repo root has the folder map, a "where to look" table and the rules the
code relies on; read it first. Every folder here has its own README listing its files.

## Files and folders
- `main.tsx`: the entry point (`index.html` loads it). Applies the theme, wraps `app/App.tsx` in the budget store (`state/store.tsx`) and an error boundary, imports the stylesheet (`ui/styles/index.css`), and registers the service worker (`public/sw.js`) in production.
- `vite-env.d.ts`: Vite's types (`import.meta.env`, `import.meta.glob`).
- `app/`: the app shell: routing between pages, navigation, the Add button.
- `core/`: the saved budget's types, and small helpers for dates, money, colours, ordering and validation.
- `engine/`: the budget maths: pay periods, when costs fall, money put aside, what payday sends each account, automatic balancing.
- `features/`: one folder per page (planner, accounts, debts, savings, insights, settings), each with its page, pop-ups and `logic/`.
- `services/`: connections to the outside: the bank (Akahu, CSV exports), sync (a private GitHub repo), and reading documents (Gemini, or on the device).
- `shared/`: budget-aware components used by more than one page.
- `state/`: the budget store (`useBudget`), saved daily copies, and which pay is being viewed.
- `testing/`: shared test fixtures, and the test that checks these READMEs.
- `ui/`: the design system: shared components, icons, charts, the stylesheet and theme.

## How it fits together
`main.tsx` → `state/store.tsx` (`BudgetProvider` holds the one `Budget`) → `app/App.tsx` picks a page from the
URL hash → the page in `features/<page>/` reads the budget with `useBudget()`, works its figures out with
`engine/` and its own `logic/`, and draws them with `ui/`. Every change goes back through `useBudget().update(fn)`.

`personal/` is git-ignored and only exists on the owner's computer: a `migrate.ts` there is a one-off data
update that `state/store.tsx` runs when the budget loads. It's never in the published app.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file or folder here (see AGENTS.md).
