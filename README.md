# Paydays

A payday-to-payday budget planner (NZD). Works on laptop and phone, and can be installed to the home screen.

- Pay periods run from payday to the day before the next payday (19th, Sat → Fri, Sun → Mon).
- Weekly, fortnightly, monthly and yearly costs are counted by how often they really happen in each period, so 4- vs 5-week periods show up before payday.
- Every amount can be viewed as this period, week, fortnight, month average or year.

## Run it

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # pay-period engine tests
npm run build   # production build in dist/
```

## Design

How the app looks is set in one place, so pages stay consistent:

- `src/index.css` holds the tokens (colours, type sizes, spacing, corner radii, light and dark) and the classes built on them. Pages use those rather than their own values.
- `src/components/ui.tsx` holds the shared pieces: the page header, anything that opens (`Disclosure`, `Section`), account icons and colour dots, and the colour picker.
- `src/lib/colors.ts` holds the palette for accounts, groups and categories. Colours saved by earlier versions are shown as their nearest palette colour; nothing saved is changed.

The rules it follows: the brand colour is for the sidebar, primary buttons and payday; green and red only ever mean "fine" and "short"; an account's colour is a small mark beside its name, never a whole card. Each screen shows the figures you came for, with the working behind them one click away.

## Your data

Everything you enter is saved in your browser only (localStorage), never sent anywhere. Use
Settings → Download backup to keep a copy, and Restore backup to move it to another browser or device.

The published app starts with a blank budget. `src/lib/personal/` (git-ignored) can hold your own
starting data, one-off data updates and the tests that use them; it stays on your computer.

## Publishing

Pushing to `main` builds the app and publishes it to GitHub Pages (`.github/workflows/pages.yml`).
