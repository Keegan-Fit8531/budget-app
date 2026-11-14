import { useState } from 'react';
import { addDays, fmtDay, fmtShort, monthName, toDate, todayISO, WEEKDAY_NAMES, type ISODate } from '../lib/dates';
import { debtPaymentsIn } from '../lib/debts';
import type { Period, PeriodPlan } from '../lib/engine';
import { accountMode, balanceOn } from '../lib/balances';
import { averageNeed, itemDates, shiftPeriod } from '../lib/engine';
import { cash } from '../lib/money';
import type { Budget } from '../lib/types';
import { calendarWeeks, weeklyCoverage } from '../lib/weeks';
import { tone } from '../lib/colors';
import { Disclosure, Dot } from './ui';

const DAY_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The pay period as a calendar, with the weekly costs you've chosen to show. */
export function WeeksView({ budget, period, plan }: { budget: Budget; period: Period; plan: PeriodPlan }) {
  const cover = weeklyCoverage(budget, period);
  const weeks = calendarWeeks(period);
  const today = todayISO();
  const accountsShown = [...new Set(cover.map((c) => c.account?.id).filter(Boolean))].map((id) => {
    const rows = cover.filter((c) => c.account?.id === id);
    return {
      acc: rows[0].account!, items: rows.map((r) => r.item), count: rows[0].dates.length,
      day: WEEKDAY_NAMES[toDate(rows[0].dates[0]).getUTCDay()],
    };
  });
  // Every payment due this pay. Weekly allowance and food (chosen to show in Weeks) stand out; the rest are smaller.
  type Chip = { key: string; color: string; amount: number; name: string; account: string; what: string; note?: string; main: boolean; skipped?: boolean };
  const byDate = new Map<ISODate, Chip[]>();
  const add = (d: ISODate, c: Chip) => byDate.set(d, [...(byDate.get(d) ?? []), c]);
  for (const c of cover) {
    const base = { color: c.account?.color ?? '', amount: c.item.amount, name: c.item.name, account: c.account?.name ?? '', what: 'Weekly', note: c.item.note, main: true };
    for (const d of c.dates) add(d, { ...base, key: `${c.item.id}-${d}` });
    for (const d of c.skipped) add(d, { ...base, key: `${c.item.id}-${d}-s`, skipped: true });
  }
  const FREQ: Record<string, string> = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', yearly: 'Yearly', once: 'One-off' };
  for (const a of budget.accounts) {
    if (a.archived || a.id === budget.settings.payAccountId) continue;
    for (const item of budget.items.filter((i) => i.accountId === a.id && !(i.frequency === 'weekly' && i.showInWeeks))) {
      for (const d of itemDates(item, period.start, period.end, budget.settings)) {
        add(d, { key: `${item.id}-${d}`, color: a.color, amount: item.amount, name: item.name, account: a.name, what: FREQ[item.frequency] ?? item.frequency, note: item.note, main: false });
      }
    }
    // Debt payments (e.g. Afterpay instalments, Gem), one per debt per day.
    const pays = new Map<string, { name: string; amount: number; plans: string[] }>();
    for (const x of debtPaymentsIn(budget, a.id, period.start, period.end)) {
      const k = `${x.debt.id}|${x.date}`;
      const cur = pays.get(k) ?? { name: x.debt.name, amount: 0, plans: [] };
      cur.amount += x.amount; cur.plans.push(x.plan.name);
      pays.set(k, cur);
    }
    for (const [k, v] of pays) {
      const d = k.split('|')[1];
      add(d, { key: `${k}`, color: a.color, amount: v.amount, name: v.name, account: a.name, what: 'Debt payment', note: v.plans.length > 1 ? `${v.plans.length} plans` : v.plans[0], main: false });
    }
  }
  for (const list of byDate.values()) list.sort((x, y) => Number(y.main) - Number(x.main) || y.amount - x.amount);
  const [tip, setTip] = useState<string | null>(null);
  const skips = [...new Set(cover.flatMap((c) => c.skipped))].sort();

  const steadyShown = accountsShown.some(({ acc }) => accountMode(budget, acc.id) === 'smooth');
  // The result for each weekly account (what you scan for), and how it's worked out (kept behind a click).
  const weekly = accountsShown.map(({ acc, items, count, day }) => {
    const ap = plan.accounts.find((x) => x.account.id === acc.id);
    if (!ap) return null;
    const mode = accountMode(budget, acc.id);
    const diff = ap.funded - ap.need;
    // What's in the account the day before payday and at the end: shows whether the extra this pay
    // builds the buffer or makes up for an earlier pay that left it short.
    const before = mode === 'smooth' ? balanceOn(budget, acc.id, addDays(period.start, -1), today) : undefined;
    const after = mode === 'smooth' ? ap.endBalance : undefined;
    const known = before !== undefined && after !== undefined;
    const shortBefore = known && before! < 0 ? -before! : 0;
    const prevPay = `the ${monthName(shiftPeriod(period, -1, budget.settings).start)} pay`;
    // Every weekly cost from this account (e.g. food + gas), not just the ones shown on the calendar.
    const all = budget.items.filter((i) => i.accountId === acc.id && i.frequency === 'weekly');
    const what = (all.length ? all : items).map((i) => `${i.name} ${cash(i.amount, { whole: true })}`).join(' + ');
    const message = mode === 'exact'
      ? { text: `Sends all ${count}: ${cash(ap.need)}`, tone: 'muted' }
      : mode === 'smooth'
        ? known
          ? after! >= before!
            ? shortBefore && after! - before! <= shortBefore
              ? { text: `Makes up ${cash(shortBefore)} short`, tone: 'pos' }
              : { text: `${cash(after! - Math.max(0, before!))} goes into the buffer`, tone: 'muted' }
            : { text: `Buffer covers the extra ${cash(before! - after!)}`, tone: 'muted' }
          : diff >= 0
            ? { text: `${cash(diff)} goes into the buffer`, tone: 'muted' }
            : { text: `Buffer covers the extra ${cash(-diff)}`, tone: 'muted' }
        : diff >= 0
          ? { text: `${cash(diff)} spare`, tone: 'pos' }
          : { text: `${cash(-diff)} short`, tone: 'neg' };
    const usual = Math.ceil(averageNeed(budget, acc.id) / 100) * 100;
    const how = `${count} ${day}s × (${what}) = ${cash(ap.need)} this pay. ${mode === 'smooth'
      ? ap.funded === usual ? `Steady ${cash(ap.funded)} each pay.` : `Sends ${cash(ap.funded)} this pay (usually ${cash(usual)})${shortBefore ? `, including ${cash(shortBefore)} ${prevPay} left short` : ap.funded > usual ? ', leaving enough for the next 5-week pay' : ''}.`
      : mode === 'fixed' ? `Sending ${cash(ap.funded)}.` : ''}`;
    return { acc, message, how };
  }).filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <section className="card stack gap-12">
      <div className="card-head">
        <h2 className="h2">Weeks this pay</h2>
        <span className="small muted">{period.days} days · {Math.floor(period.days / 7)} weeks{period.days % 7 ? ` and ${period.days % 7} day${period.days % 7 === 1 ? '' : 's'}` : ''}</span>
      </div>

      <table className="wk">
        <caption className="sr-only">
          Calendar from payday {fmtDay(period.start)} to next payday {fmtDay(period.nextPayday)}
        </caption>
        <thead>
          <tr>{DAY_HEAD.map((d) => <th key={d}>{d}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w[0]}>
              {w.map((d, col) => {
                const inPeriod = d >= period.start && d <= period.end;
                const isPay = d === period.start;
                const isNext = d === period.nextPayday;
                const chips = inPeriod ? byDate.get(d) ?? [] : [];
                const day = toDate(d).getUTCDate();
                const cls = isPay ? 'payday' : isNext ? 'next' : inPeriod ? 'in' : 'out';
                return (
                  <td key={d} className={`wk-day ${cls}${d === today && !isPay ? ' today' : ''}`}
                    aria-label={`${fmtDay(d)}${isPay ? ', payday' : ''}${isNext ? ', next payday' : ''}${chips.map((c) => `, ${c.name} ${cash(c.amount)}${c.skipped ? ' skipped' : ''}`).join('')}`}>
                    <div className="wk-date">{day === 1 || d === w[0] ? fmtShort(d) : day}</div>
                    {isPay && <div className="wk-tag">Payday</div>}
                    {isNext && <div className="wk-tag">Next pay</div>}
                    <div className="wk-chips">
                      {chips.map((c) => (
                        <span key={c.key} style={{ position: 'relative' }}>
                          <button type="button" className={`wk-chip${c.main ? ' lead' : ''}${c.skipped ? ' skipped' : ''}`} aria-label={`${c.name}, ${cash(c.amount)}, ${c.account}`}
                            onMouseEnter={() => setTip(c.key)} onMouseLeave={() => setTip((t) => (t === c.key ? null : t))}
                            onFocus={() => setTip(c.key)} onBlur={() => setTip((t) => (t === c.key ? null : t))}
                            onClick={() => setTip((t) => (t === c.key ? null : c.key))}>
                            <span aria-hidden="true" className="wk-dot" style={c.skipped ? { border: `1px solid ${tone(c.color)}` } : { background: tone(c.color) }} />
                            <span className="clip">
                              {c.skipped ? <s>{cash(c.amount, { whole: true })}</s> : cash(c.amount, { whole: true })}
                            </span>
                          </button>
                          {tip === c.key && (
                            <span role="tooltip" className="pop wk-pop" style={col >= 4 ? { right: 0 } : { left: 0 }}>
                              <span className="row gap-6"><Dot color={c.color} small /><b>{c.name}</b></span>
                              <span className="block">{cash(c.amount)} · {fmtDay(d)}</span>
                              <span className="block" style={{ opacity: 0.8 }}>{c.account} · {c.what}{c.skipped ? ' · skipped' : ''}</span>
                              {c.note && <span className="block" style={{ opacity: 0.8 }}>{c.note}</span>}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {skips.length > 0 && (
        <div className="tip small">
          <span>
            <b>Skip {skips.map((d) => fmtDay(d)).join(', ')}</b>: it's the day before payday, so you go without until pay.
            {cover.some((c) => c.skipped.length && /auto/i.test(`${c.item.name} ${c.item.note ?? ''}`)) && ' Pause that week’s automatic allowance transfer in your banking app.'}
          </span>
        </div>
      )}
      {cover.length === 0 && (
        <p className="small muted">Open a weekly cost in Deposits and turn on "Show in Weeks this pay" to see it here.</p>
      )}
      {weekly.length > 0 && (
        <div className="stack gap-6">
          {/* Name and the result (what you scan for); how it's worked out is one click away. */}
          {weekly.map(({ acc, message }) => (
            <div key={acc.id} className="between nowrap baseline gap-8">
              <span className="row gap-8 min0"><Dot color={acc.color} /><b>{acc.name}</b></span>
              <span className={`small ${message.tone} strong`} style={{ whiteSpace: 'nowrap' }}>{message.text}</span>
            </div>
          ))}
          <Disclosure title="How these are worked out">
            {weekly.map(({ acc, how }) => <p key={acc.id} className="small muted"><b>{acc.name}:</b> {how}</p>)}
            {steadyShown && (
              <p className="small muted">Steady sends the same amount every pay. Pays with 4 {accountsShown[0]?.day ?? 'Wednesday'}s add a little to the account, and that covers the 5th one when it comes.</p>
            )}
          </Disclosure>
        </div>
      )}
    </section>
  );
}
