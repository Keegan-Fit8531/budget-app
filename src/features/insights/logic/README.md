# features/insights/logic/

Plain functions behind Insights (no React).

## Files
- `spending.ts`: spending categories: `categorize` (a shop's category from its description, by built-in rules), `categorizeTxn` (uses the bank connection's tidy merchant name when there is one), `shopMap` (Gemini's guesses, then your own choices on top), `summarize` (purchases between two dates by category; not payments, refunds or transfers), `otherShops` (still in Other and not guessed yet), `cleanDescription`, `CATEGORY_LABEL`, `FUEL_SHOPS` (fuel brands; Gas envelopes use it too, so a new fuel brand goes here once; a fuel station counted as food means its brand is missing).
- `spending.test.ts`: shop names that keep their capitals.
- `review.ts`: the monthly cycle review: `lastCycle`, `cycleTransactions`, `cycleSoFar`, `reviewDue`, `cycleNumbers` (what was spent and on what, against the cycle before), `reviewInput` (the text sent to Gemini), `REVIEW_INSTRUCTIONS` / `REVIEW_SCHEMA`, `parseReview`, `makeReview`, `saveReview` (keeps `KEEP_REVIEWS`), `reviewFrom`. `MonthlyReview` is stored in `budget.reviews`.
- `review.test.ts`: cycles, numbers and parsing a review.

## Watch out for
- The numbers are worked out here, not by Gemini; Gemini only writes the words (what went well, what didn't, tips).
- `engine/envelopeMatch.ts` uses `categorizeTxn` and `shopMap` to tell which purchases count against an envelope (Gas → fuel, Food → groceries).

Keep this README current: update it in the same change when you add, remove, rename or repurpose a file here (see AGENTS.md).
