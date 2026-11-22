# Paydays

A payday-to-payday budget planner (NZD). Works on laptop and phone, and can be installed to the home screen.

- Pay periods run from payday to the day before the next payday (19th, Sat → Fri, Sun → Mon).
- Weekly, fortnightly, monthly and yearly costs are counted by how often they really happen in each period, so 4- vs 5-week periods show up before payday.
- Money put aside (a WOF, tyres, a service) is a cost with "Put aside, don't pay out" ticked: each payday sends its share and it stays in the account until you need it, however much has built up.
- When you spend from an account outside the plan (a tyre puncture), record it with the + beside its balance in Accounts: it comes off the balance and is kept in the account's history, with every balance you enter.
- What payday sends each account is set in Deposits, a pop-up on Accounts. Accounts, debts and goals can be put in your own order with Reorder.
- Payments to Gem Visa, Q Mastercard and other cards that can't be linked to the bank are picked up from your linked bank accounts on each sync: whatever they pay over what was planned comes off what's owed.
- KiwiSaver is its own card on Savings: payday sends it nothing (it comes from your salary). Each balance is kept, from the bank connection, a statement or breakdown you upload, or typed in, with each fund's value, so it charts each fund over time, what went in, and the gains and losses between balances.
- Every amount can be viewed as this period, week, fortnight, month average or year.

## Run it

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # all tests (next to the code they test, as *.test.ts)
npm run build   # production build in dist/
```

## Finding your way around the code

The code is grouped by what it does, and every folder in `src/` has a `README.md` saying what's in it:
`app/` (the shell), `core/` (data types and helpers), `engine/` (the budget maths), `state/` (the store),
`features/` (one folder per page), `services/` (bank, sync, document reading), `shared/` and `ui/`.

[`AGENTS.md`](AGENTS.md) is the guide for AI assistants (Claude Code reads it through `CLAUDE.md`, Cursor reads it
directly): the folder map, where to look for each kind of change, the rules the code relies on, and the
rule that every change updates its folder's README. A test (`src/testing/readmes.test.ts`) fails if a
README is missing or doesn't mention a file in its folder.

## Design

How the app looks is set in one place, so pages stay consistent:

- `src/ui/styles/tokens.css` holds the tokens (colours, type sizes, spacing, corner radii, light and dark), and the other files in `src/ui/styles/` the classes built on them. Pages use those rather than their own values.
- `src/ui/components.tsx` holds the shared pieces: the page header, anything that opens (`Disclosure`, `Section`), account icons and colour dots, and the colour picker.
- `src/core/colors.ts` holds the palette for accounts, groups and categories. Colours saved by earlier versions are shown as their nearest palette colour; nothing saved is changed.

The rules it follows: the brand colour is for the sidebar, primary buttons and payday; green and red only ever mean "fine" and "short"; an account's colour is a small mark beside its name, never a whole card. Each screen shows the figures you came for, with the working behind them one click away.

## Your data

Everything you enter is saved in your browser (localStorage), and in your own private GitHub repo if you
turn on Settings → Sync. Use Settings → Download backup to keep a copy, and Restore backup to move it to
another browser or device.

Documents you upload (payslips, card or loan statements, screenshots of a card's app or of Afterpay) are sent to Google's
Gemini to read, using your own Google key, and shown to you to check before anything changes. With
prepaid (paid) use, Google doesn't use them to train its models. The key is kept in each browser only
(Settings → Reading documents), never in the budget, the repo or the code; the QR code that connects your
phone can carry it. When Gemini can't be used, the app offers to read the document on this device
instead, where it never leaves the device.

Bank and card exports (CSV) are read on the device and never sent anywhere. You're asked which card or
account each is for (the file doesn't say); its number is remembered so the next one is matched, for you
to check. The transactions are kept on that card or account, what's owed or the balance is worked out
from them, and Insights shows what the spending went on.

A copy of everything is saved in the browser once a day, before that day's first change, and kept for
3 months (Settings → Saved copies), so an upload or an edit that went wrong can be put back.

The published app starts with a blank budget. `src/personal/` (git-ignored) can hold your own
starting data, one-off data updates (`migrate.ts`) and the tests that use them; it stays on your computer.

## Publishing

Pushing to `main` builds the app and publishes it to GitHub Pages (`.github/workflows/pages.yml`).
