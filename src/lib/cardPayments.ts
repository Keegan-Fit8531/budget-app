import { addDays, type ISODate } from './dates';
import { debtPay, debtSchedules, applyPayment } from './debts';
import type { Budget, Cents, Debt, Txn } from './types';

// ---------------------------------------------------------------------------------------------
// Card payments seen in your bank accounts. Some cards (Gem Visa, Q Mastercard) can't be linked to the
// bank connection, but what you pay them leaves a linked bank account (ANZ) as a transfer named after
// the card ("Q Mastercard Fitzgerald Id…", "BP Gem Visa …"). Each new one is noted on the card, and
// whatever it pays over what was already planned (planned payments count as paid automatically) comes
// off what's owed, the same as recording a payment by hand.
// ---------------------------------------------------------------------------------------------

/** Planned payments from this many days before a transfer to a day after it are taken to be that transfer (it's made on or soon after the day). */
const BEFORE = 4, AFTER = 1;

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** How a card's transfers are worded in a bank account, from its card rules and its name. */
function matcher(debt: Debt): (description: string) => boolean {
  const name = norm(debt.name).trim();
  const tests: RegExp[] = [];
  if (debt.rules === 'gem' || /\bgem\b/.test(name)) tests.push(/ gem (visa |card )?|latitude/);
  if (/^q\b/.test(name)) tests.push(/ q ?(mastercard|card|mc) /);
  return (d) => {
    const text = norm(d);
    if (tests.some((t) => t.test(text))) return true;
    // Otherwise its whole name, as words (at least 4 letters, so "Q" or "Kim" alone never match).
    return name.length >= 4 && text.includes(` ${name} `);
  };
}

/** The cards whose payments are looked for: not repaid from salary, and not already linked to the bank (their balance is the bank's). */
function watched(b: Budget): Debt[] {
  const linked = new Set(b.bankAuto === false ? [] : Object.values(b.bankLinks ?? {}));
  return (b.debts ?? []).filter((d) => !d.payroll && !linked.has(`debt:${d.id}`));
}

/** The card a bank account's transaction pays, if it's a payment to one. */
export function cardPaid(b: Budget, t: Txn): Debt | undefined {
  if (t.amount >= 0) return undefined;
  const text = `${t.description} ${t.merchant ?? ''}`;
  return watched(b).find((d) => matcher(d)(text));
}

/**
 * The day what a debt owes was last read or checked: its balance, or the orders or plans from a
 * screenshot or statement. A payment made before then is already in those figures. With nothing
 * checked, the oldest purchase it holds: a payment before that can't have paid for any of them.
 */
export function knownSince(debt: Debt): ISODate | undefined {
  const checked = [debt.balance?.asOf, ...debt.plans.filter((p) => p.instalments?.length).map((p) => p.asOf)]
    .filter((d): d is ISODate => !!d).sort();
  if (checked.length) return checked[checked.length - 1];
  return debt.plans.map((p) => p.purchaseDate).filter((d): d is ISODate => !!d).sort()[0];
}

export interface SeenPayment { debt: string; amount: Cents; date: ISODate; from: string; counted: Cents }

/**
 * Note each payment to a card among a bank account's new transactions, and take what it pays over
 * the planned payments around its date off what the card owes. Call with only the transactions just
 * added (so a payment is never counted twice).
 */
export function recordCardPayments(b: Budget, accountId: string, added: Txn[], today: ISODate): SeenPayment[] {
  const out: SeenPayment[] = [];
  for (const t of added) {
    const debt = cardPaid(b, t);
    if (!debt) continue;
    const amount = -t.amount;
    // The planned payments it stands for: around its date, and not already taken by an earlier transfer.
    const taken = new Set((debt.bankPayments ?? []).flatMap((p) => p.planned ?? []));
    const from = addDays(t.date, -BEFORE), to = addDays(t.date, AFTER);
    const near = [
      ...(debt.paid ?? []).filter((x) => x.date >= from && x.date <= to).map((x) => ({ key: `${x.date}|${x.amount}|${x.planId ?? x.name}`, date: x.date, amount: x.amount })),
      ...debtSchedules(debt, b.settings, debtPay(b, debt)).flatMap((sch) => sch.payments
        .filter((p) => p.date >= today && p.date >= from && p.date <= to)
        .map((p) => ({ key: `${p.date}|${p.amount}|${sch.synthetic ? sch.plan.name : sch.plan.id}`, date: p.date, amount: p.amount }))),
    ].filter((x) => x.amount > 0 && !taken.has(x.key))
      .sort((x, y) => Math.abs(Date.parse(x.date) - Date.parse(t.date)) - Math.abs(Date.parse(y.date) - Date.parse(t.date)));
    const planned: string[] = [];
    let covered = 0;
    for (const x of near) {
      if (covered >= amount) break;
      planned.push(x.key);
      covered += x.amount;
    }
    let counted = Math.max(0, amount - covered);
    // What's owed, checked on or after the day it was paid, already has it taken off (an old payment
    // from a bank account's history paid for things long gone, never today's orders).
    const since = knownSince(debt);
    if (since && since >= t.date) counted = 0;
    if (counted > 0) applyPayment(debt, counted, b.settings, t.date <= today ? t.date : today);
    debt.bankPayments = [...(debt.bankPayments ?? []), { date: t.date, amount, from: accountId, counted, ...(planned.length ? { planned } : {}) }]
      .sort((x, y) => x.date.localeCompare(y.date)).slice(-200);
    out.push({ debt: debt.name, amount, date: t.date, from: accountId, counted });
  }
  return out;
}
