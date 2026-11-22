import { addDays, diffDays, fmtShort, monthName, todayISO, type ISODate } from '../core/dates';
import { periodContaining } from './periods';
import { envelopeBudget, envelopeSpan, envelopeWindow, isEnvelope } from './setAside';
import { envelopesAt, purchaseEnvelope } from './envelopeMatch';
export { envelopesAt, guessTransfer, isTransferOut, matchesEnvelope, purchaseEnvelope, transferKey, type TransferGuess } from './envelopeMatch';
import { shopMap } from '../features/insights/logic/spending';
import { isTransferOut, transferEnvelope, txnsIn } from './envelopeMatch';
import type { Budget, Cents, EnvelopeSpan, Item, Txn } from '../core/types';

export {
  envelopeBudget, envelopeOn, envelopePerPay, envelopeSpan, envelopesOn, envelopeWindow, hasEnvelopes, paydaysInMonth,
} from './setAside';

/** Purchases (and transfers you counted for it) on the account in one span that count against the envelope. */
export function envelopeTxns(b: Budget, item: Item, { from, to }: { from: ISODate; to: ISODate }): Txn[] {
  const mine = shopMap(b);
  return txnsIn(b, item.accountId, from, to).filter((t) => isTransferOut(t, mine)
    ? transferEnvelope(b, item.accountId, t, mine) === item.id
    : purchaseEnvelope(envelopesAt(b, item.accountId, t.date), t, mine)?.id === item.id);
}

export interface EnvelopeStatus {
  item: Item;
  /** The span being tracked (this week, fortnight or calendar month). */
  from: ISODate;
  to: ISODate;
  /** "November", or "21 Nov – 27 Nov" for a week or fortnight. */
  label: string;
  /** How long it lasts before starting fresh. */
  span: EnvelopeSpan;
  budget: Cents;
  spent: Cents;
  left: Cents;
  over: boolean;
  txns: Txn[];
  /**
   * Weeks or fortnights still to start before payday: this pay funded them too (Food $200/week on a
   * 5-Thursday pay put $1,000 in), so that money is spoken for as well. 0 for a month envelope.
   */
  laterCount: number;
  later: Cents;
}

/** Budget / spent / left for one envelope in the span (week, fortnight or month) holding `today`. */
export function envelopeStatus(b: Budget, item: Item, today: ISODate = todayISO()): EnvelopeStatus {
  const { from, to } = envelopeWindow(item, today);
  const span = envelopeSpan(item);
  const budget = envelopeBudget(item);
  const txns = envelopeTxns(b, item, { from, to });
  const spent = txns.reduce((s, t) => s - t.amount, 0);
  const left = budget - spent;
  let laterCount = 0;
  if (span !== 'month') {
    const end = periodContaining(today, b.settings).end;
    const len = diffDays(from, to) + 1;
    for (let d = addDays(to, 1); d <= end && (!item.end || d <= item.end); d = addDays(d, len)) laterCount++;
  }
  return {
    item,
    from,
    to,
    label: span === 'month' ? monthName(from) : `${fmtShort(from)} – ${fmtShort(to)}`,
    span,
    budget,
    spent,
    left,
    over: left < 0,
    txns,
    laterCount,
    later: laterCount * budget,
  };
}

/** Every envelope on an account, for the Accounts card. */
export function accountEnvelopes(b: Budget, accountId: string, today: ISODate = todayISO()): EnvelopeStatus[] {
  return b.items
    .filter((i) => i.accountId === accountId && isEnvelope(i) && i.start <= today && (!i.end || today <= i.end))
    .map((i) => envelopeStatus(b, i, today))
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
}

/**
 * Transfers out of the account during its envelopes' current spans that you haven't sorted yet: each
 * could be spending done on another card (food, gas) or just moving money, so the Accounts card asks.
 */
export function unsortedTransfers(b: Budget, accountId: string, today: ISODate = todayISO()): Txn[] {
  const envelopes = accountEnvelopes(b, accountId, today);
  if (!envelopes.length) return [];
  // From the earliest current span (no earlier than the cost's first date).
  const from = envelopes.reduce((d, e) => { const f = e.from < e.item.start ? e.item.start : e.from; return f < d ? f : d; }, today);
  const mine = shopMap(b);
  return txnsIn(b, accountId, from, today)
    .filter((t) => isTransferOut(t, mine) && transferEnvelope(b, accountId, t, mine) === undefined);
}

/** Envelope money on an account that's spoken for: what's unspent this span, plus later weeks this pay funded. */
export function envelopeHeld(b: Budget, accountId: string, today: ISODate = todayISO()): Cents {
  return accountEnvelopes(b, accountId, today).reduce((t, e) => t + Math.max(0, e.left) + e.later, 0);
}
