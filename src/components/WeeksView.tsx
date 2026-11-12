import { useState } from 'react';
import { addDays, fmtDay, fmtShort, monthName, toDate, todayISO, WEEKDAY_NAMES, type ISODate } from '../lib/dates';
import { debtPaymentsIn } from '../lib/debts';
import type { Period, PeriodPlan } from '../lib/engine';
import { accountMode, balanceOn } from '../lib/balances';
import { averageNeed, itemDates, shiftPeriod } from '../lib/engine';
import { money } from '../lib/money';
import type { Budget } from '../lib/types';
import { calendarWeeks, weeklyCoverage } from '../lib/weeks';

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
    const base = { color: c.account?.color ?? '#888', amount: c.item.amount, name: c.item.name, account: c.account?.name ?? '', what: 'Weekly', note: c.item.note, main: true };
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

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="between">
        <h2 className="h2">Weeks this pay</h2>
        <span className="small muted">{period.days} days · {Math.floor(period.days / 7)} weeks{period.days % 7 ? ` and ${period.days % 7} day${period.days % 7 === 1 ? '' : 's'}` : ''}</span>
      </div>

      <div>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 3, tableLayout: 'fixed', fontVariantNumeric: 'tabular-nums' }}>
          <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Calendar from payday {fmtDay(period.start)} to next payday {fmtDay(period.nextPayday)}
          </caption>
          <thead>
            <tr>{DAY_HEAD.map((d) => <th key={d} className="small muted" style={{ fontWeight: 500, padding: '2px 0' }}>{d}</th>)}</tr>
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
                  return (
                    <td key={d} aria-label={`${fmtDay(d)}${isPay ? ', payday' : ''}${isNext ? ', next payday' : ''}${chips.map((c) => `, ${c.name} ${money(c.amount)}${c.skipped ? ' skipped' : ''}`).join('')}`}
                      style={{
                        verticalAlign: 'top', height: 56, padding: 4, borderRadius: 10,
                        background: isPay ? 'var(--brand)' : inPeriod ? 'var(--bg)' : 'transparent',
                        color: isPay ? '#fff' : 'var(--ink)',
                        outline: isNext ? '2px dashed var(--brand-2)' : d === today ? '2px solid var(--ink)' : 'none', outlineOffset: -2,
                        opacity: inPeriod || isNext ? 1 : 0.4,
                      }}>
                      <div style={{ fontSize: 12, fontWeight: isPay || isNext ? 700 : 500 }}>{day === 1 || d === w[0] ? fmtShort(d) : day}</div>
                      {isPay && <div style={{ fontSize: 11 }}>Payday</div>}
                      {isNext && <div style={{ fontSize: 11, color: 'var(--brand-2)', fontWeight: 600 }}>Next pay</div>}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                        {chips.map((c) => (
                          <span key={c.key} style={{ position: 'relative' }}>
                            <button type="button" aria-label={`${c.name}, ${money(c.amount)}, ${c.account}`}
                              onMouseEnter={() => setTip(c.key)} onMouseLeave={() => setTip((t) => (t === c.key ? null : t))}
                              onFocus={() => setTip(c.key)} onBlur={() => setTip((t) => (t === c.key ? null : t))}
                              onClick={() => setTip((t) => (t === c.key ? null : c.key))}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 3, width: '100%', padding: 0, border: 0, background: 'none', cursor: 'pointer', textAlign: 'left',
                                color: isPay ? '#fff' : c.main ? 'var(--ink)' : 'var(--muted)', font: 'inherit',
                                fontSize: c.main ? 11 : 10, fontWeight: c.main ? 700 : 400, lineHeight: 1.2, opacity: c.skipped ? 0.7 : 1,
                              }}>
                              <span aria-hidden="true" style={{ width: c.main ? 7 : 5, height: c.main ? 7 : 5, borderRadius: c.main ? 2 : 99, background: c.skipped ? 'transparent' : c.color, border: c.skipped ? `1px solid ${c.color}` : 'none', flex: '0 0 auto', opacity: c.main ? 1 : 0.75 }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {c.skipped ? <s>{money(c.amount, { whole: true })}</s> : money(c.amount, { whole: true })}
                              </span>
                            </button>
                            {tip === c.key && (
                              <span role="tooltip" style={{
                                position: 'absolute', zIndex: 20, top: '100%', ...(col >= 4 ? { right: 0 } : { left: 0 }), marginTop: 4, minWidth: 170, maxWidth: 240,
                                background: 'var(--ink)', color: 'var(--card)', borderRadius: 10, padding: '8px 10px', fontSize: 12, lineHeight: 1.35,
                                boxShadow: '0 6px 18px rgba(0,0,0,.2)', pointerEvents: 'none', whiteSpace: 'normal', fontWeight: 400,
                              }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />
                                  <b>{c.name}</b>
                                </span>
                                <span style={{ display: 'block' }}>{money(c.amount)} · {fmtDay(d)}</span>
                                <span style={{ display: 'block', opacity: 0.8 }}>{c.account} · {c.what}{c.skipped ? ' · skipped' : ''}</span>
                                {c.note && <span style={{ display: 'block', opacity: 0.8 }}>{c.note}</span>}
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
      </div>

      {skips.length > 0 && (
        <div className="tip small" style={{ alignItems: 'center' }}>
          <span>
            <b>Skip {skips.map((d) => fmtDay(d)).join(', ')}</b>: it's the day before payday, so you go without until pay.
            {cover.some((c) => c.skipped.length && /auto/i.test(`${c.item.name} ${c.item.note ?? ''}`)) && ' Pause that week\u2019s automatic allowance transfer in your banking app.'}
          </span>
        </div>
      )}
      {cover.length === 0 && (
        <p className="small muted">Open a weekly cost in Deposits and turn on "Show in Weeks this pay" to see it here.</p>
      )}
      {accountsShown.map(({ acc, items, count, day }) => {
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
        const weekly = budget.items.filter((i) => i.accountId === acc.id && i.frequency === 'weekly');
        const what = (weekly.length ? weekly : items).map((i) => `${i.name} ${money(i.amount, { whole: true })}`).join(' + ');
        const message = mode === 'exact'
          ? { text: `Sends all ${count}: ${money(ap.need)}`, tone: 'muted' }
          : mode === 'smooth'
            ? known
              ? after! >= before!
                ? shortBefore && after! - before! <= shortBefore
                  ? { text: `Makes up ${money(shortBefore)} short`, tone: 'pos' }
                  : { text: `${money(after! - Math.max(0, before!))} goes into the buffer`, tone: 'pos' }
                : { text: `Buffer covers the extra ${money(before! - after!)}`, tone: 'pos' }
              : diff >= 0
                ? { text: `${money(diff)} goes into the buffer`, tone: 'pos' }
                : { text: `Buffer covers the extra ${money(-diff)}`, tone: 'pos' }
            : diff >= 0
              ? { text: `${money(diff)} spare`, tone: 'pos' }
              : { text: `${money(-diff)} short`, tone: 'neg' };
        return (
          <div key={acc.id} className="between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 10, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span className="dot" style={{ background: acc.color, marginTop: 5 }} />
              <span>
                <b>{acc.name}</b>{' '}
                <span className="muted">
                  {(() => {
                    const usual = Math.ceil(averageNeed(budget, acc.id) / 100) * 100;
                    return <>
                      {count} {day}s × ({what}) = {money(ap.need)} this pay.
                      {' '}{mode === 'smooth'
                        ? ap.funded === usual ? `Steady ${money(ap.funded)} each pay.` : `Sends ${money(ap.funded)} this pay (usually ${money(usual)})${shortBefore ? `, including ${money(shortBefore)} ${prevPay} left short` : ap.funded > usual ? ', leaving enough for the next 5-week pay' : ''}.`
                        : mode === 'fixed' ? `Sending ${money(ap.funded)}.` : ''}
                    </>;
                  })()}
                </span>
              </span>
            </span>
            <span style={{ textAlign: 'right' }}>
              <b className={message.tone} style={{ whiteSpace: 'nowrap', display: 'block' }}>{message.text}</b>

            </span>
          </div>
        );
      })}
      {accountsShown.some(({ acc }) => accountMode(budget, acc.id) === 'smooth') && (
        <p className="small muted">Steady sends the same amount every pay. Pays with 4 {accountsShown[0]?.day ?? 'Wednesday'}s add a little to the account, and that covers the 5th one when it comes.</p>
      )}
    </section>
  );
}
