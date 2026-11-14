import { accountMode, balanceOn, billTracker, nextBufferUse, payProjection } from '../lib/balances';
import { fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import { hasSetAsides, isSetAside, type Period } from '../lib/engine';
import { asideNames } from '../lib/rebalance';
import { tone } from '../lib/colors';
import { cash } from '../lib/money';
import type { Account, Budget } from '../lib/types';
import { Icon } from './Icon';
import { Disclosure } from './ui';

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
  // A steady account (e.g. rent) builds a buffer for pays with an extra week; what's left isn't spare.
  // Money put aside here (a car fund: WOF, tyres) builds up until it's needed; it isn't spare either.
  const aside = hasSetAsides(budget, account.id);
  const paysBills = budget.items.some((i) => i.accountId === account.id && !isSetAside(i));
  const steady = !aside && accountMode(budget, account.id) === 'smooth';
  const bufferFor = steady ? nextBufferUse(budget, account.id, t.period, 13, today) : undefined;
  const leftWord = aside ? 'put aside' : steady ? 'buffer' : 'spare';
  const leftLabel = t.spare < 0 ? 'Short' : aside ? 'Put aside' : steady ? 'Buffer' : 'Spare';
  const leftNote = t.spare < 0 ? 'after bills' : aside ? `for ${asideNames(budget, account.id)}` : steady
    ? (bufferFor ? `for ${fmtShort(bufferFor.period.start)}` : 'for extra weeks')
    : 'after bills';
  const color = tone(account.color);

  return (
    <>
      {!t.balanceKnown && (
        <div className="tip small stack gap-4">
          <b>Enter this account's balance to check {t.toCome ? fmtShort(toCome[0].date) : 'it'}</b>
          <span>
            This pay was split before your budget started, so the app can't tell what's in here.
            {t.toCome ? ` ${cash(t.toCome)} still comes out before payday — if the balance in the account is at least that, you're covered.` : ''}
          </span>
        </div>
      )}

      {t.balanceKnown && toCome.length === 0 && (
        <p className="small muted">
          {aside && !paysBills ? 'Nothing comes out of this account on a date.' : aside && total === 0 ? 'Nothing comes out of it this pay.' : <>Everything this pay has come out{total > 0 ? ` (${cash(t.paid)})` : ''}.</>}
          {aside
            ? t.balanceSource === 'entered'
              ? ` The ${cash(Math.max(0, t.balance))} in here is put aside for ${asideNames(budget, account.id)}, and next payday (${fmtShort(t.next.period.start)}) adds ${cash(t.next.deposit)}.`
              : ` Each payday puts money aside here for ${asideNames(budget, account.id)} (${cash(t.next.deposit)} on ${fmtShort(t.next.period.start)}). Enter the balance to see what's built up.`
            : t.balance > 0 ? (steady ? ` The ${cash(t.balance)} left stays as the buffer for pays with an extra week.` : ` The ${cash(t.balance)} left is spare until next pay.`) : ''}
        </p>
      )}

      {t.balanceKnown && toCome.length > 0 && (
        <div className="stack gap-8">
          {total > 0 && (
            <div className="parts" role="img" aria-label={`${cash(t.paid)} paid, ${cash(t.toCome)} still to come, ${cash(Math.max(0, t.spare))} ${leftWord}`}>
              <div title={`Paid ${cash(t.paid)}`} style={{ flex: t.paid, background: 'var(--line)' }} />
              {t.toCome > 0 && <div title={`Still to come ${cash(t.toCome)}`} style={{ flex: t.toCome, background: color }} />}
              {t.spare > 0 && <div title={`${leftLabel} ${cash(t.spare)}`} style={{ flex: t.spare, background: 'var(--good)' }} />}
            </div>
          )}
          <div className="trio">
            <div className="stat">
              <span className="small muted">In account</span>
              <b>{cash(t.balance)}</b>
              <span className="xs muted">{t.balanceSource === 'estimated' ? 'estimated' : 'your balance'}</span>
            </div>
            <div className="stat">
              <span className="small muted">Still to come</span>
              <b>{cash(t.toCome)}</b>
              <span className="xs muted">{toCome.length} bill{toCome.length === 1 ? '' : 's'}{toCome[0] ? ` · ${fmtShort(toCome[0].date)}` : ''}</span>
            </div>
            <div className="stat">
              <span className="small muted">{leftLabel}</span>
              <b className={t.spare < 0 ? 'neg' : ''}>{cash(Math.abs(t.spare))}</b>
              <span className="xs muted">{leftNote}</span>
            </div>
          </div>
        </div>
      )}

      {open && (
        <div className="stack gap-12">
          {steady && t.balanceKnown && t.spare > 0 && (
            <p className="small muted">
              The buffer isn't spare: this account gets a steady amount every pay, so pays with fewer payments build it up
              {bufferFor
                ? ` for the ${fmtShort(bufferFor.period.start)} pay, which needs ${cash(bufferFor.need)} but only gets ${cash(bufferFor.deposit)} (the buffer covers the extra ${cash(bufferFor.need - bufferFor.deposit)}).`
                : ' for pays with an extra week.'}
            </p>
          )}

          {/* Bills still to come this pay */}
          {toCome.length > 0 && <div>
            <h3 className="h3">Still to come before {fmtShort(t.period.nextPayday)}</h3>
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
            <Disclosure title="Already come out this pay" meta={cash(t.paid)}>
              <div>
                {paid.map((r, i) => (
                  <div className="list-row small muted" key={`${r.name}-${r.date}-${i}`}>
                    <span style={{ flex: '0 0 72px' }}>{fmtShort(r.date)}</span>
                    <span className="grow">{r.name}</span>
                    <span className="num">{cash(r.amount)}</span>
                    <Icon name="check" size={14} />
                  </div>
                ))}
              </div>
            </Disclosure>
          )}

          {t.next.rows.length > 0 && (
            <Disclosure title={`Next pay (${fmtShort(t.next.period.start)}) puts in ${cash(t.next.deposit)}`}
              meta={`${t.next.rows.length} bill${t.next.rows.length === 1 ? '' : 's'}, ${cash(t.next.rows.reduce((s, r) => s + r.amount, 0))}`}>
              <div>
                {t.next.rows.map((r, i) => (
                  <div className="list-row small" key={`${r.name}-${r.date}-${i}`}>
                    <span style={{ flex: '0 0 72px' }} className="muted">{fmtShort(r.date)}</span>
                    <span className="grow">{r.name}</span>
                    <span className="num">{cash(r.amount)}</span>
                  </div>
                ))}
              </div>
            </Disclosure>
          )}
          {t.balanceSource === 'estimated' && t.balanceKnown && (
            <p className="small muted">Estimated as this pay's {cash(t.deposit)} deposit minus what's come out. Enter the real balance for an exact figure.</p>
          )}
        </div>
      )}
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

      {open && (
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
      )}
    </>
  );
}
