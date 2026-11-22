import type { ReactNode } from 'react';
import { accountMode } from '../../engine/balances/outflows';
import { balanceOn } from '../../engine/balances/estimate';
import { billTracker } from '../../engine/balances/billTracker';
import { nextBufferUse, payProjection } from '../../engine/balances/projection';
import { fmtDay, fmtShort, monthName, ordinal, todayISO } from '../../core/dates';
import { debtAdvice } from '../debts/logic/advice';
import { accountEnvelopes, envelopeHeld } from '../../engine/envelope';
import { EnvelopeCards } from './EnvelopeCards';
import { asideMaxSaved, hasSetAsides, isHeldInAccount } from '../../engine/setAside';
import { type Period } from '../../engine/periods';
import { asideNames } from '../../engine/rebalance';
import { tone } from '../../core/colors';
import { cash } from '../../core/money';
import type { Account, Budget } from '../../core/types';
import { Icon } from '../../ui/Icon';
import { Collapse, Disclosure, FlatDetails, ShortList } from '../../ui/components';

const when = (days: number) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 0 ? `in ${days} days` : days === -1 ? 'yesterday' : `${-days} days ago`);

/**
 * An account across the pay you're in. Always shown: the three figures that matter (what's in it,
 * what's still to come out, what's left) and one bar of them. With `open`: every payment behind them.
 */
export function MonthTracker({ budget, account, today = todayISO(), open }: { budget: Budget; account: Account; today?: string; open: boolean }) {
  const t = billTracker(budget, account.id, today);
  const toCome = t.rows.filter((r) => r.status !== 'paid');
  const paid = t.rows.filter((r) => r.status === 'paid');
  const total = t.paid + t.toCome;
  const envelopes = accountEnvelopes(budget, account.id, today);
  // Unspent envelope budget (Gas left this month, Food left this week) is assumed spent — reserved until it resets.
  const gasHeld = envelopeHeld(budget, account.id, today);
  // After bills and reserved gas: negative = short for this pay + this month's gas.
  const afterReserved = t.spare - gasHeld;
  // A steady account (e.g. rent) builds a buffer for pays with an extra week; what's left isn't spare.
  // Money put aside here (a car fund: WOF, tyres) builds up until it's needed; it isn't spare either —
  // unless every set-aside has a max (Haircut $60) and the account is already over it.
  const aside = hasSetAsides(budget, account.id);
  const paysBills = budget.items.some((i) => i.accountId === account.id && !isHeldInAccount(i));
  const steady = !aside && accountMode(budget, account.id) === 'smooth';
  const bufferFor = steady ? nextBufferUse(budget, account.id, t.period, 13, today) : undefined;
  const names = aside ? asideNames(budget, account.id) : '';
  const maxAside = aside ? asideMaxSaved(budget, account.id) : undefined;
  const spareAmt = Math.max(0, afterReserved);
  const overAsideMax = maxAside !== undefined && spareAmt > maxAside;
  const asideHeld = maxAside !== undefined ? Math.min(spareAmt, maxAside) : spareAmt;
  // Only the cushion for the next 5-week pay is "Buffer" — and only from what's left after gas.
  const bufferCushion = bufferFor ? Math.max(0, bufferFor.need - bufferFor.deposit) : 0;
  const bufferShown = steady && bufferCushion > 0 && spareAmt > 0 ? Math.min(spareAmt, bufferCushion) : undefined;
  const short = afterReserved < 0;
  const leftAmount = short ? Math.abs(afterReserved)
    : overAsideMax ? spareAmt - maxAside!
    : aside && maxAside !== undefined ? asideHeld
    : bufferShown !== undefined ? bufferShown
    : spareAmt;
  const leftWord = short ? 'short' : overAsideMax ? 'spare' : aside ? 'put aside' : bufferShown !== undefined ? 'buffer' : steady ? 'ends' : 'spare';
  const leftLabel = short ? 'Short'
    : overAsideMax ? 'Spare'
    : aside ? 'Put aside'
    : bufferShown !== undefined ? 'Buffer'
    : steady ? 'Ends'
    : 'Spare';
  const envNames = envelopes.map((e) => e.item.name).join(' and ');
  // Accounts = this pay with what's in the account now. Planner's "Buffer" is often the *next* pay's end.
  const leftNote = short
    ? (gasHeld > 0 ? `after bills and ${envNames || 'envelopes'}` : 'this pay after bills')
    : overAsideMax ? `above ${names} max ${cash(maxAside!)}`
    : aside && maxAside !== undefined ? `for ${names} · max ${cash(maxAside)}`
    : aside ? `for ${names}`
    : bufferShown !== undefined && bufferFor ? `for ${fmtShort(bufferFor.period.start)}`
    : gasHeld > 0 ? `after bills and ${envNames}`
    : steady ? 'this pay after bills'
    : 'this pay after bills';
  const color = tone(account.color);
  // Gem Visa held in this account until statement day — note the amount from Latitude's allocation.
  const gemHolds = (budget.debts ?? []).filter((d) => d.holdAccountId === account.id && d.rules === 'gem' && !d.payroll);
  const gemNotes = gemHolds.map((d) => {
    const adv = debtAdvice(budget, d, t.period);
    const due = t.rows.filter((r) => r.name === d.name && r.status !== 'paid');
    const held = due.reduce((s, r) => s + r.amount, 0);
    if (held <= 0 && adv.recommended <= 0) return null;
    const dayLabel = d.statementDay ? `the ${ordinal(d.statementDay)}` : 'statement day';
    return {
      id: d.id,
      text: <>{d.name} {cash(held || adv.recommended)} held for {dayLabel} — Gem’s allocation (instalments first, then interest-free by expiry; min {cash(adv.minimum ?? 0)}).</>,
    };
  }).filter(Boolean) as { id: string; text: ReactNode }[];

  return (
    <>
      <EnvelopeCards budget={budget} account={account} envelopes={envelopes} color={color} today={today} />

      {!t.balanceKnown && (
        <div className="tip small stack gap-4">
          <b>Enter this account's balance to check {t.toCome ? fmtShort(toCome[0].date) : 'it'}</b>
          <span>
            This pay was split before your budget started, so the app can't tell what's in here.
            {t.toCome ? ` ${cash(t.toCome)} still comes out before payday — if the balance in the account is at least that, you're covered.` : ''}
          </span>
        </div>
      )}

      {/* Money put aside (a car fund): nothing comes out on a date, so what matters is what's built up and what's next. */}
      {t.balanceKnown && aside && !paysBills && (
        <div className="stack gap-8">
          <div className="trio">
            <div className="stat">
              <span className="small muted">Put aside</span>
              <b>{t.balanceSource === 'entered'
                ? cash(maxAside !== undefined ? Math.min(Math.max(0, t.balance), maxAside) : Math.max(0, t.balance))
                : '—'}</b>
              <span className="xs muted">for {names}{maxAside !== undefined ? ` · max ${cash(maxAside)}` : ''}</span>
            </div>
            <div className="stat">
              <span className="small muted">Next pay adds</span>
              <b>+{cash(t.next.deposit)}</b>
              <span className="xs muted">on {fmtShort(t.next.period.start)}</span>
            </div>
          </div>
          {maxAside !== undefined && t.balanceSource === 'entered' && t.balance > maxAside && (
            <p className="small muted">
              {cash(t.balance - maxAside)} spare above the {cash(maxAside)} max.
            </p>
          )}
        </div>
      )}

      {t.balanceKnown && !(aside && !paysBills) && (
        <div className="stack gap-8">
          {(total > 0 || gasHeld > 0) && (
            <div className="parts" role="img" aria-label={`${cash(t.paid)} paid, ${cash(t.toCome)} still to come${gasHeld ? `, ${cash(gasHeld)} reserved for ${envNames}` : ''}, ${cash(leftAmount)} ${leftWord}`}>
              {t.paid > 0 && <div title={`Paid ${cash(t.paid)}`} style={{ flex: t.paid, background: 'var(--line)' }} />}
              {t.toCome > 0 && <div title={`Still to come ${cash(t.toCome)}`} style={{ flex: t.toCome, background: color }} />}
              {gasHeld > 0 && !short && <div title={`Reserved for ${envNames} ${cash(gasHeld)}`} style={{ flex: gasHeld, background: 'var(--warn, #C4A35A)' }} />}
              {leftAmount > 0 && !short && <div title={`${leftLabel} ${cash(leftAmount)}`} style={{ flex: leftAmount, background: 'var(--good)' }} />}
              {short && <div title={`Short ${cash(leftAmount)}`} style={{ flex: leftAmount, background: 'var(--bad)' }} />}
            </div>
          )}
          <div className="trio">
            <div className="stat">
              <span className="small muted">Paid</span>
              <b>{cash(t.paid)}</b>
              <span className="xs muted">{paid.length} bill{paid.length === 1 ? '' : 's'} this pay</span>
            </div>
            <div className="stat">
              <span className="small muted">To come</span>
              <b>{cash(t.toCome)}</b>
              <span className="xs muted">{toCome[0] ? `${toCome.length} · next ${fmtShort(toCome[0].date)}` : `before ${fmtShort(t.period.nextPayday)}`}</span>
            </div>
            <div className="stat">
              <span className="small muted">{leftLabel}</span>
              <b className={short ? 'neg' : ''}>{cash(leftAmount)}</b>
              <span className="xs muted">{leftNote}</span>
            </div>
          </div>
          {short && gasHeld > 0 && (
            <p className="small muted">
              Needs {cash(t.toCome)} for bills and {cash(gasHeld)} still budgeted for {envNames}
              ({cash(t.toCome + gasHeld)} total) against {cash(t.balance)} in the account.
            </p>
          )}
          {!short && gasHeld > 0 && spareAmt > 0 && bufferShown === undefined && (
            <p className="small muted">
              {cash(gasHeld)} still budgeted for {envNames} (assumed spent). Anything left when each one resets is yours.
            </p>
          )}
          {overAsideMax && (
            <p className="small muted">
              Put aside {cash(asideHeld)} for {names} (max {cash(maxAside!)}); the rest after bills is spare.
            </p>
          )}
          {gemNotes.map((n) => (
            <p className="small muted" key={n.id}>{n.text}</p>
          ))}
        </div>
      )}

      <Collapse open={open} stacked><FlatDetails.Provider value>
        <div className="stack gap-12">
          {steady && t.balanceKnown && bufferShown !== undefined && bufferFor && (
            <p className="small muted">
              Buffer {cash(bufferShown)} is for the {fmtShort(bufferFor.period.start)} pay: it needs {cash(bufferFor.need)}, gets {cash(bufferFor.deposit)}.
              {gasHeld > 0 ? <> After bills and {cash(gasHeld)} reserved for {envNames}.</> : null}
              {spareAmt > bufferShown ? <> About {cash(spareAmt)} left after that.</> : null}
            </p>
          )}

          {envelopes.map((e) => e.txns.length > 0 && (
            <Disclosure key={`env-${e.item.id}`} title={`${e.item.name} spending · ${e.label}`} meta={cash(e.spent)}>
              <ShortList>
                {e.txns.map((t, i) => (
                  <div className="list-row small" key={`${t.date}-${t.amount}-${i}`}>
                    <span style={{ flex: '0 0 72px' }} className="muted">{fmtShort(t.date)}</span>
                    <span className="grow clip">{t.merchant || t.description}</span>
                    <span className="num">{cash(-t.amount)}</span>
                  </div>
                ))}
              </ShortList>
            </Disclosure>
          ))}

          {/* Bills still to come this pay */}
          {toCome.length > 0 && <div>
            <h3 className="h3">To come before {fmtShort(t.period.nextPayday)}</h3>
            {toCome.map((r, i) => (
              <div className="list-row" key={`${r.name}-${r.date}-${i}`}>
                <span style={{ flex: '0 0 72px' }}>
                  <span className="small strong block">{fmtShort(r.date)}</span>
                  <span className="xs muted">{when(r.days)}</span>
                </span>
                <span className="grow">{r.name}</span>
                <b className="num">{cash(r.amount)}</b>
                {t.balanceKnown ? (
                  <span className={r.covered ? 'pos' : 'neg'} aria-label={r.covered ? 'covered' : 'not covered'} style={{ display: 'grid' }}>
                    <Icon name={r.covered ? 'check' : 'alert'} size={16} />
                  </span>
                ) : <span className="small muted">check</span>}
              </div>
            ))}
          </div>}

          {paid.length > 0 && (
            <Disclosure title="Paid this pay" meta={cash(t.paid)}>
              <ShortList>
                {paid.map((r, i) => (
                  <div className="list-row small muted" key={`${r.name}-${r.date}-${i}`}>
                    <span style={{ flex: '0 0 72px' }}>{fmtShort(r.date)}</span>
                    <span className="grow">{r.name}</span>
                    <span className="num">{cash(r.amount)}</span>
                    <Icon name="check" size={14} />
                  </div>
                ))}
              </ShortList>
            </Disclosure>
          )}

          {t.next.rows.length > 0 && (
            <Disclosure title={`Next pay, ${fmtShort(t.next.period.start)}`}
              meta={`+${cash(t.next.deposit)} in · ${cash(t.next.rows.reduce((s, r) => s + r.amount, 0))} out`}>
              <ShortList>
                {t.next.rows.map((r, i) => (
                  <div className="list-row small" key={`${r.name}-${r.date}-${i}`}>
                    <span style={{ flex: '0 0 72px' }} className="muted">{fmtShort(r.date)}</span>
                    <span className="grow">{r.name}</span>
                    <span className="num">{cash(r.amount)}</span>
                  </div>
                ))}
              </ShortList>
            </Disclosure>
          )}
          {t.balanceSource === 'estimated' && t.balanceKnown && (
            <p className="small muted">Estimated: this pay's {cash(t.deposit)} less what's come out.</p>
          )}
        </div>
      </FlatDetails.Provider></Collapse>
    </>
  );
}

/**
 * A pay for one account, as projected, seen from a chosen day. Always shown: the balance that day,
 * what's been paid by then and what's still to come. With `open`: every payment on its date, with
 * the balance after it.
 */
export function PayProjectionView({ budget, account, period, day, today = todayISO(), open }: { budget: Budget; account: Account; period: Period; day: string; today?: string; open: boolean }) {
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
  const row = (r: (typeof pr.rows)[number], i: number, done: boolean) => (
    <div className={`list-row small${done ? ' muted' : ''}`} key={`${r.date}-${r.name}-${i}`}>
      <span style={{ flex: '0 0 84px' }}>{fmtDay(r.date)}</span>
      <span className="grow">{r.name}</span>
      <span className="num">−{cash(r.amount)}</span>
      {showAfter && <b style={{ width: 70 }} className={`right num ${r.after !== undefined && r.after < 0 ? 'neg' : ''}`}>{r.after !== undefined ? cash(r.after, { whole: true }) : ''}</b>}
      <span style={{ width: 18, display: 'grid', placeItems: 'center' }} aria-label={done ? 'paid by then' : 'still to come'}>{done ? <Icon name="check" size={14} /> : null}</span>
    </div>
  );

  return (
    <>
      <div className="trio">
        <div className="stat">
          <span className="small muted">On {fmtShort(day)}</span>
          <b className={onDay !== undefined && onDay < 0 ? 'neg' : ''}>{onDay !== undefined ? cash(onDay, { whole: true }) : '—'}</b>
          <span className="xs muted">{onDay === undefined ? 'enter a balance' : day > today ? 'estimated' : 'from your balance'}</span>
        </div>
        <div className="stat">
          <span className="small muted">Paid by then</span>
          <b>{cash(paid, { whole: true })}</b>
          <span className="xs muted">{paidRows.length} payment{paidRows.length === 1 ? '' : 's'}</span>
        </div>
        <div className="stat">
          <span className="small muted">Still to come</span>
          <b>{cash(toCome, { whole: true })}</b>
          <span className={`xs ${left !== undefined && left < 0 ? 'neg' : 'muted'}`}>
            {left === undefined ? `${comeRows.length} payment${comeRows.length === 1 ? '' : 's'}` : left < 0 ? `${cash(-left, { whole: true })} short` : `${steady ? 'buffer' : 'leaves'} ${cash(left, { whole: true })}`}
          </span>
        </div>
      </div>

      {pr.lowest && pr.lowest.amount < 0 && (
        <div className="alert small" role="status"><Icon name="alert" /><span>Projected to be <b>{cash(-pr.lowest.amount)} short</b> on {fmtDay(pr.lowest.date)}.</span></div>
      )}

      <Collapse open={open} stacked><FlatDetails.Provider value>
        <div className="stack gap-8">
          <div>
            <div className="list-row small muted" style={{ paddingTop: 0 }}>
              <span style={{ flex: '0 0 84px' }}>Date</span>
              <span className="grow">What</span>
              <span>Amount</span>
              {showAfter && <span style={{ width: 70 }} className="right">After</span>}
              <span style={{ width: 18 }} />
            </div>
            <div className={`list-row small${day >= period.start ? ' muted' : ''}`}>
              <span style={{ flex: '0 0 84px' }}><b>{fmtDay(period.start)}</b></span>
              <span className="grow"><b>Payday</b> <span className="muted">({kind})</span></span>
              <b className="pos num">+{cash(pr.deposit, { whole: true })}</b>
              {showAfter && <span style={{ width: 70 }} className="right num">{pr.start !== undefined ? cash(pr.start + pr.deposit, { whole: true }) : ''}</span>}
              <span style={{ width: 18, display: 'grid', placeItems: 'center' }}><Icon name="check" size={14} /></span>
            </div>
            {paidRows.map((r, i) => row(r, i, true))}
            <div className="list-row small picked" aria-label="Chosen day">
              <span style={{ flex: '0 0 76px' }}><b>{fmtDay(day)}</b></span>
              <span className="grow"><b>{day === today ? 'Today' : 'This day'}</b></span>
              <b className={`num ${onDay !== undefined && onDay < 0 ? 'neg' : ''}`}>{onDay !== undefined ? cash(onDay, { whole: true }) : '—'}</b>
            </div>
            {comeRows.map((r, i) => row(r, i, false))}
            {pr.rows.length === 0 && <p className="small muted">Nothing comes out of this account this pay.</p>}
            <div className="list-row small">
              <span className="grow"><b>Ends with</b> <span className="muted">on {fmtDay(period.end)}</span></span>
              <b className={`num ${pr.end !== undefined && pr.end < 0 ? 'neg' : ''}`}>{pr.end !== undefined ? cash(pr.end, { whole: true }) : '—'}</b>
            </div>
          </div>
          <p className="small muted">
            {monthName(period.start)} pay, {fmtShort(period.start)} – {fmtShort(period.end)}. Dates are when each payment is set to come out. Balances carry on from earlier pays ({pr.startFrom === 'balance' ? 'starting from the balance you entered' : pr.startFrom === 'empty' ? 'starting empty before the next payday' : 'no starting balance'}), so they're estimates
            {pr.depositKind === 'estimated' ? ', and so is the payday amount (it adjusts to what’s left by then)' : ''}.
            {pr.startFrom === 'unknown' ? ' Enter this account’s balance to see a balance for each day.' : ''}
          </p>
        </div>
      </FlatDetails.Provider></Collapse>
    </>
  );
}
