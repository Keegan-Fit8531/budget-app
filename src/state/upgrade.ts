import { freezeLockedPays } from '../engine/balances/freeze';
import { autoBalance } from '../engine/rebalance';
import { debtPay } from '../features/debts/logic/amounts';
import { fitPlansToBalance, settleDue } from '../features/debts/logic/payments';
import { syncGemToRecommended } from '../features/debts/logic/funding';
import { todayISO } from '../core/dates';
import type { Budget } from '../core/types';

// How a budget is made current when it's loaded (this browser, the repo, a backup, a saved copy). No React,
// so scripts and tests can load a budget exactly as the app does (see scripts/inspect.ts).

/** Fill in what older saves (or a backup, or the copy in the repo) may be missing. */
export function tidy(b: Budget): Budget {
  // Lines saved before payday modes existed get an explicit mode.
  for (const line of b.split) {
    if (!line.mode) line.mode = line.auto ? 'exact' : 'fixed';
    delete line.auto;
  }
  b.flags = b.flags ?? [];
  b.debts = b.debts ?? [];
  // Envelopes were saved as monthEnvelope (+ envelopeSpan once weeks came in): now one `envelope` field.
  for (const i of b.items) {
    if (i.monthEnvelope && !i.envelope) i.envelope = i.envelopeSpan ?? 'month';
    delete i.monthEnvelope;
    delete i.envelopeSpan;
  }
  b.savings = b.savings ?? [];
  // Costs named as set-asides (e.g. "Service set-aside") were always money kept in the account, never
  // paid out: say so once. Unticking "Put aside" afterwards sticks.
  if (!b.flags.includes('set-aside-costs')) {
    for (const i of b.items) if (i.frequency !== 'once' && /set.?aside/i.test(`${i.name} ${i.note ?? ''}`)) i.setAside = true;
    b.flags.push('set-aside-costs');
  }
  // Scooter gas takes the small fills (under $50) and Car gas the rest, once (change it on the cost after).
  if (!b.flags.includes('scooter-gas-under-50')) {
    for (const i of b.items) if (i.envelope && /scooter/i.test(i.name) && i.envelopeUnder === undefined) i.envelopeUnder = 5000;
    b.flags.push('scooter-gas-under-50');
  }
  // The wedding fund's balanced amounts round to $50, once (you can change it on the account after).
  if (!b.flags.includes('wedding-round-50')) {
    for (const g of b.savings) {
      const a = b.accounts.find((x) => x.id === g.accountId);
      if (a && /wedding/i.test(g.name) && a.round === undefined) a.round = 5000;
    }
    b.flags.push('wedding-round-50');
  }
  // A statement that set the balance but not every plan left plans adding up to more than it: bring them
  // down once (statements and typed balances do this themselves now). Only where the balance is newest.
  if (!b.flags.includes('plans-fit-balance')) {
    for (const d of b.debts) {
      if (d.balance && d.plans.every((p) => p.asOf <= d.balance!.asOf)) fitPlansToBalance(d, d.balance.asOf);
    }
    b.flags.push('plans-fit-balance');
  }
  return b;
}

/**
 * Make a budget current as of today, wherever it came from (this browser, the repo, a backup, an
 * earlier version): locked pays keep their split, payments due before today count as paid, then
 * upcoming pays are balanced.
 */
export function bringUpToDate(b: Budget): Budget {
  tidy(b);
  // Snapshot locked pays before settleDue, so a live debt figure can’t collapse before we freeze it.
  freezeLockedPays(b);
  settleAll(b);
  // Gem Visa: always follow Latitude's recommended allocation into Misc bills (statement day).
  syncGemToRecommended(b);
  return autoBalance(b);
}

/** Count instalments and plan payments dated before today as paid (they're automatic). */
function settleAll(b: Budget) {
  const today = todayISO();
  for (const d of b.debts ?? []) settleDue(d, b.settings, today, debtPay(b, d));
}
