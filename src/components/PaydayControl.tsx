import { useEffect, useState } from 'react';
import { modeOf } from '../lib/balances';
import { centsToInput, money, parseMoney } from '../lib/money';
import type { PaydayMode } from '../lib/types';
import { useBudget } from '../lib/store';

/** "Sent each payday": a fixed amount, or worked out from plans/goals each pay. */
export function PaydayControl({ accountId, autoLabel, autoHint, thisPeriod }: {
  accountId: string; autoLabel: string; autoHint: string; thisPeriod: number;
}) {
  const { budget, update } = useBudget();
  const line = budget.split.find((l) => l.accountId === accountId);
  const auto = modeOf(line) !== 'fixed';
  const amount = line?.amount ?? 0;
  const [text, setText] = useState(centsToInput(amount));
  useEffect(() => setText(centsToInput(amount)), [amount]);

  function set(patch: { amount?: number; mode?: PaydayMode }) {
    update((b) => {
      const l = b.split.find((x) => x.accountId === accountId);
      if (l) { Object.assign(l, patch); delete l.auto; } else b.split.push({ accountId, amount: 0, ...patch });
      return b;
    });
  }
  function commit() {
    const c = parseMoney(text);
    if (c === null || c < 0) setText(centsToInput(amount)); else set({ amount: c });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label className="row" style={{ fontSize: 14, cursor: 'pointer', minHeight: 44 }}>
        <input type="checkbox" checked={auto} onChange={(e) => set({ mode: e.target.checked ? 'exact' : 'fixed' })}
          style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
        <span>
          <b>{autoLabel}</b>
          <span className="small muted" style={{ display: 'block' }}>{autoHint}</span>
        </span>
      </label>
      {auto ? (
        <p className="small">This pay sends <b>{money(thisPeriod)}</b>.</p>
      ) : (
        <label className="field" style={{ maxWidth: 260 }}>Sent each payday (NZD)
          <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)}
            onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
        </label>
      )}
    </div>
  );
}
