import { addDays, fmtShort, todayISO, type ISODate } from '../core/dates';
import { cash } from '../core/money';
import type { Budget } from '../core/types';
import { billTracker } from '../engine/balances/billTracker';
import { depositFor } from '../engine/balances/deposits';
import { accountMode, fundedOut, keepsBuffer } from '../engine/balances/outflows';
import { bufferLine, potBuffer } from '../engine/balances/buffer';
import {
  accountEnvelopes, envelopeHeld, guessTransfer, isTransferOut, transferKey, unsortedTransfers,
} from '../engine/envelope';
import { periodContaining, shiftPeriod } from '../engine/periods';
import { asideMaxSaved, asideSplit, hasSetAsides } from '../engine/setAside';
import { categorizeTxn, shopMap } from '../features/insights/logic/spending';
import { billChecks } from '../features/accounts/logic/billCheck';

// A plain-text look at a budget the way the Accounts page sees it: what's in an account, what's spoken
// for, each envelope and what counted against it, the next pays. For checking a change against the real
// budget (`npm run inspect`, see scripts/README.md) without opening the app. Read-only.

const span = (from: ISODate, to: ISODate) => `${fmtShort(from)} – ${fmtShort(to)}`;

/** One line per bank account: payday mode, what this pay allocated it, balance, spare after bills and envelopes. */
export function inspectAll(b: Budget, today: ISODate = todayISO()): string[] {
  const p = periodContaining(today, b.settings);
  const out = [`Today ${today} · pay ${span(p.start, p.end)} (next payday ${fmtShort(p.nextPayday)}) · this copy saved ${b.updatedAt ?? 'at an unknown time'}`, ''];
  for (const a of b.accounts.filter((x) => x.kind === 'bank' && !x.archived)) {
    const t = billTracker(b, a.id, today);
    const held = envelopeHeld(b, a.id, today);
    out.push(`${a.name} (${a.id}) · ${accountMode(b, a.id)} · allocated ${cash(t.deposit)} · ${t.balanceKnown ? `${cash(t.balance)} ${t.balanceSource}` : 'balance unknown'}`
      + ` · to come ${cash(t.toCome)} · spare ${cash(t.spare - held)}${held ? ` (after ${cash(held)} in envelopes)` : ''}`);
  }
  return out;
}

/** Everything about one account (`id` or part of its name): the tracker, envelopes, transfers, next pays. */
export function inspectAccount(b: Budget, which: string, today: ISODate = todayISO(), pays = 4): string[] {
  const a = b.accounts.find((x) => x.id === which) ?? b.accounts.find((x) => x.name.toLowerCase().includes(which.toLowerCase()));
  if (!a) return [`No account matches "${which}". Accounts: ${b.accounts.map((x) => x.id).join(', ')}`];
  const mine = shopMap(b);
  const t = billTracker(b, a.id, today);
  const held = envelopeHeld(b, a.id, today);
  const out = [
    `${a.name} (${a.id}${a.number ? `, ${a.number}` : ''}) · payday mode ${accountMode(b, a.id)} · today ${today} · this copy saved ${b.updatedAt ?? 'at an unknown time'}`,
    `Pay ${span(t.period.start, t.period.end)} · payday sent ${cash(t.deposit)}`,
    `Balance ${t.balanceKnown ? `${cash(t.balance)} (${t.balanceSource})` : 'unknown'} · bills paid ${cash(t.paid)}, to come ${cash(t.toCome)} · spare after bills ${cash(t.spare)}`,
  ];
  const accName = (id?: string) => b.accounts.find((x) => x.id === id)?.name ?? id ?? '?';
  // Each bill and debt payment this pay, and what the bank showed paid it (the key to most "why is it paid?" questions).
  for (const r of t.rows) {
    const m = r.match;
    const how = !m?.how ? (r.status === 'paid' ? 'counted as paid, not seen in the bank' : r.late ? 'late: not seen in the bank' : '')
      : `${m.how === 'card' ? `on ${accName(m.from)}` : m.how === 'moved' ? `money moved to ${accName(m.from)}` : 'from here'}: `
        + `${m.txn!.description} ${cash(m.txn!.amount)} on ${fmtShort(m.txn!.date)}${m.shared ? ' (shared)' : ''}${m.cover ? ` · made up ${fmtShort(m.cover.date)}` : ''}`;
    out.push(`  ${r.status === 'paid' ? 'paid   ' : 'to come'} ${fmtShort(r.date)} ${r.name} ${cash(r.amount)}${r.debtId ? ' [debt]' : ''}${how ? ` · ${how}` : ''}`);
  }
  if (hasSetAsides(b, a.id)) {
    // Money put aside (Haircut, WOF): what's after bills and envelopes, each up to its max; the rest is spare.
    const after = Math.max(0, t.spare - held), max = asideMaxSaved(b, a.id);
    const kept = max !== undefined ? Math.min(after, max) : after;
    out.push(`  put aside ${asideSplit(b, a.id, kept).map((x) => `${x.item.name} ${cash(x.amount)}${x.item.maxSaved ? ` of max ${cash(x.item.maxSaved)}` : ''}`).join(', ') || 'nothing'}`
      + (max !== undefined ? ` · spare above the max ${cash(Math.max(0, after - max))}` : ''));
  }
  for (const m of t.toMove) out.push(`  to move ${cash(m.amount)} to ${accName(m.to)} for ${m.row.name}`);
  const asks = billChecks(b, today).filter((c) => c.accountId === a.id);
  if (asks.length) out.push('', 'Bill check asks:', ...asks.map((c) => `  ${c.title} (${c.apply ? `${c.apply.label} / ` : ''}${c.skip}) · key ${c.key}`));

  const envelopes = accountEnvelopes(b, a.id, today);
  if (envelopes.length) {
    out.push('', `Envelopes: ${cash(held)} spoken for → spare after envelopes ${cash(t.spare - held)}`);
    for (const e of envelopes) {
      out.push(`  ${e.item.name} · ${e.span} ${e.label} · budget ${cash(e.budget)} · spent ${cash(e.spent)} · left ${cash(e.left)}`
        + `${e.item.envelopeUnder ? ` · only under ${cash(e.item.envelopeUnder)}` : ''}${e.laterCount ? ` · ${e.laterCount} later ${e.span}s ${cash(e.later)}` : ''}`);
      for (const x of e.txns) {
        // A transfer: the purchase it was matched to, and where (or that you chose it).
        const why = () => {
          if (b.envelopeTransfers?.[transferKey(a.id, x)] !== undefined) return 'you chose';
          const p = guessTransfer(b, a.id, x, mine)?.seen[0];
          return p ? `matched to ${p.txn.merchant || p.txn.description} ${cash(p.txn.amount)} on ${fmtShort(p.txn.date)} in ${p.accountId}` : 'no purchase';
        };
        out.push(`    ${fmtShort(x.date)} ${cash(x.amount)} ${x.merchant || x.description}${isTransferOut(x, mine) ? ` (transfer, ${why()})` : ''}`);
      }
    }
    const unsorted = unsortedTransfers(b, a.id, today);
    out.push(unsorted.length ? '  Transfers out the card asks about:' : '  No transfers out waiting for an answer.');
    for (const x of unsorted) {
      const g = guessTransfer(b, a.id, x, mine);
      // Each envelope by name, with the purchase that made it a candidate, so a not-sure guess explains itself.
      const options = g?.itemIds.map((id, i) => {
        const p = g.nearest[i];
        return `${b.items.find((it) => it.id === id)?.name ?? id} (${p.txn.merchant || p.txn.description} ${cash(p.txn.amount)} on ${fmtShort(p.txn.date)})`;
      });
      out.push(`    ${fmtShort(x.date)} ${cash(x.amount)} ${x.description}${options ? ` · could be ${options.join(' or ')}` : ' · nothing nearby matches'}`);
    }
  }

  out.push('', 'Next pays (what they need / what payday sends):');
  let p = t.period;
  for (let i = 0; i < pays; i++, p = shiftPeriod(p, 1, b.settings)) {
    const need = fundedOut(b, a.id, p.start, p.end).reduce((s, o) => s + o.amount, 0);
    out.push(`  ${span(p.start, p.end)}: ${cash(need)} / ${cash(depositFor(b, a.id, p, today))}`);
  }
  if (keepsBuffer(b, a.id)) out.push(`  Buffer (running balance, next 12 pays, after envelopes): ${bufferLine(potBuffer(b, a.id, t.period, Math.max(0, t.spare - held), 12, today))}.`);

  // Recent transactions, with what each one counted as.
  out.push('', 'Last 14 days of transactions (category → envelope):');
  const from = addDays(today, -14);
  const all = [...(b.accountTransactions?.[a.id] ?? []).map((x) => ({ x, pending: false })), ...(b.pendingTransactions?.[a.id] ?? []).map((x) => ({ x, pending: true }))]
    .filter(({ x }) => x.date >= from && x.date <= today)
    .sort((m, n) => n.x.date.localeCompare(m.x.date));
  // Only what the envelopes count now (this week / month), not older matches.
  const asked = new Set(unsortedTransfers(b, a.id, today).map((x) => transferKey(a.id, x)));
  const counted = new Map(envelopes.flatMap((e) => e.txns.map((x) => [`${x.date}|${transferKey(a.id, x)}`, e.item.name] as const)));
  for (const { x, pending } of all) {
    const key = transferKey(a.id, x);
    const env = asked.has(key) ? 'card asks which envelope' : counted.get(`${x.date}|${key}`)
      ?? (b.envelopeTransfers?.[key] === '' ? 'not spending (your choice)' : undefined);
    const chosen = b.envelopeTransfers?.[key] ? ' (your choice)' : '';
    out.push(`  ${x.date} ${cash(x.amount).padStart(10)} ${x.merchant || x.description}${pending ? ' [pending]' : ''} · ${categorizeTxn(x, mine).category}${env ? ` → ${env}${chosen}` : ''}`);
  }
  return out;
}
