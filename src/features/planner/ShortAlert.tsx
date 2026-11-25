import { useState } from 'react';
import { cash } from '../../core/money';
import type { Budget } from '../../core/types';
import type { AccountPlan } from '../../engine/plan';
import type { Period } from '../../engine/periods';
import { Icon } from '../../ui/Icon';

const KEY = 'paydays.shortDismissed';

/** What's short this pay, as one string: a dismissal holds until the accounts or amounts change. */
const signature = (period: Period, shorts: AccountPlan[]) =>
  `${period.start}|${shorts.map((s) => `${s.account.id}:${s.diff}`).join(',')}`;

function readDismissed(): string[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { return []; }
}

/**
 * "Gem Visa needs $182 more this 29-day period." Dismissable: it stays away for this pay until what's
 * short changes. Accounts the bank already shows paid enough aren't passed in (`shortAccounts`).
 */
export function ShortAlert({ budget, shorts, period }: { budget: Budget; shorts: AccountPlan[]; period: Period }) {
  const sig = signature(period, shorts);
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!shorts.length || dismissed.includes(sig)) return null;
  const dismiss = () => {
    // Keep only the last few, so the list doesn't grow pay after pay.
    const next = [...dismissed.filter((d) => d !== sig), sig].slice(-20);
    setDismissed(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: dismissed until reload */ }
  };
  return (
    <div className="alert" role="status">
      <Icon name="alert" />
      <span className="grow">
        {shorts.map((s) => `${s.account.name} needs ${cash(-(s.diff ?? 0))} more`).join(' · ')}
        {' '}this {period.days}-day period.
        {shorts.some((s) => s.account.kind === 'bank' && !budget.balances?.[s.account.id]) && (
          <> That's unless it's already in {shorts.length === 1 ? 'the account' : 'those accounts'}: <a href="#/accounts">enter the balance in Accounts</a> to check.</>
        )}
      </span>
      <button className="icon-btn mini plain" aria-label="Dismiss" onClick={dismiss}><Icon name="x" size={16} /></button>
    </div>
  );
}
