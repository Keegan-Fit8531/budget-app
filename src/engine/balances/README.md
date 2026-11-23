# engine/balances/

What payday sends each account, and what's in each account over time. An account's **payday mode**
(`SplitLine.mode` in `core/types.ts`) decides how its amount is worked out:
- **fixed**: a set amount every pay.
- **exact**: that pay's own costs, debt payments, money put aside and goal amounts.
- **smooth** ("Steady"): a level amount, worked out over a long run of pays, so 4- and 5-week pays even out.

## Files
- `deposits.ts`: **the one place to ask what payday sends**: `depositFor(budget, accountId, period)`. Order: for a locked pay, a one-pay adjustment (`overrides`) that differs from the frozen split, else the frozen split; then a one-pay adjustment; then the account's mode (`liveDepositFor`). Also `depositSansBalance` and `depositPending` (a balance dated on payday that doesn't include the deposit yet).
- `outflows.ts`: money leaving an account between two dates: `outflows` (costs and debt payments; money put aside stays, so it isn't here), `fundedOut` (what payday has to fund, including put-aside amounts), `exactNeed` (what exact mode sends), `modeOf` / `accountMode`. Gem Visa money held in another account until statement day is handled here: at least Gem's recommended amount, unless you set the statement's amount yourself (`Debt.heldPay`, from the bill check), which replaces it.
- `steady.ts`: steady amounts. A "run" goes pay by pay from the balance you entered (about 40 pays), each pay's amount worked out from what's projected to be left before it. `steadyFor`, `smoothAmount` (what Deposits shows), `levelAmount` (for Balance this pay: the amount that keeps every pay in the next 12 at the usual amount). Amounts are to the cent, or rounded up to the account's rounding (`Account.round`, e.g. Rent in whole dollars: `steadyStep`, `usualSteady`). Runs are cached per budget object and per input (`cached`, `runKey`).
- `freeze.ts`: once a pay is locked (payday has passed, or its pay or payslip is in), what payday sent is frozen in `budget.splitSent` so automatic changes (balancing, a debt paid off) don't rewrite it. The freeze takes in one-pay adjustments there at the time, so code that removes one by hand has to update `splitSent` too, or the frozen figure keeps the amount (the Planner's "this pay only" edit and `features/planner/logic/allocate.ts` → `undoAllocation` do). `paySplitLocked`, `freezePaySplit`, `freezePaySplitFrom`, `freezeLockedPays`, `unfreezePaySplit`.
- `estimate.ts`: balances over time from the last balance you entered: `estimateBalance`, `balanceToday`, `balanceOn`, `forecastBalances`.
- `projection.ts`: what an account can spare (`spareBalance`, `spareInfo`), the next pay a steady account needs its cushion for (`nextBufferUse`, the Planner's "Buffer" pill), and a pay day by day (`payProjection`).
- `billTracker.ts`: the live bill tracker for the current pay (Accounts): each bill paid or still to come against what's in the account (`billTracker`); for a bank-connected account the bank decides what's paid (`engine/billMatch.ts`, `late` once due). A held debt's payment (Gem) is a row with `debtId`, in `toCome` until the bank shows it; part-paid, the rest is its own row (`rest`, `splitPartPaid`). Also `toMove` (bills paid on another account's card whose money is still here) and `moves`.
- `topUps.ts`: exact accounts that pay bank bills top up: whatever's left from earlier pays counts towards the next (`topsUp`, `exactTopUp`), and what was in an account before the budget's first pay (`leftoverBeforeBudget`).
- `balances.test.ts`: frozen splits, payday morning before the deposit lands, the bill tracker.

## Watch out for
- These functions call each other a lot (deposits ↔ outflows ↔ steady ↔ projection). When you add one, put it in the file whose job it matches and import it directly from there.
- The run cache relies on the store cloning the budget for each change. Don't mutate a budget in place and then expect fresh figures from the same object in the same render.
- A part payment of a held debt never pays a whole plan; it counts in `toMove` only once the bill check's "Yes, that paid it" is answered.
- `today` is a parameter almost everywhere (default `todayISO()`), so tests can fix the date. Keep passing it through.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
