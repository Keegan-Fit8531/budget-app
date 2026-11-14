import { useEffect, useState } from 'react';
import { modeOf } from '../lib/balances';
import { cash, centsToInput, parseMoney } from '../lib/money';
import type { PaydayMode } from '../lib/types';
import { useBudget } from '../lib/store';

/** "Sent each payday": a fixed amount, or worked out from plans/goals each pay. */
export function PaydayControl({ accountId, autoLabel, autoHint, sends, needs }: {
  accountId: string; autoLabel: string; autoHint: string;
  /** What this pay sends (the Planner's figure) and what its costs come to. */
  sends: number; needs: number;
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
    <div className="stack gap-8">
      <label className="check-row">
        <input type="checkbox" checked={auto} onChange={(e) => set({ mode: e.target.checked ? 'exact' : 'fixed' })}
          style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
        <span>
          <b>{autoLabel}</b>
          <span className="small muted block">{autoHint}</span>
        </span>
      </label>
      {auto ? (
        <p className="small">This pay sends <b>{cash(sends)}</b>.{sends !== needs && <span className="muted"> Its costs come to {cash(needs)}; the amount was adjusted for this pay.</span>}</p>
      ) : (
        <label className="field" style={{ maxWidth: 260 }}>Sent each payday (NZD)
          <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)}
            onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
        </label>
      )}
      <RoundSetting accountId={accountId} />
    </div>
  );
}

/** An account's rounding: when balancing changes what payday sends, it lands on a round amount (e.g. $50). */
export function RoundSetting({ accountId }: { accountId: string }) {
  const { budget, update } = useBudget();
  const round = budget.accounts.find((a) => a.id === accountId)?.round ?? 0;
  function set(c: number) {
    update((b) => { const a = b.accounts.find((x) => x.id === accountId); if (a) a.round = c; return b; });
  }
  return (
    <div className="stack gap-4">
      <label className="field" style={{ maxWidth: 260 }}>Round when balancing changes it
        <select value={round} onChange={(e) => set(Number(e.target.value))}>
          <option value={0}>Off (exact cents)</option>
          {[500, 1000, 2000, 5000, 10000].map((c) => <option key={c} value={c}>To the nearest {cash(c)}</option>)}
        </select>
      </label>
      {round > 0 && (
        <p className="small muted">If a pay is short and this is trimmed, it still sends a round {cash(round)} amount; the few dollars over stay as leftover. A top-up rounds up.</p>
      )}
    </div>
  );
}
