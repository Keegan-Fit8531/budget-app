import { accountMode, balanceOn, billTracker, nextBufferUse, payProjection } from '../lib/balances';
import { fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import type { Period } from '../lib/engine';
import { money } from '../lib/money';
import type { Account, Budget, Cents } from '../lib/types';
import type { Outflow } from '../lib/balances';
import { PALETTE } from '../lib/colors';
import { Donut } from './Donut';
import { Icon } from './Icon';

const when = (days: number) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 0 ? `in ${days} days` : days === -1 ? 'yesterday' : `${-days} days ago`);

/** Live view of an account across the current pay period: what's in it, what's come out, what's still to come. */
export function MonthTracker({ budget, account, today = todayISO() }: { budget: Budget; account: Account; today?: string }) {
  const t = billTracker(budget, account.id, today);
  const toCome = t.rows.filter((r) => r.status !== 'paid');
  const paid = t.rows.filter((r) => r.status === 'paid');
  const pct = Math.min(100, (t.day / t.period.days) * 100);
  const total = t.paid + t.toCome;
  // A steady account (e.g. rent) builds a buffer for pays with an extra week; what's left isn't spare.
  const steady = accountMode(budget, account.id) === 'smooth';
  const bufferFor = steady ? nextBufferUse(budget, account.id, t.period, 13, today) : undefined;
  const leftLabel = t.spare < 0 ? 'Short' : steady ? 'Buffer' : 'Spare';
  const leftNote = t.spare < 0 ? 'after these bills' : steady
    ? (bufferFor ? `for the ${fmtShort(bufferFor.period.start)} pay` : 'kept for extra weeks')
    : 'after these bills';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Where we are in the pay period */}
      <div>
        <div className="between small">
          <b>This pay: {fmtShort(t.period.start)} – {fmtShort(t.period.end)}</b>
          <span className="muted">Day {t.day} of {t.period.days} · next pay {fmtDay(t.period.nextPayday)}</span>
        </div>
        <div className="bar" role="img" aria-label={`Day ${t.day} of ${t.period.days}`} style={{ height: 8 }}>
          <div style={{ width: `${pct}%`, height: 8, background: account.color }} />
        </div>
      </div>

      {!t.balanceKnown && (
        <div className="tip small" style={{ flexDirection: 'column', gap: 4 }}>
          <b>Enter this account's balance to check {t.toCome ? fmtShort(toCome[0].date) : 'it'}</b>
          <span>
            This pay was split before your budget started, so the app can't tell what's in here.
            {t.toCome ? ` ${money(t.toCome)} still comes out before payday — if the balance in the account is at least that, you're covered.` : ''}
          </span>
        </div>
      )}

      {/* What's in the account, split by what it's for */}
      {t.balanceKnown && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <div className="stat" style={{ padding: '10px 12px' }}>
          <span className="small muted">In the account</span>
          <b style={{ fontSize: 17 }}>{money(t.balance)}</b>
          <span className="small muted">{t.balanceSource === 'estimated' ? 'estimated' : 'from your balance'}</span>
        </div>
        <div className="stat" style={{ padding: '10px 12px' }}>
          <span className="small muted">Still to come out</span>
          <b style={{ fontSize: 17 }}>{money(t.toCome)}</b>
          <span className="small muted">{toCome.length} bill{toCome.length === 1 ? '' : 's'}</span>
        </div>
        <div className="stat" style={{ padding: '10px 12px' }}>
          <span className="small muted">{leftLabel}</span>
          <b style={{ fontSize: 17 }} className={t.spare < 0 ? 'neg' : 'pos'}>{money(Math.abs(t.spare))}</b>
          <span className="small muted">{leftNote}</span>
        </div>
      </div>
      )}

      {steady && t.balanceKnown && t.spare > 0 && (
        <p className="small muted">
          Not spare: this account gets a steady amount every pay, so pays with fewer payments build it up
          {bufferFor
            ? ` for the ${fmtShort(bufferFor.period.start)} pay, which needs ${money(bufferFor.need)} but only gets ${money(bufferFor.deposit)} (the buffer covers the extra ${money(bufferFor.need - bufferFor.deposit)}).`
            : ' for pays with an extra week.'}
        </p>
      )}

      {total > 0 && t.balanceKnown && (
        <div role="img" aria-label={`${money(t.paid)} paid, ${money(t.toCome)} still to come, ${money(Math.max(0, t.spare))} ${steady ? 'buffer' : 'spare'}`}
          style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', background: 'var(--soft)', gap: 2 }}>
          <div title="Paid" style={{ flex: t.paid, background: 'var(--line)' }} />
          {t.toCome > 0 && <div title="Still to come" style={{ flex: t.toCome, background: account.color }} />}
          {t.spare > 0 && <div title={steady ? 'Buffer' : 'Spare'} style={{ flex: t.spare, background: 'var(--good)', opacity: 0.5 }} />}
        </div>
      )}
      {t.balanceKnown && <div className="row small muted" style={{ gap: 14, flexWrap: 'wrap' }} aria-hidden="true">
        <span className="row" style={{ gap: 5 }}><span className="dot" style={{ background: 'var(--line)' }} />Paid {money(t.paid)}</span>
        <span className="row" style={{ gap: 5 }}><span className="dot" style={{ background: account.color }} />Still to come {money(t.toCome)}</span>
        {t.spare > 0 && <span className="row" style={{ gap: 5 }}><span className="dot" style={{ background: 'var(--good)', opacity: 0.5 }} />{steady ? 'Buffer' : 'Spare'} {money(t.spare)}</span>}
      </div>}

      {isBillsAccount(budget, account.id) && (
        <BillsPie rows={toCome} balance={t.balanceKnown ? t.balance : undefined} day={today} endLabel={fmtShort(t.period.end)} />
      )}

      {/* Bills still to come this pay */}
      <div>
        <h3 style={{ fontSize: 15, marginBottom: 2 }}>Still to come before {fmtShort(t.period.nextPayday)}</h3>
        {toCome.length === 0 && <p className="small muted">Everything this pay has come out.{t.balanceKnown ? (steady ? ` The ${money(t.balance)} left stays as the buffer for pays with an extra week.` : ` The ${money(t.balance)} left is spare until next pay.`) : ''}</p>}
        {toCome.map((r, i) => (
          <div className="list-row" key={`${r.name}-${r.date}-${i}`}>
            <span style={{ width: 64, flex: '0 0 64px' }}>
              <span className="small" style={{ display: 'block', fontWeight: 600 }}>{fmtShort(r.date)}</span>
              <span className="small muted">{when(r.days)}</span>
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
            <b>{money(r.amount)}</b>
            {t.balanceKnown ? (
              <span className={r.covered ? 'pos' : 'neg'} aria-label={r.covered ? 'covered' : 'not covered'} style={{ display: 'grid' }}>
                <Icon name={r.covered ? 'check' : 'alert'} size={16} />
              </span>
            ) : <span className="small muted">check</span>}
          </div>
        ))}
      </div>

      {paid.length > 0 && (
        <details>
          <summary className="small" style={{ cursor: 'pointer', fontWeight: 600, minHeight: 32 }}>Already come out this pay · {money(t.paid)}</summary>
          {paid.map((r, i) => (
            <div className="list-row small muted" key={`${r.name}-${r.date}-${i}`}>
              <span style={{ width: 64, flex: '0 0 64px' }}>{fmtShort(r.date)}</span>
              <span style={{ flex: 1 }}>{r.name}</span>
              <span>{money(r.amount)}</span>
              <Icon name="check" size={14} />
            </div>
          ))}
        </details>
      )}

      {t.next.rows.length > 0 && (
        <details>
          <summary className="small" style={{ cursor: 'pointer', fontWeight: 600, minHeight: 32 }}>
            Next pay ({fmtShort(t.next.period.start)}) puts in {money(t.next.deposit)} for {t.next.rows.length} bills · {money(t.next.rows.reduce((s, r) => s + r.amount, 0))}
          </summary>
          {t.next.rows.map((r, i) => (
            <div className="list-row small" key={`${r.name}-${r.date}-${i}`}>
              <span style={{ width: 64, flex: '0 0 64px' }} className="muted">{fmtShort(r.date)}</span>
              <span style={{ flex: 1 }}>{r.name}</span>
              <span>{money(r.amount)}</span>
            </div>
          ))}
        </details>
      )}
      {t.balanceSource === 'estimated' && t.balanceKnown && (
        <p className="small muted">Estimated as this pay's {money(t.deposit)} deposit minus what's come out. Enter the real balance above for an exact figure.</p>
      )}
    </div>
  );
}

/**
 * A pay for one account, as projected, seen from a chosen day: the balance that day, what's been paid
 * by then and what's still to come, then every payment on its date with the balance after it.
 */
export function PayProjectionView({ budget, account, period, day, today = todayISO() }: { budget: Budget; account: Account; period: Period; day: string; today?: string }) {
  const pr = payProjection(budget, account.id, period, today);
  const onDay = balanceOn(budget, account.id, day, today);
  const paidRows = pr.rows.filter((r) => r.date <= day);
  const comeRows = pr.rows.filter((r) => r.date > day);
  const paid = paidRows.reduce((t, r) => t + r.amount, 0);
  const toCome = comeRows.reduce((t, r) => t + r.amount, 0);
  const left = onDay !== undefined ? onDay - toCome : undefined;
  const showAfter = pr.rows.some((r) => r.after !== undefined);
  const kind = pr.depositKind === 'set' ? 'set amount' : pr.depositKind === 'adjusted' ? 'adjusted for this pay' : 'estimated';
  const steady = accountMode(budget, account.id) === 'smooth';
  const dayNo = Math.round((Date.parse(day) - Date.parse(period.start)) / 86400000) + 1;
  const row = (r: (typeof pr.rows)[number], i: number, done: boolean) => (
    <div className={`list-row${done ? ' muted' : ''}`} key={`${r.date}-${r.name}-${i}`}>
      <span style={{ width: 84, flex: '0 0 84px' }} className="small">{fmtDay(r.date)}</span>
      <span style={{ flex: 1, minWidth: 0 }} className="small">{r.name}</span>
      <span className="small" style={{ whiteSpace: 'nowrap' }}>−{money(r.amount)}</span>
      {showAfter && <b style={{ width: 70, textAlign: 'right' }} className={`small ${r.after !== undefined && r.after < 0 ? 'neg' : ''}`}>{r.after !== undefined ? money(r.after, { whole: true }) : ''}</b>}
      <span style={{ width: 18, display: 'grid', placeItems: 'center' }} aria-label={done ? 'paid by then' : 'still to come'}>{done ? <Icon name="check" size={14} /> : null}</span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div className="between small">
          <b>{monthName(period.start)} pay: {fmtShort(period.start)} – {fmtShort(period.end)}</b>
          <span className="muted">Day {dayNo} of {period.days} · {day > today ? 'projected' : 'so far'}</span>
        </div>
        <div className="bar" role="img" aria-label={`Day ${dayNo} of ${period.days}`} style={{ height: 8 }}>
          <div style={{ width: `${Math.min(100, (dayNo / period.days) * 100)}%`, height: 8, background: account.color }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <div className="stat" style={{ padding: '10px 12px' }}>
          <span className="small muted">On {fmtShort(day)}</span>
          <b style={{ fontSize: 17 }} className={onDay !== undefined && onDay < 0 ? 'neg' : ''}>{onDay !== undefined ? money(onDay, { whole: true }) : '—'}</b>
          <span className="small muted">{onDay === undefined ? 'enter a balance' : day > today ? 'estimated' : 'from your balance'}</span>
        </div>
        <div className="stat" style={{ padding: '10px 12px' }}>
          <span className="small muted">Paid by then</span>
          <b style={{ fontSize: 17 }}>{money(paid, { whole: true })}</b>
          <span className="small muted">{paidRows.length} payment{paidRows.length === 1 ? '' : 's'}</span>
        </div>
        <div className="stat" style={{ padding: '10px 12px' }}>
          <span className="small muted">Still to come</span>
          <b style={{ fontSize: 17 }}>{money(toCome, { whole: true })}</b>
          <span className={`small ${left !== undefined && left < 0 ? 'neg' : 'muted'}`}>
            {left === undefined ? `${comeRows.length} payment${comeRows.length === 1 ? '' : 's'}` : left < 0 ? `${money(-left, { whole: true })} short` : `leaves ${money(left, { whole: true })}${steady ? ' buffer' : ''}`}
          </span>
        </div>
      </div>

      {pr.lowest && pr.lowest.amount < 0 && (
        <div className="alert small" role="status"><Icon name="alert" /><span>Projected to be <b>{money(-pr.lowest.amount)} short</b> on {fmtDay(pr.lowest.date)}.</span></div>
      )}

      {isBillsAccount(budget, account.id) && (
        <BillsPie rows={comeRows} balance={onDay} day={day} endLabel={fmtShort(period.end)} />
      )}

      <div>
        <div className="list-row small muted" style={{ paddingTop: 0 }}>
          <span style={{ width: 84, flex: '0 0 84px' }}>Date</span>
          <span style={{ flex: 1 }}>What</span>
          <span>Amount</span>
          {showAfter && <span style={{ width: 70, textAlign: 'right' }}>After</span>}
          <span style={{ width: 18 }} />
        </div>
        <div className={`list-row${day >= period.start ? ' muted' : ''}`}>
          <span style={{ width: 84, flex: '0 0 84px' }} className="small"><b>{fmtDay(period.start)}</b></span>
          <span style={{ flex: 1 }} className="small"><b>Payday</b> <span className="muted">({kind})</span></span>
          <b className="pos small" style={{ whiteSpace: 'nowrap' }}>+{money(pr.deposit, { whole: true })}</b>
          {showAfter && <span style={{ width: 70, textAlign: 'right' }} className="small">{pr.start !== undefined ? money(pr.start + pr.deposit, { whole: true }) : ''}</span>}
          <span style={{ width: 18, display: 'grid', placeItems: 'center' }}><Icon name="check" size={14} /></span>
        </div>
        {paidRows.map((r, i) => row(r, i, true))}
        <div className="list-row" style={{ background: 'var(--soft)', borderRadius: 10, paddingInline: 8 }} aria-label="Chosen day">
          <span style={{ width: 76, flex: '0 0 76px' }} className="small"><b>{fmtDay(day)}</b></span>
          <span style={{ flex: 1 }} className="small"><b>{day === today ? 'Today' : 'This day'}</b></span>
          <b className={`small ${onDay !== undefined && onDay < 0 ? 'neg' : ''}`}>{onDay !== undefined ? money(onDay, { whole: true }) : '—'}</b>
        </div>
        {comeRows.map((r, i) => row(r, i, false))}
        {pr.rows.length === 0 && <p className="small muted">Nothing comes out of this account this pay.</p>}
        <div className="list-row small">
          <span style={{ flex: 1 }}><b>Ends with</b> <span className="muted">on {fmtDay(period.end)}</span></span>
          <b className={pr.end !== undefined && pr.end < 0 ? 'neg' : ''}>{pr.end !== undefined ? money(pr.end, { whole: true }) : '—'}</b>
        </div>
      </div>
      <p className="small muted">
        Dates are when each payment is set to come out. Balances carry on from earlier pays ({pr.startFrom === 'balance' ? 'starting from the balance you entered' : pr.startFrom === 'empty' ? 'starting empty before the next payday' : 'no starting balance'}), so they're estimates
        {pr.depositKind === 'estimated' ? ', and so is the payday amount (it adjusts to what\u2019s left by then)' : ''}.
        {pr.startFrom === 'unknown' ? ' Enter this account\u2019s balance to see a balance for each day.' : ''}
      </p>
    </div>
  );
}

/** Accounts of bills paid on set dates (e.g. a bills account): not ones that are all weekly transfers. */
export function isBillsAccount(budget: Budget, accountId: string): boolean {
  const items = budget.items.filter((i) => i.accountId === accountId);
  return items.length > 1 && items.some((i) => i.frequency !== 'weekly');
}

/**
 * Bills still to come between the chosen day and the end of the pay, as a pie: each bill with its date,
 * amount and share, plus what's left over after them (when the balance is known).
 */
export function BillsPie({ rows, balance, day, endLabel }: { rows: Outflow[]; balance?: Cents; day: string; endLabel: string }) {
  if (!rows.length) return null;
  const due = rows.reduce((t, r) => t + r.amount, 0);
  const left = balance !== undefined ? balance - due : undefined;
  const slices = [
    ...rows.map((r, i) => ({ label: `${r.name} · ${fmtShort(r.date)}`, value: r.amount, color: PALETTE[i % PALETTE.length] })),
    ...(left !== undefined && left > 0 ? [{ label: 'Left over', value: left, color: 'var(--good)' }] : []),
  ];
  const whole = slices.reduce((t, x) => t + x.value, 0) || 1;
  const pct = (v: Cents) => { const n = (v / whole) * 100; return n > 0 && n < 1 ? '<1%' : `${Math.round(n)}%`; };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h3 style={{ fontSize: 15 }}>Bills still to come{day ? ` after ${fmtShort(day)}` : ''}</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <Donut size={140} slices={slices}>
          <span className="small muted">{rows.length} bill{rows.length === 1 ? '' : 's'}</span>
          <b style={{ fontSize: 16 }}>{money(due, { whole: true })}</b>
        </Donut>
        <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="list-row small" style={{ gap: 8, paddingTop: 0 }}>
            <span style={{ flex: 1 }}><b>Total due</b> <span className="muted">by {endLabel}</span></span>
            <b>{money(due)}</b>
          </div>
          {left !== undefined && (
            <div className="list-row small" style={{ gap: 8 }}>
              <span className="dot" style={{ background: left >= 0 ? 'var(--good)' : 'var(--bad)' }} />
              <span style={{ flex: 1 }}><b>{left >= 0 ? 'Left over' : 'Short'}</b> <span className="muted">after these bills</span></span>
              <span style={{ textAlign: 'right' }}>
                <b className={left < 0 ? 'neg' : 'pos'}>{money(Math.abs(left))}</b>
                {left > 0 && <span className="muted" style={{ display: 'block' }}>{pct(left)}</span>}
              </span>
            </div>
          )}
          {left === undefined && <p className="small muted">Enter this account's balance to see what's left over.</p>}
          <span className="small muted">Biggest: {[...rows].sort((x, y) => y.amount - x.amount).slice(0, 2).map((r) => `${r.name} ${money(r.amount, { whole: true })}`).join(', ')}</span>
        </div>
      </div>
      <details className="small">
        <summary style={{ cursor: 'pointer', fontWeight: 600, minHeight: 32 }}>Each bill: name, date, amount and share ({rows.length})</summary>
        <div style={{ marginTop: 4 }}>
          {rows.map((r, i) => (
            <div key={`${r.name}-${r.date}-${i}`} className="list-row small" style={{ gap: 8 }}>
              <span className="dot" style={{ background: PALETTE[i % PALETTE.length] }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                {r.name}
                <span className="muted" style={{ display: 'block' }}>{fmtDay(r.date)}</span>
              </span>
              <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <b>{money(r.amount)}</b>
                <span className="muted" style={{ display: 'block' }}>{pct(r.amount)}</span>
              </span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
