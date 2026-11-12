import { useState } from 'react';
import { Donut, Legend } from '../components/Donut';
import { Icon } from '../components/Icon';
import { convert, planFor, plannedAverage, type View } from '../lib/engine';
import { PayNav, useViewPeriod, ViewModes } from '../lib/period';
import { money } from '../lib/money';
import { DEBT_RATIO_GUIDE } from '../lib/rebalance';
import { useBudget } from '../lib/store';
import type { RuleBucket } from '../lib/types';

const BUCKETS: { k: RuleBucket; label: string; color: string }[] = [
  { k: 'needs', label: 'Needs', color: '#14A38B' },
  { k: 'wants', label: 'Wants', color: '#E8B23A' },
  { k: 'savings', label: 'Savings and debt', color: '#E0527F' },
];

export function Insights() {
  const { budget } = useBudget();
  const { settings, accounts, groups } = budget;
  // Same views as the Planner: this pay, this pay per week / fortnight, or the next 12 pays averaged
  // per month / added up for the year.
  const { period, mode } = useViewPeriod();
  const plan = planFor(budget, period);
  const perPeriod = mode === 'period' || mode === 'week' || mode === 'fortnight';
  const scale = (c: number) => (mode === 'week' ? Math.round((c * 7) / period.days) : mode === 'fortnight' ? Math.round((c * 14) / period.days)
    : mode === 'period' ? c : convert(c, 'monthly', mode as View));
  const pay = scale(plan.pay);
  const live = accounts.filter((a) => !a.archived);
  const sent = new Map(live.filter((a) => a.id !== settings.payAccountId).map((a) => [a.id,
    scale(perPeriod ? plan.accounts.find((x) => x.account.id === a.id)?.funded ?? 0 : plannedAverage(budget, a.id).sent)]));
  const leftover = pay - [...sent.values()].reduce((t, x) => t + x, 0);
  const per = mode === 'period' ? 'this pay' : mode === 'week' ? 'a week' : mode === 'fortnight' ? 'a fortnight' : mode === 'month' ? 'a month' : 'a year';
  const perAccount = live.map((a) => ({
    account: a,
    amount: a.id === settings.payAccountId ? Math.max(0, leftover) : sent.get(a.id) ?? 0,
  })).filter((x) => x.amount > 0);

  const byGroup = groups.map((g) => ({
    group: g,
    amount: perAccount.filter((x) => x.account.groupId === g.id).reduce((s, x) => s + x.amount, 0),
    members: perAccount.filter((x) => x.account.groupId === g.id),
  }));

  // The piece of a rule bar being looked at (hovered, focused or tapped): its accounts show underneath.
  const [openPart, setOpenPart] = useState<string | null>(null);
  const pctOf = (c: number) => (pay ? Math.round((c / pay) * 100) : 0);
  const debtAccounts = new Set((budget.debts ?? []).map((d) => d.accountId));
  const groupSlices = byGroup.map((g) => ({ label: g.group.name, value: g.amount, color: g.group.color }));
  const accountSlices = perAccount.map((x) => ({ label: x.account.name, value: x.amount, color: x.account.color }));

  const byBucket = BUCKETS.map((b) => {
    const amount = byGroup.filter((g) => g.group.bucket === b.k).reduce((s, g) => s + g.amount, 0);
    return { ...b, amount, pct: pay ? (amount / pay) * 100 : 0, target: settings.rule[b.k] };
  });

  const tips: string[] = [];
  for (const b of byBucket) {
    const diff = b.amount - (pay * b.target) / 100;
    if (Math.abs(b.pct - b.target) < 3) continue;
    const top = perAccount
      .filter((x) => groups.find((g) => g.id === x.account.groupId)?.bucket === b.k)
      .sort((x, y) => y.amount - x.amount)[0];
    if (diff > 0) {
      tips.push(`${b.label} is ${Math.round(b.pct)}% of pay, ${Math.round(b.pct - b.target)} points over the ${b.target}% target (${money(diff, { whole: true })} ${per}).${top ? ` The biggest part is ${top.account.name} at ${money(top.amount, { whole: true })}.` : ''}`);
    } else {
      tips.push(`${b.label} is ${Math.round(b.pct)}% of pay, under the ${b.target}% target by ${money(-diff, { whole: true })} ${per}.`);
    }
  }

  return (
    <>
      <header className="between">
        <PayNav title="Insights" />
        <ViewModes />
      </header>
      <p className="small muted" style={{ marginTop: -12 }}>
        {mode === 'period' ? `Where the ${money(pay)} pay goes.`
          : perPeriod ? `This pay's ${money(plan.pay)} as ${per}: ${money(pay)}.`
          : `The next 12 pays, ${mode === 'month' ? 'averaged per month' : 'added up for the year'}, against pay of ${money(pay)} ${per}.`}
      </p>

      {/* Laid out like the Planner's "Where this pay goes": title on top, chart, then amounts and shares, largest first. */}
      <section className="grid-2">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h2 className="h2">By group</h2>
          <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', alignContent: 'center', gap: 24 }}>
            <Donut size={170} slices={groupSlices}>
              <span className="small muted">{mode === 'period' ? 'This pay' : `Per ${mode}`}</span>
              <b style={{ fontSize: 19 }}>{money(pay, { whole: true })}</b>
            </Donut>
            <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex' }}>
              <Legend slices={groupSlices} amounts />
            </div>
          </div>
        </div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h2 className="h2">By account</h2>
          <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', alignContent: 'center', gap: 24 }}>
            <Donut size={170} slices={accountSlices}>
              <span className="small muted">Accounts</span>
              <b style={{ fontSize: 19 }}>{accountSlices.length}</b>
            </Donut>
            <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex' }}>
              <Legend slices={accountSlices} amounts />
            </div>
          </div>
        </div>
      </section>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="between">
          <h2 className="h2">Compared with the {settings.rule.name} rule</h2>
          <a href="#/settings" className="btn small" style={{ textDecoration: 'none', color: 'inherit' }}>Change rule</a>
        </div>
        {byBucket.map((b) => {
          // What's inside the bar: one piece per group, each made of its accounts.
          const parts = byGroup.filter((g) => g.group.bucket === b.k && g.amount > 0);
          const open = parts.find((g) => g.group.id === openPart);
          return (
            <div key={b.k}>
              <div className="between" style={{ fontSize: 14 }}>
                <b>{b.label}</b>
                <span><b>{Math.round(b.pct)}%</b><span className="muted"> · target {b.target}% · {money(b.amount, { whole: true })}</span></span>
              </div>
              <div className="bar rule-bar">
                <div className="rule-fill">
                  {parts.map((g) => (
                    <button key={g.group.id} className="rule-part" aria-expanded={openPart === g.group.id}
                      aria-label={`${g.group.name}: ${pctOf(g.amount)}% of pay, ${money(g.amount, { whole: true })}. Show what's in it`}
                      style={{ width: `${Math.min(100, pay ? (g.amount / pay) * 100 : 0)}%`, background: g.group.color, opacity: open && openPart !== g.group.id ? 0.45 : 1 }}
                      onMouseEnter={() => setOpenPart(g.group.id)} onMouseLeave={() => setOpenPart(null)}
                      onFocus={() => setOpenPart(g.group.id)} onBlur={() => setOpenPart(null)}
                      onClick={() => setOpenPart(openPart === g.group.id ? null : g.group.id)} />
                  ))}
                </div>
                <span className="target" style={{ left: `${b.target}%` }} aria-hidden="true" />
              </div>
              {/* Each piece by name, so the bar reads without hovering (and on a phone, where you tap). */}
              <div className="row small" style={{ flexWrap: 'wrap', gap: '4px 14px', marginTop: 8 }}>
                {parts.length === 0 && <span className="muted">{groups.filter((g) => g.bucket === b.k).map((g) => g.name).join(', ') || 'No groups'}: nothing this {mode === 'period' ? 'pay' : mode}</span>}
                {parts.map((g) => (
                  <button key={g.group.id} className="rule-key" aria-expanded={openPart === g.group.id}
                    onMouseEnter={() => setOpenPart(g.group.id)} onMouseLeave={() => setOpenPart(null)}
                    onClick={() => setOpenPart(openPart === g.group.id ? null : g.group.id)}>
                    <span className="dot" style={{ background: g.group.color }} />
                    {g.group.name} <b>{pctOf(g.amount)}%</b> <span className="muted">{money(g.amount, { whole: true })}</span>
                  </button>
                ))}
              </div>
              {open && (
                <div className="rule-detail" role="status">
                  <div className="between" style={{ flexWrap: 'nowrap' }}>
                    <b>{open.group.name}</b>
                    <span><b>{pctOf(open.amount)}%</b> <span className="muted">of pay · {money(open.amount, { whole: true })}</span></span>
                  </div>
                  {[...open.members].sort((x, y) => y.amount - x.amount).map((m) => (
                    <div key={m.account.id} className="between small" style={{ flexWrap: 'nowrap' }}>
                      <span className="row" style={{ gap: 8, minWidth: 0 }}><span className="dot" style={{ background: m.account.color }} />{m.account.name}</span>
                      <span className="num"><span className="muted">{money(m.amount, { whole: true })}</span> <b style={{ display: 'inline-block', width: 38, textAlign: 'right' }}>{pctOf(m.amount)}%</b></span>
                    </div>
                  ))}
                  {/* Debt has its own rule of thumb, separate from the savings-and-debt target above. */}
                  {open.members.some((m) => debtAccounts.has(m.account.id)) && (() => {
                    const debt = open.members.filter((m) => debtAccounts.has(m.account.id)).reduce((t, m) => t + m.amount, 0);
                    const over = pay > 0 && debt / pay > DEBT_RATIO_GUIDE;
                    return <span className={`small ${over ? 'neg' : 'muted'}`}>Debt repayments are {pctOf(debt)}% of pay: {over ? 'above' : 'under'} the usual guideline of {Math.round(DEBT_RATIO_GUIDE * 100)}%.</span>;
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {tips.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 className="h2">Suggestions</h2>
          {tips.map((t) => <div className="tip" key={t}><Icon name="bulb" /><span>{t}</span></div>)}
        </section>
      )}
    </>
  );
}
