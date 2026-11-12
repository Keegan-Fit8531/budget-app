import { cash } from '../lib/money';
import type { Cents } from '../lib/types';
import { Icon } from './Icon';

export interface BalanceAdjustment { id: string; name: string; color: string; from: Cents; to: Cents; reason?: string }

interface Props {
  /** This pay is looked after by automatic balancing. */
  auto: boolean;
  /** Automatic balancing is turned on (for the next 12 pays). */
  autoOn: boolean;
  onToggleAuto: (on: boolean) => void;
  leftover: Cents;
  payAccountName: string;
  needsBalance: boolean;
  shortAccounts: { accountId: string; name: string; short: Cents }[];
  adjustments: BalanceAdjustment[];
  modeChanges: { accountId: string; name: string; was: string; to: 'smooth' | 'exact' }[];
  notSpare: { accountId: string; name: string; reason: string }[];
  canReset: boolean;
  onBalance: () => void;
  onReset: () => void;
  passedNote?: string;
  optimise?: { label?: string; onUndo?: () => void; onOpen?: () => void };
  debt: { ratio: number; paid: Cents; guide: number };
}

/** Whether this pay is balanced, what was adjusted and why, and the debt share of pay. */
export function BalanceBox(p: Props) {
  const n = p.adjustments.length;
  const short = p.leftover < 0;
  const spending = `${cash(p.leftover)} left for spending`;
  const status: { tone: 'good' | 'bad' | 'warn'; title: string; sub: string } = p.auto
    ? short
      ? { tone: 'bad', title: `Still ${cash(-p.leftover)} short`, sub: 'Every safe trim has been made. The rest needs a bigger change, like lower rent or bills.' }
      : { tone: 'good', title: 'Balanced automatically', sub: n ? `${n} amount${n === 1 ? '' : 's'} adjusted for this pay · ${spending}` : `Nothing needed adjusting · ${spending}` }
    : !p.autoOn
      ? p.needsBalance
        ? { tone: 'warn', title: 'Using your normal amounts', sub: `${short ? `${cash(-p.leftover)} short overall` : p.shortAccounts.length ? p.shortAccounts.map((x) => `${x.name} needs ${cash(x.short)} more`).join(' and ') : spending}. Switch to Auto to balance it.` }
        : { tone: 'good', title: 'Using your normal amounts', sub: `Nothing needs adjusting · ${spending}` }
    : !p.needsBalance
      ? { tone: 'good', title: 'Balanced', sub: n ? `${n} amount${n === 1 ? '' : 's'} adjusted for this pay · ${spending}` : `Nothing to adjust · ${spending}` }
      : {
        tone: 'warn', title: n ? 'Needs re-balancing' : 'Not balanced yet',
        sub: short ? `${cash(-p.leftover)} short overall`
          : p.shortAccounts.length ? `${p.shortAccounts.map((x) => `${x.name} needs ${cash(x.short)} more`).join(' and ')}`
          : 'A little can go aside for the next 5-week pay',
      };
  const manual = !p.auto;
  const guidePct = Math.round(p.debt.guide * 100);
  const pct = Math.round(p.debt.ratio * 100);
  const scale = p.debt.guide * 2; // the bar runs to twice the guideline

  return (
    <div className="balance-box">
      <div className="seg balance-mode" role="group" aria-label="Payday amounts">
        <button aria-pressed={p.autoOn} onClick={() => p.onToggleAuto(true)} title="Balance the next 12 pays automatically whenever something changes">Auto-balance</button>
        <button aria-pressed={!p.autoOn} onClick={() => p.onToggleAuto(false)} title="Your normal payday amounts, nothing adjusted">Defaults</button>
      </div>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
        <span className={`status-icon ${status.tone}`} aria-hidden="true"><Icon name={status.tone === 'good' ? 'check' : 'alert'} size={18} /></span>
        <span style={{ minWidth: 0 }}>
          <b style={{ display: 'block', fontSize: 15 }}>{status.title}</b>
          <span className="small muted">{status.sub}</span>
        </span>
      </div>

      {manual && p.autoOn && (p.needsBalance || (p.canReset && n > 0)) && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {p.needsBalance && <button className="btn small primary" onClick={p.onBalance}>{n ? 'Re-balance' : 'Balance this pay'}</button>}
          {p.canReset && <button className="btn small" onClick={p.onReset}>Reset to defaults</button>}
        </div>
      )}
      {manual && p.autoOn && <p className="small muted" style={{ margin: 0 }}>This pay is already split (or more than 12 pays away), so it isn't balanced automatically.</p>}

      {(n > 0 || p.modeChanges.length > 0) && (
        <details className="changes">
          <summary>See what changed ({n + p.modeChanges.length})</summary>
          <div className="change-list">
            {p.adjustments.map((a) => {
              const d = a.to - a.from;
              return (
                <div key={a.id} className="change-row">
                  <span className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="dot" style={{ background: a.color }} />
                    <b style={{ minWidth: 0 }}>{a.name}</b>
                  </span>
                  <span className="num">{cash(a.from, { whole: true })} → <b>{cash(a.to, { whole: true })}</b></span>
                  <span className={`pill ${d > 0 ? 'good' : ''}`} style={{ background: d > 0 ? 'var(--good-bg)' : 'var(--card)' }}>
                    {d > 0 ? '+' : '−'}{cash(Math.abs(d), { whole: true })}
                  </span>
                  {a.reason && <span className="small muted" style={{ gridColumn: '1 / -1', paddingLeft: 18 }}>{a.reason}</span>}
                </div>
              );
            })}
            {p.modeChanges.map((t) => (
              <p key={t.accountId} className="small" style={{ margin: 0 }}>
                <b>{t.name}</b> is now {t.to === 'smooth' ? 'Steady (about the same every pay)' : 'Exact (bills less what’s left over)'}, was {t.was}.
              </p>
            ))}
            {p.notSpare.length > 0 && (
              <details className="small">
                <summary>Why some accounts weren't used</summary>
                {p.notSpare.map((x) => <p key={x.accountId} className="muted" style={{ margin: '4px 0 0' }}><b style={{ color: 'var(--ink)' }}>{x.name}:</b> {x.reason}</p>)}
              </details>
            )}
            <p className="small muted" style={{ margin: 0 }}>For this pay only: your normal amounts stay the same for other pays.{p.auto ? ' Choose Defaults to put them back.' : ''}</p>
          </div>
        </details>
      )}

      {p.passedNote && <p className="small" style={{ margin: 0 }}>{p.passedNote}</p>}

      {p.optimise && (
        <div className="between" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span className="small">{p.optimise.label ?? <><b>{cash(p.leftover)} left over.</b> <span className="muted">Choose where it goes.</span></>}</span>
          <span className="row" style={{ gap: 8 }}>
            {p.optimise.onUndo && <button className="btn small" onClick={p.optimise.onUndo}>Undo</button>}
            {p.optimise.onOpen && <button className="btn small primary" onClick={p.optimise.onOpen}><Icon name="bulb" size={16} /> Optimise</button>}
          </span>
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <div className="between small" style={{ flexWrap: 'nowrap' }}>
          <span>Debt repayments</span>
          <span><b>{pct}%</b> of pay · {cash(p.debt.paid, { whole: true })}</span>
        </div>
        <div className="bar" role="img" aria-label={`Debt repayments ${pct}% of pay, guideline under ${guidePct}%`} style={{ height: 8, background: 'var(--card)' }}>
          <div style={{ height: 8, width: `${Math.min(100, (p.debt.ratio / scale) * 100)}%`, background: p.debt.ratio > p.debt.guide ? 'var(--bad)' : 'var(--good)' }} />
          <div className="target" style={{ left: '50%', top: -3, height: 14 }} />
        </div>
        <p className={`small ${p.debt.ratio > p.debt.guide ? 'neg' : 'muted'}`} style={{ margin: '6px 0 0' }}>
          {p.debt.ratio > p.debt.guide ? `Above the guideline of ${guidePct}%` : `Under the ${guidePct}% guideline`}
        </p>
      </div>
    </div>
  );
}
