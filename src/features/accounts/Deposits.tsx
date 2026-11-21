import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../ui/Icon';
import { AccIcon, Chevron, Collapse, ColorPicker, Modal } from '../../ui/components';
import { ItemModal } from '../../shared/ItemModal';
import { fmtShort, ordinal, todayISO } from '../../core/dates';
import { depositFor, exactNeed, modeOf, smoothAmount, topsUp } from '../../engine/balances';
import { debtPerPay } from '../debts/logic/debts';
import { averageNeed, convert, isMonthEnvelope, isSetAside, itemDates, monthBudget, periodContaining, planFor, setAsidePerPay, shiftPeriod } from '../../engine/engine';
import { PayNav, useViewPeriod } from '../../state/period';
import { cash, centsToInput, parseMoney } from '../../core/money';
import { RoundSetting } from '../../shared/PaydayControl';
import { nextColor } from '../../core/colors';
import { newId, useBudget } from '../../state/store';
import { asideNames, balancedMode } from '../../engine/rebalance';
import { PAYDAY_MODE_HINT, PAYDAY_MODE_LABEL } from './logic/paydayModes';
import type { Account, Budget, Item, PaydayMode } from '../../core/types';

const items0 = (b: Budget, id: string) => b.items.some((i) => i.accountId === id);

const FREQ_LABEL = { once: 'one-off', weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly', yearly: 'yearly' };

/**
 * Deposits: what each payday sends to each account, and the costs paid from each, in a pop-up over
 * Accounts. Opens on one account when given its id.
 */
export function DepositsModal({ openId, onClose }: { openId?: string; onClose: () => void }) {
  const { budget, update } = useBudget();
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const [modal, setModal] = useState<{ item?: Item; accountId?: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => { if (openId) setOpen(openId); }, [openId]);
  // The account it opened on is scrolled into view once its details have opened.
  useEffect(() => {
    if (!openId) return;
    const t = setTimeout(() => document.getElementById(`dep-${openId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
    return () => clearTimeout(t);
  }, [openId]);

  const { period } = useViewPeriod();
  const plan = planFor(budget, period);

  function addAccount() {
    const id = newId();
    update((b) => {
      b.accounts.push({ id, name: 'New account', kind: 'bank', color: nextColor(b.accounts.map((x) => x.color)), groupId: b.groups[0]?.id ?? '' });
      b.split.push({ accountId: id, amount: 0 });
      return b;
    });
    setOpen(id);
  }

  // Debts and savings goals are managed in their own tabs.
  const managed = new Set([...(budget.debts ?? []).map((d) => d.accountId), ...(budget.savings ?? []).map((g) => g.accountId)]);
  // A goal's account that costs have been moved to is listed too, so they can be changed or moved back.
  const shown = budget.accounts.filter((a) => (!managed.has(a.id) || budget.items.some((i) => i.accountId === a.id)) && (showArchived || !a.archived));
  const total = shown.filter((a) => !a.archived && a.id !== budget.settings.payAccountId)
    .reduce((t, a) => t + (plan.accounts.find((p) => p.account.id === a.id)?.funded ?? 0), 0);

  return (
    <Modal title="Deposits" sub={`${cash(total)} on ${fmtShort(period.start)}`} onClose={onClose} className="wide"
      actions={<button className="btn small" onClick={addAccount}><Icon name="plus" size={16} /> Account</button>}>
      <PayNav compact />
      <div className="stack gap-8">
        {shown.map((a) => (
          <AccountSection key={a.id} account={a} open={open === a.id}
            onToggle={() => setOpen(open === a.id ? null : a.id)}
            periodNeed={plan.accounts.find((p) => p.account.id === a.id)?.need ?? 0}
            periodSends={plan.accounts.find((p) => p.account.id === a.id)?.funded ?? 0}
            periodDays={period.days}
            onEditItem={(item) => setModal({ item })}
            onAddItem={() => setModal({ accountId: a.id })} />
        ))}
      </div>
      <p className="note">Cards and Afterpay are set in <a href="#/debts">Debts</a>, goals in <a href="#/savings">Savings</a>.</p>
      {budget.accounts.some((a) => a.archived && !managed.has(a.id)) && (
        <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived' : 'Show archived accounts'}
        </button>
      )}
      {modal && createPortal(<ItemModal item={modal.item} accountId={modal.accountId} onClose={() => setModal(null)} />, document.body)}
    </Modal>
  );
}

/** One account's payday amount and costs, on its own (a tab in the account's pop-up on Accounts). */
export function AccountPayday({ account: a }: { account: Account }) {
  const { budget } = useBudget();
  const { period } = useViewPeriod();
  const plan = planFor(budget, period);
  const [modal, setModal] = useState<{ item?: Item; accountId?: string } | null>(null);
  const line = plan.accounts.find((p) => p.account.id === a.id);
  return (
    <>
      <PayNav compact />
      <AccountSection account={a} open bare onToggle={() => undefined} periodNeed={line?.need ?? 0} periodSends={line?.funded ?? 0} periodDays={period.days}
        onEditItem={(item) => setModal({ item })} onAddItem={() => setModal({ accountId: a.id })} />
      {modal && createPortal(<ItemModal item={modal.item} accountId={modal.accountId} onClose={() => setModal(null)} />, document.body)}
    </>
  );
}

function AccountSection({ account: a, open, bare, onToggle, periodNeed, periodSends, periodDays, onEditItem, onAddItem }: {
  account: Account; open: boolean; onToggle: () => void; periodNeed: number;
  /** Just the settings, without its row and heading (when it's already the only thing shown). */
  bare?: boolean;
  /** What the pay being viewed sends here: the same figure the Planner shows. */
  periodSends: number; periodDays: number;
  onEditItem: (i: Item) => void; onAddItem: () => void;
}) {
  const { budget, update } = useBudget();
  const isPay = a.id === budget.settings.payAccountId;
  const line = budget.split.find((l) => l.accountId === a.id);
  const split = line?.amount ?? 0;
  const mode = modeOf(line);
  // Balancing picks the payday amount for accounts with costs, so only the choices that stick are offered.
  const balanced = balancedMode(budget, a.id);
  const steady = mode === 'smooth' || items0(budget, a.id) ? smoothAmount(budget, a.id) : 0;
  const hasBalance = !!budget.balances?.[a.id];
  const [splitText, setSplitText] = useState(centsToInput(split));
  useEffect(() => setSplitText(centsToInput(split)), [split]);
  const items = budget.items.filter((i) => i.accountId === a.id).sort((x, y) => x.name.localeCompare(y.name));
  const avgNeed = averageNeed(budget, a.id);
  const today = todayISO();
  // Money put aside here (a WOF, tyres) stays in the account; the bills are what really comes out.
  const bills = items.filter((i) => !isSetAside(i) && !isMonthEnvelope(i));
  const asides = items.filter(isSetAside);
  const envelopes = items.filter(isMonthEnvelope);
  const asidePerPay = asides.filter((i) => !i.end || i.end >= today).reduce((t, i) => t + setAsidePerPay(i), 0)
    + envelopes.filter((i) => !i.end || i.end >= today).reduce((t, i) => t + monthBudget(i), 0);
  // Debts that store their payday payment here until statement day (e.g. Gem Visa → Misc bills).
  const heldDebts = (budget.debts ?? []).filter((d) => d.holdAccountId === a.id && !d.payroll);
  const costCount = items.length + heldDebts.length;

  function set<K extends keyof Account>(k: K, val: Account[K]) {
    update((b) => { const acc = b.accounts.find((x) => x.id === a.id); if (acc) acc[k] = val; return b; });
  }
  function setSplit(c: number) {
    update((b) => {
      const l = b.split.find((x) => x.accountId === a.id);
      if (l) l.amount = c; else b.split.push({ accountId: a.id, amount: c });
      return b;
    });
  }
  function setMode(m: PaydayMode) {
    update((b) => {
      const l = b.split.find((x) => x.accountId === a.id);
      if (l) { l.mode = m; delete l.auto; } else b.split.push({ accountId: a.id, amount: 0, mode: m });
      // One-pay adjustments were worked out for the old mode, so drop them for this pay on.
      const from = periodContaining(todayISO(), b.settings).start;
      for (const [start, o] of Object.entries(b.overrides ?? {})) if (start >= from && o && a.id in o) delete o[a.id];
      return b;
    });
  }
  function commitSplit() {
    const c = parseMoney(splitText);
    if (c === null || c < 0) { setSplitText(centsToInput(split)); return; }
    setSplit(c);
  }

  return (
    <section id={bare ? undefined : `dep-${a.id}`} className={`acc-section${bare ? ' bare' : ''}`} style={{ opacity: a.archived ? 0.6 : 1, scrollMarginTop: 8 }}>
      <button className="acc-head" aria-expanded={open} onClick={onToggle}>
        <AccIcon color={a.color} name={a.kind === 'external' ? 'send' : 'bank'} />
        <span className="grow">
          <b className="block">{a.name}</b>
          <span className="small muted">
            {isPay ? 'Pay lands here' : a.kind === 'external' ? 'Sent elsewhere' : `${costCount} cost${costCount === 1 ? '' : 's'}`}
            {a.archived ? ' · archived' : ''}
          </span>
        </span>
        {!isPay && (
          <span className="right">
            <b className="num">{cash(periodSends)}</b>
            <span className="small muted block">a pay</span>
          </span>
        )}
        <Chevron />
      </button>

      <Collapse open={open}>
        <div className="acc-body">
          <div className="form-grid">
            <label className="field">Name
              <input value={a.name} onChange={(e) => set('name', e.target.value)} />
            </label>
            <label className="field">Type
              <select value={a.kind} onChange={(e) => set('kind', e.target.value as Account['kind'])}>
                <option value="bank">My bank account</option>
                <option value="external">Sent elsewhere (card, person, fund)</option>
              </select>
            </label>
            <label className="field">Group
              <select value={a.groupId} onChange={(e) => set('groupId', e.target.value)}>
                {budget.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <ColorPicker value={a.color} onChange={(c) => set('color', c)} />
          </div>

          {!isPay && (
            <div className="stack gap-8">
              <span className="small muted">How payday fills this account</span>
              {(bills.length > 0 || items.length > 0 || heldDebts.length > 0) && (
                <div className="seg" role="group" aria-label="How payday fills this account" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
                  {/* Set amount: when balancing is not choosing for you, or you already use it. */}
                  {(!balanced || mode === 'fixed') && (
                    <button aria-pressed={mode === 'fixed'} onClick={() => setMode('fixed')}>{PAYDAY_MODE_LABEL.fixed}</button>
                  )}
                  {bills.length > 0 && (
                    <button aria-pressed={mode === 'smooth'} onClick={() => setMode('smooth')}>
                      {PAYDAY_MODE_LABEL.smooth}{balanced === 'smooth' ? ' · recommended' : ''}
                    </button>
                  )}
                  {items.length > 0 && (
                    <button aria-pressed={mode === 'exact'} onClick={() => setMode('exact')}>
                      {PAYDAY_MODE_LABEL.exact}{balanced === 'not-fixed' ? ' · recommended' : ''}
                    </button>
                  )}
                </div>
              )}
              {(bills.length > 0 || items.length > 0) && (
                <ul className="stack gap-4 small muted" style={{ margin: 0, paddingLeft: 18 }}>
                  <li><b>{PAYDAY_MODE_LABEL.fixed}</b>{mode === 'fixed' ? ' (in use)' : ''}: {PAYDAY_MODE_HINT.fixed}</li>
                  <li><b>{PAYDAY_MODE_LABEL.smooth}</b>{mode === 'smooth' ? ' (in use)' : ''}{balanced === 'smooth' && mode !== 'smooth' ? ' · recommended' : ''}: {PAYDAY_MODE_HINT.smooth}</li>
                  <li><b>{PAYDAY_MODE_LABEL.exact}</b>{mode === 'exact' ? ' (in use)' : ''}{balanced === 'not-fixed' && mode !== 'exact' ? ' · recommended' : ''}: {PAYDAY_MODE_HINT.exact}</li>
                </ul>
              )}
              {periodSends !== (mode === 'smooth' ? steady : periodNeed) && mode !== 'fixed' && (
                <p className="small muted">This pay sends {cash(periodSends)}.</p>
              )}

              <RoundSetting accountId={a.id} />

              {mode === 'fixed' && (
                <>
                  <label className="field" style={{ maxWidth: 260 }}>Sent here each payday (NZD)
                    <input inputMode="decimal" value={splitText} onChange={(e) => setSplitText(e.target.value)}
                      onBlur={commitSplit} onKeyDown={(e) => e.key === 'Enter' && commitSplit()} />
                  </label>
                  {items.length > 0 && (
                    <div className="tip">
                      <Icon name="bulb" />
                      <span>
                        This period ({periodDays} days) needs <b>{cash(periodNeed)}</b>. On average it needs <b>{cash(avgNeed)}</b> a month.
                        {!hasBalance && periodNeed > split && ` Sending ${cash(split)} leaves it ${cash(periodNeed - split)} short.`}
                      </span>
                    </div>
                  )}
                  {items.length > 0 && items.every((i) => i.frequency === 'weekly') && (
                    <div className="tip wrap" style={{ alignItems: 'center' }}>
                      <Icon name="bulb" />
                      <span style={{ flex: '1 1 220px' }}>
                        A set amount goes short in 5-week pays and builds up in 4-week ones. <b>{PAYDAY_MODE_LABEL.smooth}</b> evens it out: about <b>{cash(avgNeed)}</b> every pay, with 4-week pays leaving enough over for the 5th week.
                      </span>
                      <button className="btn small primary" onClick={() => setMode('smooth')}>Use level amount</button>
                    </div>
                  )}
                </>
              )}

              {mode === 'smooth' && (
                <div className="tip">
                  <Icon name="bulb" />
                  <span>
                    {steady === avgNeed
                      ? <>Sends <b>{cash(steady)}</b> every payday.</>
                      : <>Sends <b>{cash(steady)}</b> next payday, then usually <b>{cash(avgNeed)}</b>. {steady > avgNeed ? 'The extra covers earlier transfers and leaves enough for the next 5-week pay, so later pays stay level.' : 'A little less while there\u2019s extra in the account.'}</>}
                    {' '}4-week periods leave a little over that covers the 5th week, so the account never goes below $0.
                    {hasBalance
                      ? ' Worked out from the balance in Accounts, and it updates when you change it.'
                      : <> Add this account's balance in <a href="#/accounts">Accounts</a> for an exact figure.</>}
                  </span>
                </div>
              )}

              {mode === 'exact' && (
                <div className="tip">
                  <Icon name="bulb" />
                  <span>
                    {asides.length > 0 ? (() => {
                      const next = shiftPeriod(periodContaining(today, budget.settings), 1, budget.settings);
                      const each = asides.map((i) => `${i.name} ${cash(setAsidePerPay(i))}`).join(' + ');
                      return bills.length === 0
                        ? <>Puts <b>{cash(asidePerPay)}</b> aside each payday ({each}). It stays in the account until you need it, so the balance builds up, and what's built up never lowers what payday sends.</>
                        : <>Sends what each pay's bills need, plus <b>{cash(asidePerPay)}</b> put aside for {asideNames(budget, a.id)}. Next pay ({fmtShort(next.start)}) that's <b>{cash(depositFor(budget, a.id, next, today))}</b>. What's put aside stays in the account and is never counted towards the bills.</>;
                    })() : topsUp(budget, a.id) ? (() => {
                      const next = shiftPeriod(periodContaining(today, budget.settings), 1, budget.settings);
                      const sends = depositFor(budget, a.id, next, today);
                      const due = exactNeed(budget, a.id, next);
                      return <>Sends what each pay's bills need, <b>less whatever is already left in the account</b>. Next pay ({fmtShort(next.start)}): bills {cash(due)}{due > sends ? `, ${cash(due - sends)} already there` : ''}, so it sends <b>{cash(sends)}</b>.</>;
                    })() : <>Sends exactly what each period needs. This period ({periodDays} days) that's <b>{cash(periodNeed)}</b>, averaging <b>{cash(avgNeed)}</b> a month.</>}
                  </span>
                </div>
              )}
            </div>
          )}

          {(a.kind === 'bank' || items.length > 0 || heldDebts.length > 0) && (
            <div>
              <div className="card-head" style={{ marginBottom: 4 }}>
                <h3 className="h3">{asides.length === 0 && heldDebts.length === 0 ? 'Costs paid from here' : bills.length || heldDebts.length ? 'Costs and money put aside' : 'Money put aside here'}</h3>
                <button className="btn small" onClick={onAddItem}><Icon name="plus" size={16} /> Add cost</button>
              </div>
              {items.length === 0 && heldDebts.length === 0 && <p className="small muted">No costs yet.</p>}
              {heldDebts.map((d) => {
                const perPay = debtPerPay(budget, d);
                const stmt = d.statementDay ? ordinal(d.statementDay) : 'statement day';
                return (
                  <a key={d.id} className="list-row" href="#/debts" title={`Open ${d.name} in Debts to change where the payment is stored`}>
                    <span className="grow">
                      {d.name}
                      <span className="small muted block">
                        Debt payment · stored here until the {stmt} · set on {d.name} in Debts
                      </span>
                    </span>
                    <b>{perPay !== undefined ? cash(perPay) : '—'}</b>
                    <Icon name="card" size={16} />
                  </a>
                );
              })}
              {items.map((i) => {
                const kept = isSetAside(i);
                const env = isMonthEnvelope(i);
                const next = kept || env ? undefined : itemDates(i, today, '2100-01-01', budget.settings)[0];
                return (
                  <button key={i.id} className="list-row" onClick={() => onEditItem(i)}>
                    <span className="grow">
                      {i.name}
                      <span className="small muted block">
                        {kept
                          ? `${FREQ_LABEL[i.frequency]} · put aside, ${cash(setAsidePerPay(i))} a pay${i.maxSaved ? ` · max ${cash(i.maxSaved)}` : ''}${i.end && i.end < today ? ' · stopped' : i.start > today ? ` · from ${fmtShort(i.start)}` : ''}`
                          : env
                          ? `${FREQ_LABEL[i.frequency]} · month envelope ${cash(monthBudget(i))}/mo · resets each month${i.end && i.end < today ? ' · stopped' : i.start > today ? ` · from ${fmtShort(i.start)}` : ''}`
                          : <>
                            {FREQ_LABEL[i.frequency]}{next ? ` · next ${fmtShort(next)}` : ' · finished'}
                            {i.frequency !== 'once' && i.frequency !== 'monthly' ? ` · ${cash(convert(i.amount, i.frequency, 'month'))}/mo avg` : ''}
                          </>}
                        {i.note ? ` · ${i.note}` : ''}
                      </span>
                    </span>
                    <b>{cash(i.amount)}</b>
                    <Icon name="edit" size={16} />
                  </button>
                );
              })}
            </div>
          )}

          {!isPay && (
            <div className="row">
              <button className="btn small ghost" onClick={() => set('archived', !a.archived)}>{a.archived ? 'Restore account' : 'Archive account'}</button>
            </div>
          )}
        </div>
      </Collapse>
    </section>
  );
}
