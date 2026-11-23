# features/debts/logic/

Plain functions for debts (no React). The engine uses these too: debt payments are part of every pay's plan.

## Files
- `schedule.ts`: each plan's payments, pay by pay: `planSchedule`, `debtSchedules` (every plan on a debt, given what payday sends it), Mastercard-style cards (`mastercardPurchases`: every purchase 3 months interest-free). `PerPay` / `DebtPay` (a steady amount, plus one-pay amounts by pay start), `usualPay`, `payFor`, `PLAN_LABEL`, `fmt` ($1,234.56 for messages).
- `amounts.ts`: what's owed and sent: `owed` (the entered balance, else the plans added up), `plannedOwed`, `unplanned`, `debtPerPay` / `debtPay` (what payday sends), `projectedOwed`, `historyOwed`, `recordHistory`, `paidIn`, `suggestPlan`, `exactForFirstPlan`.
- `funding.ts`: which account pays: `fundingAccountId` (the hold account if there is one), `debtPaymentsIn` (debt payments leaving an account between two dates), `heldDebtPaymentsIn`, `isHoldDisplayAccount`, `accountHasPlans`, `syncGemToRecommended` (Gem's payday amount follows its recommended allocation).
- `payments.ts`: recording payments: `applyPayment` (soonest due first, across plans), `settleDue` (payments are automatic, so anything due before today counts as paid), `applyPayrollDeduction` (a payslip's student loan deduction), `fitPlansToBalance` (plans that add up to more than the balance come down to it, the way the card applies a payment; $0 plans go), `Applied`.
- `gem.ts`: Gem Visa (Latitude NZ) rules from its Conditions of Use, clause 14: how a payment is split (instalments due, then expiring interest-free purchases by expiry date…), the minimum payment, plan lengths (`GEM_PLAN_MONTHS`, `gemPlanType`, `gemPlanEnds`), `gemPlan` (the recommended payment that clears each plan before it ends), `gemApply` (a payment before the statement that clears this pay's statement payment logs it in `debt.paid`, so the hold account counts it paid), `gemTakeOff` (Gem's order, with no payment recorded), `beforeStatement`.
- `labels.ts`: `KIND_LABEL`, the name shown for each kind of debt (card, buy now pay later, person, loan).
- `advice.ts`: the recommended payment per debt for a pay, each by the lowest that keeps every plan on track (`debtAdvice`, `DebtAdvice`, `offRecommended`).
- `held.ts`: a held debt's payment this pay (`heldNow`: paid and still to send from the hold account's tracker), `endHeld` ("No more this month": `heldPay` is what was paid, plus a `rest` key so the bill check stops asking) and `resumeHeld` (Undo); `setHeld` (set or take off one statement's `heldPay`, also used by the bill check).
- `activity.ts`: what a card shows of its activity: `planProgress` (paid of total, months left), `monthsUntil`, `paymentRows` (each payment Pending or Received, matched to the card's own credit of the same amount within a week), `paydayHistory` (what payday sent it, pays already sent).
- `cardPlans.ts`: Gem's 6-month plans from the card's own transactions (bank connection): purchases moved onto a plan ("PLAN TRANSFER OUT/IN" pair) in one statement month, by the transfer's date, are one plan named as Gem names it, "Purchases from Oct 2026 – Nov 2026" (`syncCardPlans`, `mergeCyclePlans`, `cycleName`, `cardPlanPurchases`; months made are remembered in `Debt.cardPlans`). Our `card-` plans hold exactly the month's purchases; one set from a screenshot ("Purchases from …") is used instead. `pendingPlans`: a plan for a purchase still pending is whole again and never brought down (also used when reading a card screenshot). Plans whose amount left is worked out here (`isGuess`: `card-` and Plan check's `ask-` plans) start full on every sync and are fitted to the balance afresh, so they come out the same each time; `refitPlans` does that after a Plan check answer.
- `planCheck.ts`: Plan check's questions and answers: `planQuestions` (a $250+ Gem purchase with no plan transfer after a few days, or pending a few days, not answered and not already a 12+ month plan), `answerPlan` (only the length: sets up or corrects its plan, then `refitPlans`; kept in `Debt.planAnswers` with the plan as it was), `undoPlanAnswer`, `planAnswers` (each with what's left now, or "paid off").
- `planCheck.test.ts`: what's asked, an older plan coming out paid off, correcting a plan and Undo, "No plan".
- `cardPlans.test.ts`: one plan per statement month (by transfer date), a special deal left alone, a paid-off month not made again, older per-purchase plans merged, what's over the balance coming off our guesses, a card screenshot with a purchase pending.
- `activity.test.ts`: plan progress, pending and received payments, a statement's amount to avoid interest.
- `held.test.ts`: "No more this month" and its Undo.
- `debts.test.ts`: schedules, payments gone out, recording a payment, Gem held until statement day, extra paid for one pay.

## Held debts (Gem in Misc bills)
A debt with `holdAccountId` keeps its payday money in a bank account until statement day. How it flows:
- `funding.ts` → `debtPaymentsIn`: its payments (paid ones in `debt.paid` included) leave the hold account, so Accounts lists them there.
- `engine/balances/outflows.ts` → the hold top-up: at least Gem's recommended amount, or `Debt.heldPay` (an amount you set for one statement in the bill check) instead.
- A payment seen in the bank: `services/bank/cardPayments.ts` → `gem.ts` `gemApply`. An early or extra payment that clears this pay's statement payment logs it in `debt.paid`, so the hold account shows it paid.
- When that payment came from another account, the Accounts bill check asks if it was the one (`features/accounts/logic/billCheck.ts`, kind `held`); answers can be undone there.
- Paid only in part from the hold account: the tracker counts what was paid and the rest as to come (`billTracker.ts` → `splitPartPaid`). The bill check asks about the rest, and the Debts card has "No more this month" (`held.ts`); both save `heldPay` plus a `rest` key.

## Watch out for
- These files import each other (schedule ↔ gem ↔ amounts). Add a function to the file whose job it matches.
- What the bank doesn't show about Gem (checked against the owner's "My plans" screen):
  - Every $250+ purchase moved onto a plan in a statement month (21st–20th, by the transfer's date: bought on the 19th and moved on the 22nd is next month's) is one 6-month plan, all ending the same day.
  - A special deal (12, 36 or 60 months) posts as a plain purchase ("IN STORE PURCHASE" or the shop) with no plan transfer, so its length is only known from the owner: Plan check asks (`planCheck.ts`). Don't guess plans from pending purchases. Gem hasn't always used plan transfers either (6-month plans in mid-2026 had none), so no transfer doesn't mean a special deal: ask, don't assume.
  - How much is left on each plan isn't sent at all. The plans add up to the card's balance, so a missing plan shows up as too much left on another one.
- Don't ask the owner for a figure the app can work out. Gem's plans add up to its balance and payments go in Gem's order, so a plan's length is enough: what's left follows (asking for it had the owner confirming a full amount for a plan Gem showed paid off). It can be a few dollars out between plans, because the bank data doesn't show how Gem split each past payment.
- Card plan logic: compare it plan by plan with a screenshot of the card's own app before shipping (ask the owner). The bank data alone misled twice here.
- When the plans add up to more than the balance, what's over comes off our guesses (`card-` plans) first, never off a pending purchase's plan. Taking it in Gem's payment order instead moved money between plans on every sync.
- Gem's split can't be directed at one plan; `gem.ts` reproduces Latitude's order. Keep it in line with the clause quoted at the top of that file.
- Amounts are cents; `fmt` is only for the sentences shown to you.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
