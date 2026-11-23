import type { ReactNode } from 'react';
import { accountMode } from '../../engine/balances/outflows';
import { balanceOn } from '../../engine/balances/estimate';
import { billTracker } from '../../engine/balances/billTracker';
import { nextBufferUse, payProjection } from '../../engine/balances/projection';
import { fmtDay, fmtShort, monthName, ordinal, todayISO } from '../../core/dates';
import { debtAdvice } from '../debts/logic/advice';
import { accountEnvelopes, envelopeHeld, transferKey } from '../../engine/envelope';
import { EnvelopeDetails, EnvelopeSummary } from './EnvelopeCards';
import { MovesSummary, OtherMoves, ToMoveNotes, paidHow } from './BankSeen';
import { asideMaxSaved, asideSplit, hasSetAsides, isHeldInAccount } from '../../engine/setAside';
import { AsideSpendsDetail, AsideSummary, asideColor } from './AsideCards';
import { type Period } from '../../engine/periods';
import { asideNames } from '../../engine/rebalance';
import { sameColor, tone } from '../../core/colors';
import { cash } from '../../core/money';
import type { Account, Budget } from '../../core/types';
import { Icon } from '../../ui/Icon';
import { PartsBar, type Part } from '../../ui/PartsBar';
import { Collapse, Disclosure, FlatDetails, ShortList } from '../../ui/components';

/** Takes `amount` off the last parts (what's not covered when the account is short), so the bar ends at the balance. */
function trimEnd(parts: Part[], amount: number) {
  for (let i = parts.length - 1; i >= 0 && amount > 0; i--) {
    const cut = Math.min(parts[i].value, amount);
    parts[i] = { ...parts[i], value: parts[i].value - cut };
    amount -= cut;
  }
}

const when = (days: number) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 0 ? `in ${days} days` : days === -1 ? 'yesterday' : `${-days} days ago`);

/**
 * An account across the pay you're in. Always shown, kept short: the three figures that matter (paid,
 * still to come, what's left) with one bar, a line per envelope, and anything that needs doing. Then
 * `toggle` (the card's Details button, so it stays at the top of what it opens). With `open`: the
 * explanations and every payment behind the figures.
 */
export function MonthTracker({ budget, account, today = todayISO(), open, toggle }: {
  budget: Budget; account: Account; today?: string; open: boolean; toggle?: ReactNode;
}) {
  const t = billTracker(budget, account.id, today);
  const toCome = t.rows.filter((r) => r.status !== 'paid');
  const paid = t.rows.filter((r) => r.status === 'paid');
  const total = t.paid + t.toCome;
  const envelopes = accountEnvelopes(budget, account.id, today);
  // Unspent envelope budget (Gas left this month, Food left this week) is assumed spent — reserved until it resets.
  const gasHeld = envelopeHeld(budget, account.id, today);
  // After bills and reserved gas: negative = short for this pay + this month's gas.
  const afterReserved = t.spare - gasHeld;
  // Bills paid on another account's card: their money is still here, waiting to be moved across.
  const moveOut = t.toMove.reduce((s, m) => s + m.amount, 0);
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
  const leftLabel = short ? 'Short'
    : overAsideMax ? 'Spare'
    : aside ? 'Put aside'
    : bufferShown !== undefined ? 'Buffer'
    : steady ? 'Ends'
    : 'Spare';
  const envNames = envelopes.map((e) => e.item.name).join(' and ');
  // Only envelopes here (no bills, nothing to move): their lines say it all, so no bar or figures.
  const envOnly = envelopes.length > 0 && total === 0 && moveOut === 0;
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
  // The figure tiles are narrow on a phone: a short note there, the full one behind Details.
  const namesShort = names.length <= 18 ? names : 'later costs';
  const tileNote = short ? (gasHeld > 0 ? 'after envelopes' : 'after bills')
    : overAsideMax ? 'above the max'
    : aside ? `for ${namesShort}`
    : bufferShown !== undefined && bufferFor ? `for ${fmtShort(bufferFor.period.start)}`
    : gasHeld > 0 ? 'after envelopes'
    : 'after bills';
  // What the put-aside money is for, in full, when the tile couldn't say it all.
  const asideNote = aside && (namesShort !== names || maxAside !== undefined) && !overAsideMax
    ? <p className="small muted">Put aside for {names}{maxAside !== undefined ? `, up to ${cash(maxAside)}` : ''}.</p>
    : null;
  const color = tone(account.color);
  // The bar: Paid (already out), then what's in the account now (the big balance) split by what it's for, each
  // part tappable, with a key underneath. A debt payment held here (Gem Visa) is its own part, so it reads as part
  // of the balance, not on top of it. When short, the needs run past the balance and the red part is what's missing.
  const asideParts = aside && !short ? asideSplit(budget, account.id, asideHeld) : [];
  const greenAmt = short ? 0 : aside ? (overAsideMax ? spareAmt - maxAside! : 0) : leftAmount;
  const heldNames = [...new Set(toCome.filter((r) => r.debtId).map((r) => r.name))];
  const debtColor = sameColor(account.color, '#1AA89B') ? 'var(--pal-sky)' : 'var(--pal-teal)';
  // Every bill is its own part (tap one to see it); the key adds them up by kind.
  const bar: Part[] = [
    ...toCome.map((r) => r.debtId
      ? { label: r.name, value: r.amount, color: debtColor, key: r.name.split(' ')[0], note: r.late ? 'not sent yet' : fmtShort(r.date) }
      : { label: r.name, value: r.amount, color, key: 'Bills', note: r.late ? `${fmtShort(r.date)}, not seen yet` : fmtShort(r.date) }),
    { label: 'To move across', value: moveOut, color: 'var(--pal-stone)', key: 'To move' },
    { label: `Reserved for ${envNames}`, value: gasHeld, color: 'var(--pal-ochre)', key: 'Envelopes' },
    ...asideParts.map((x, i) => ({
      label: `${x.item.name} put aside`, value: x.amount, color: asideColor(i), key: x.item.name,
      note: x.item.maxSaved ? (x.amount >= x.item.maxSaved ? 'full' : `max ${cash(x.item.maxSaved)}`) : undefined,
    })),
    { label: overAsideMax ? 'Spare above the max' : leftLabel, value: greenAmt, color: 'var(--good)', key: leftLabel, noKey: true },
  ];
  if (short) trimEnd(bar, leftAmount);
  bar.unshift(...paid.map((r) => ({ label: r.name, value: r.amount, color: 'var(--line)', key: 'Paid', noKey: true, note: `paid ${fmtShort(r.date)}` })));
  bar.push({ label: 'Short', value: short ? leftAmount : 0, color: 'var(--bad)', note: `${cash(Math.max(0, t.balance))} in the account` });
  // Gem Visa held in this account until statement day — note the amount from Latitude's allocation.
  const gemHolds = (budget.debts ?? []).filter((d) => d.holdAccountId === account.id && d.rules === 'gem' && !d.payroll);
  const gemNotes = gemHolds.map((d) => {
    const adv = debtAdvice(budget, d, t.period);
    const due = t.rows.filter((r) => r.name === d.name && r.status !== 'paid');
    const held = due.reduce((s, r) => s + r.amount, 0);
    // Nothing still held this pay (paid already, or the statement falls in the next pay): nothing to say.
    if (held <= 0) return null;
    const dayLabel = d.statementDay ? `the ${ordinal(d.statementDay)}` : 'statement day';
    return {
      id: d.id,
      text: <>{d.name} {cash(held)} held for {dayLabel} — Gem’s allocation (instalments first, then interest-free by expiry; min {cash(adv.minimum ?? 0)}).</>,
    };
  }).filter(Boolean) as { id: string; text: ReactNode }[];

  return (
    <>
      <EnvelopeSummary budget={budget} account={account} envelopes={envelopes} color={color} today={today} />

      {!t.balanceKnown && (
        <div className="tip small stack gap-4">
          <b>Enter this account's balance to check {t.toCome ? fmtShort(toCome[0].date) : 'it'}</b>
          <span>
            This pay was split before your budget started, so the app can't tell what's in here.
            {t.toCome ? ` ${cash(t.toCome)} still comes out before payday — if the balance in the account is at least that, you're covered.` : ''}
          </span>
        </div>
      )}

      {/* Money put aside (a car fund): nothing comes out on a date, so what matters is what's built up and what it's paid for. */}
      {aside && !paysBills && <AsideSummary budget={budget} account={account} t={t} maxAside={maxAside} today={today} />}

      {t.balanceKnown && !(aside && !paysBills) && envOnly && (short || leftAmount > 0) && (
        <div className="env-line">
          <span className="small muted">{leftLabel} {leftNote}</span>
          <b className={`num ${short ? 'neg' : ''}`}>{cash(leftAmount)}</b>
        </div>
      )}

      {t.balanceKnown && !(aside && !paysBills) && !envOnly && (
        <div className="stack gap-8">
          {(total > 0 || gasHeld > 0 || moveOut > 0) && (
            <PartsBar parts={bar} keyed label={`${account.name} this pay: tap a part to see it`} />
          )}
          <div className="trio">
            <div className="stat">
              <span className="small muted">Paid</span>
              <b>{cash(t.paid)}</b>
              <span className="xs muted">{paid.length} bill{paid.length === 1 ? '' : 's'}</span>
            </div>
            <div className="stat">
              <span className="small muted">To come</span>
              <b>{cash(t.toCome)}</b>
              <span className="xs muted">{heldNames.length === 1 ? `incl. ${heldNames[0].split(' ')[0]}`
                : toCome[0] ? `next ${fmtShort(toCome[0].date)}` : `before ${fmtShort(t.period.nextPayday)}`}</span>
            </div>
            <div className="stat">
              <span className="small muted">{leftLabel}</span>
              <b className={short ? 'neg' : ''}>{cash(leftAmount)}</b>
              <span className="xs muted">{tileNote}</span>
            </div>
          </div>
          {short && gasHeld > 0 && (
            <p className="small muted">
              Needs {cash(t.toCome)} for bills and {cash(gasHeld)} still budgeted for {envNames}
              ({cash(t.toCome + gasHeld)} total) against {cash(t.balance)} in the account.
            </p>
          )}
        </div>
      )}
      {t.balanceKnown && <ToMoveNotes budget={budget} t={t} />}

      {toggle}
      <Collapse open={open} stacked><FlatDetails.Provider value>
        <div className="stack gap-12">
          {t.balanceKnown && !(aside && !paysBills) && <>
            {!short && gasHeld > 0 && spareAmt > 0 && bufferShown === undefined && (
              <p className="small muted">{cash(gasHeld)} still budgeted for {envNames} (assumed spent). Anything left when each one resets is yours.</p>
            )}
            {asideNote}
            {overAsideMax && <p className="small muted">Put aside {cash(asideHeld)} for {names} (max {cash(maxAside!)}); the rest after bills is spare.</p>}
            {!short && <MovesSummary t={t} />}
            {gemNotes.map((n) => <p className="small muted" key={n.id}>{n.text}</p>)}
          </>}
          {steady && t.balanceKnown && bufferShown !== undefined && bufferFor && (
            <p className="small muted">
              Buffer {cash(bufferShown)} is for the {fmtShort(bufferFor.period.start)} pay: it needs {cash(bufferFor.need)}, gets {cash(bufferFor.deposit)}.
              {gasHeld > 0 ? <> After bills and {cash(gasHeld)} reserved for {envNames}.</> : null}
              {spareAmt > bufferShown ? <> About {cash(spareAmt)} left after that.</> : null}
            </p>
          )}

          <EnvelopeDetails budget={budget} account={account} envelopes={envelopes} />

          {/* Bills still to come this pay */}
          {toCome.length > 0 && <div>
            <h3 className="h3">To come before {fmtShort(t.period.nextPayday)}</h3>
            {toCome.map((r, i) => (
              <div className="list-row" key={`${r.name}-${r.date}-${i}`}>
                <span style={{ flex: '0 0 72px' }}>
                  <span className="small strong block">{fmtShort(r.date)}</span>
                  <span className="xs muted">{when(r.days)}</span>
                </span>
                <span className="grow min0">
                  <span className="block">{r.name}</span>
                  {r.late && <span className="xs muted block">not out of any account yet</span>}
                </span>
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
                    <span className="grow min0">
                      <span className="block">{r.name}</span>
                      {paidHow(budget, r) && <span className="xs block">{paidHow(budget, r)}</span>}
                    </span>
                    <span className="num">{cash(r.amount)}</span>
                    <Icon name="check" size={14} />
                  </div>
                ))}
              </ShortList>
            </Disclosure>
          )}

          {aside && !paysBills && <AsideSpendsDetail budget={budget} account={account} today={today} />}
          {/* Money out you said the put-aside money paid for is listed above it, not here. */}
          <OtherMoves t={{ ...t, moves: t.moves.filter((m) => !budget.asideSpends?.[transferKey(account.id, m.txn)]) }} account={account} />

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
export function PayProjectionView({ budget, account, period, day, today = todayISO(), open, toggle }: {
  budget: Budget; account: Account; period: Period; day: string; today?: string; open: boolean; toggle?: ReactNode;
}) {
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

      {toggle}
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
