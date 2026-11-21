import { fmtShort, fmtSpan } from '../../../core/dates';
import { cash, centsToInput } from '../../../core/money';
import { balanceTargets } from '../check/balances';
import { csvBalance, csvTargets } from '../check/transactions';
import { NEW_GOAL, NOT_MINE, type Draft } from '../check/draft';
import { CATEGORY_LABEL, shopMap, summarize } from '../../../features/insights/logic/spending';
import { isKiwiSaver } from '../../../features/savings/logic/kiwisaver';
import { useBudget } from '../../../state/store';
import { Icon } from '../../../ui/Icon';
import { Money } from './Rundown';

/** A KiwiSaver statement or screen: which goal, the balance and its date, each fund, and what went in and was earned. */
/** A bank's list of accounts: each line's balance, and which of your accounts it goes to (matched by number or name, to check). */
export function BalancesCheck({ draft, edit }: { draft: Draft; edit: (fn: (d: Draft) => void) => void }) {
  const { budget } = useBudget();
  const t = draft.balances;
  const accounts = balanceTargets(budget);
  return (
    <>
      <div className="form-grid">
        <label className="field">As at
          <input type="date" value={t.date} onChange={(e) => edit((d) => { d.balances.date = e.target.value; })} />
          <span className="xs muted">{t.bank ? `${t.bank} · ` : ''}{t.rows.length} account{t.rows.length === 1 ? '' : 's'} read</span>
        </label>
      </div>
      {t.rows.length === 0 && <p className="small muted">No accounts were read from it.</p>}
      <div className="stack gap-12">
        {t.rows.map((r, i) => {
          const acc = accounts.find((a) => a.id === r.accountId);
          const prev = acc ? budget.balances?.[acc.id] : undefined;
          return (
            <div key={i} className="stack gap-6" style={{ borderTop: i ? '1px solid var(--line)' : undefined, paddingTop: i ? 'var(--s-3)' : 0 }}>
              <div className="between gap-8 small">
                <b className="clip">{r.name || 'Account'}</b>
                <span className="xs muted clip">{r.number || 'no number shown'}</span>
              </div>
              <div className="row nowrap top gap-8">
                <label className="field grow">
                  <span className="sr-only">Your account for {r.name || 'this account'}</span>
                  <select value={r.accountId} onChange={(e) => edit((d) => { d.balances.rows[i].accountId = e.target.value; d.balances.rows[i].matchedBy = undefined; })}>
                    {!r.accountId && <option value="">Choose your account…</option>}
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    <option value={NOT_MINE}>Not one of mine (leave out)</option>
                  </select>
                  <span className="xs muted">{r.matchedBy === 'number' ? 'Matched by account number' : r.matchedBy === 'name' ? 'Matched by name: check it' : r.accountId === NOT_MINE ? 'Left out' : 'Choose which account this is'}</span>
                </label>
                <label className="field" style={{ width: 120, flex: '0 0 auto' }}>
                  <span className="sr-only">{r.name || 'This account'}’s balance</span>
                  <input inputMode="decimal" value={r.balance} placeholder={r.available || '0.00'} aria-label={`${r.name || 'This account'} balance`} onChange={(e) => edit((d) => { d.balances.rows[i].balance = e.target.value; })} />
                  <span className="xs muted">{prev ? `was ${cash(prev.amount)}` : '\u00a0'}</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function KiwiSaverCheck({ draft, edit }: { draft: Draft; edit: (fn: (d: Draft) => void) => void }) {
  const { budget } = useBudget();
  const k = draft.kiwisaver;
  const goals = (budget.savings ?? []).filter(isKiwiSaver);
  const others = (budget.savings ?? []).filter((g) => !isKiwiSaver(g));
  const set = (key: 'balance' | 'opening' | 'employee' | 'employer' | 'government' | 'voluntary' | 'withdrawals' | 'earnings' | 'tax' | 'returns') => (v: string) => edit((d) => { d.kiwisaver[key].value = v; });
  return (
    <>
      <label className="field">Which KiwiSaver it’s for
        <select value={k.goalId} onChange={(e) => edit((d) => { d.kiwisaver.goalId = e.target.value; })}>
          {goals.map((g) => <option key={g.id} value={g.id}>{g.name} (now {cash(g.balance)})</option>)}
          {others.length > 0 && <optgroup label="Other savings goals">{others.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</optgroup>}
          <option value={NEW_GOAL}>+ A new KiwiSaver goal</option>
        </select>
        {k.provider && <span className="xs muted">On the document: “{k.provider}”</span>}
      </label>
      <div className="form-grid">
        <Money label="Balance (closing value)" fig={k.balance} placeholder="31,614.19" onChange={set('balance')} />
        <label className="field">As at
          <input type="date" value={k.date} onChange={(e) => edit((d) => { d.kiwisaver.date = e.target.value; })} />
        </label>
      </div>
      <div className="stack gap-8">
        <b className="small">Funds</b>
        {k.funds.map((f, i) => (
          <div key={i} className="row nowrap gap-8">
            <input aria-label="Fund" value={f.name} placeholder="High Growth" onChange={(e) => edit((d) => { d.kiwisaver.funds[i].name = e.target.value; })} />
            <input aria-label={`${f.name || 'Fund'} value`} inputMode="decimal" value={f.value} placeholder="0.00" onChange={(e) => edit((d) => { d.kiwisaver.funds[i].value = e.target.value; })} />
            <button className="icon-btn plain" aria-label={`Remove ${f.name || 'fund'}`} onClick={() => edit((d) => { d.kiwisaver.funds.splice(i, 1); })}><Icon name="x" size={16} /></button>
          </div>
        ))}
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => edit((d) => { d.kiwisaver.funds.push({ name: '', value: '' }); })}><Icon name="plus" size={16} /> Add a fund</button>
      </div>
      <details className="small" open={!!(k.since || k.opening.value || k.earnings.value || k.returns.value)}>
        <summary>Contributions and returns</summary>
        <div className="form-grid" style={{ marginTop: 'var(--s-2)' }}>
          <label className="field">From
            <input type="date" value={k.since} onChange={(e) => edit((d) => { d.kiwisaver.since = e.target.value; })} />
            <span className="xs muted">The opening value’s date.</span>
          </label>
          <Money label="Opening value" fig={k.opening} onChange={set('opening')} />
          <Money label="Your contributions" fig={k.employee} onChange={set('employee')} />
          <Money label="Employer contributions" fig={k.employer} onChange={set('employer')} />
          <Money label="Government contribution" fig={k.government} onChange={set('government')} />
          <Money label="Voluntary contributions" fig={k.voluntary} onChange={set('voluntary')} />
          <Money label="Withdrawals" fig={k.withdrawals} onChange={set('withdrawals')} />
          <Money label="Investment earnings (before tax)" fig={k.earnings} placeholder="A loss: -500.00" onChange={set('earnings')} />
          <Money label="PIE tax" fig={k.tax} onChange={set('tax')} />
          <Money label="Returns (if that’s all it shows)" fig={k.returns} onChange={set('returns')} />
        </div>
      </details>
    </>
  );
}

/**
 * A bank or card export: a file doesn't say whose it is, so you're asked which card or account (or
 * shown the one with that number from last time, to check), and what's owed or in it now.
 */
export function TransactionsCheck({ draft, edit }: { draft: Draft; edit: (fn: (d: Draft) => void) => void }) {
  const { budget } = useBudget();
  const t = draft.transactions;
  const rows = t.read.rows;
  const targets = csvTargets(budget);
  const isDebt = t.target.startsWith('debt:');
  const suggested = csvBalance(draft, budget);
  const out = rows.filter((x) => x.amount < 0).reduce((a, x) => a - x.amount, 0);
  const inn = rows.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0);
  const matched = t.matchedBy ? targets.find((x) => x.value === t.target) : undefined;
  const shown = t.amount ?? (suggested ? centsToInput(isDebt ? Math.max(0, suggested.amount) : suggested.amount) : '');
  const top = rows.length ? summarize(rows, rows[0].date, rows[rows.length - 1].date, shopMap(budget)).categories.filter((c) => c.category !== 'other').slice(0, 3) : [];
  return (
    <>
      {rows.length > 0 && (
        <p className="small">{rows.length} transaction{rows.length === 1 ? '' : 's'}, {fmtSpan(rows[0].date, rows[rows.length - 1].date)}: {cash(out)} {t.read.card ? 'spent' : 'out'}, {cash(inn)} {t.read.card ? 'paid' : 'in'}.
          {top.length > 0 && <span className="muted"> Most went on {top.map((c) => `${CATEGORY_LABEL[c.category].toLowerCase()} (${cash(c.total, { whole: true })})`).join(', ')}.</span>}
        </p>
      )}
      <label className="field">Which {t.read.card ? 'card' : 'card or account'} is this for?
        <select value={t.target} onChange={(e) => edit((d) => { d.transactions.target = e.target.value; d.transactions.matchedBy = undefined; d.transactions.amount = null; })}>
          {!t.target && <option value="">Choose…</option>}
          {(t.read.card ? (['Cards and loans', 'Accounts'] as const) : (['Accounts', 'Cards and loans'] as const)).filter((g) => targets.some((x) => x.group === g)).map((g) => (
            <optgroup key={g} label={g}>{targets.filter((x) => x.group === g).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</optgroup>
          ))}
        </select>
        <span className="xs muted">{matched
          ? `Chosen because ${matched.label} has number ending ${t.matchedBy}. Change it if that’s wrong.`
          : `The file doesn’t say whose it is${t.read.ending ? `. Once you confirm, number ending ${t.read.ending} goes straight to it next time` : ''}.`}</span>
      </label>
      {t.target && (
        <label className="field">{isDebt ? 'Owed now' : 'Balance now'}
          <input inputMode="decimal" value={shown} placeholder={isDebt ? 'What your app says you owe' : 'What your banking app says'}
            onChange={(e) => edit((d) => { d.transactions.amount = e.target.value; })} />
          <span className="xs muted">{t.amount === null && suggested
            ? `${suggested.working} That’s as at ${fmtShort(suggested.asOf)}: check it against your app.`
            : t.amount !== null && t.amount.trim() ? 'As at today, as you typed it.' : 'Leave it empty to keep what’s saved.'}</span>
        </label>
      )}
    </>
  );
}
