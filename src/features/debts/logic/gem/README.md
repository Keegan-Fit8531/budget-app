# features/debts/logic/gem/

Gem Visa (Latitude NZ): how a payment is split across its plans, the recommended payment, and its plans, which the
bank doesn't send and are rebuilt from the card's own transactions. Come here for anything about Gem's plans,
Plan check, or a card linked to the bank (then `services/bank/README.md`).

## Files
- `gem.ts`: Gem's rules from its Conditions of Use, clause 14: how a payment is split (instalments due, then expiring interest-free purchases by expiry date…), the minimum payment, plan lengths (`GEM_PLAN_MONTHS`, `gemPlanType`, `gemPlanEnds`), `gemPlan` (the recommended payment, statement by statement: `gemDue`), `gemApply` (a payment before the statement that clears this pay's statement payment logs it in `debt.paid`, so the hold account counts it paid), `gemTakeOff` (Gem's order, with no payment recorded), `beforeStatement`.
- `cardPlans.ts`: Gem's 6-month plans from the card's own transactions: one `card-` plan per statement month of plan transfers, named as Gem names it, "Purchases from Oct 2026 – Nov 2026" (`syncCardPlans`, `cycleName`; months made are kept in `Debt.cardPlans`). A plan set from a screenshot is used instead. `pendingPlans`: a pending purchase's plan is whole and never brought down. Guessed plans (`isGuess`: `card-` and Plan check's `ask-`) start full each sync and are fitted to the balance afresh (`refitPlans`).
- `planCheck.ts`: Plan check: `planQuestions` (a $250+ Gem purchase with no plan transfer after a few days, not answered, not already a 12+ month plan), `answerPlan` (only the length; sets up or corrects its plan, then `refitPlans`; kept in `Debt.planAnswers`), `undoPlanAnswer`, `planAnswers` (each with what's left now).
- `cardPlans.test.ts` (through `applyBank`, as a sync does), `planCheck.test.ts`.

## Watch out for
- What the bank doesn't show about Gem (checked against the owner's "My plans" screen):
  - Every $250+ purchase moved onto a plan in a statement month (21st–20th, by the transfer's date: bought on the 19th and moved on the 22nd is next month's) is one 6-month plan, all ending the same day.
  - A special deal (12, 36 or 60 months) posts as a plain purchase with no plan transfer, and some 6-month plans have none either, so a plan's length comes from the owner: Plan check asks. Don't guess plans from pending purchases: a pending purchase can sit for days and post under another date.
  - How much is left on each plan isn't sent at all. The plans add up to the card's balance, so a missing plan shows up as too much left on another one.
- Don't ask the owner for a figure the app can work out: the plans add up to the balance and payments go in Gem's order, so a plan's length is enough and what's left follows (it can be a few dollars out between plans).
- Compare plan logic plan by plan with a screenshot of Gem's own app ("My plans") before shipping; ask the owner. The bank data alone isn't enough, and a wrong guess moves money between plans on every sync.
- When the plans add up to more than the balance, what's over comes off our guesses (`card-` plans) first, never off a pending purchase's plan: Gem's payment order would otherwise move money between plans on every sync.
- The recommended payment is worked out per statement (each instalment, other purchases in full, each interest-free plan over its statements left), so it drops as plans finish (to just the instalments once the interest-free plans are clear), not one level amount.
- Gem's split can't be directed at one plan; `gem.ts` reproduces Latitude's order. Keep it in line with the clause quoted at the top of that file.
- Check a change here with two syncs and a reload of a copy of the real budget (`scripts/README.md`): if the plans move between syncs, they'll drift every hour.

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
