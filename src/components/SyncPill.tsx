import { useBudget } from '../lib/store';
import { fmtShort } from '../lib/dates';
import { syncBank, useBankSyncing } from './BankCard';
import { Icon } from './Icon';
import { ago } from './ui';

/**
 * Where a balance came from and how fresh it is: "Synced 2h ago" from the bank connection (tap it to
 * ask the bank again now), or "Updated today" when it was typed in. The dot is lit while it's current.
 */
export function SyncPill({ source, at }: { source: 'bank' | 'entered' | 'none'; at?: string }) {
  const { update } = useBudget();
  const syncing = useBankSyncing();
  if (source === 'none' || (!at && source !== 'bank')) return <span className="sync-pill"><span className="sync-dot" aria-hidden="true" />Not tracked</span>;
  const days = at ? (Date.now() - Date.parse(at.length <= 10 ? `${at}T12:00:00` : at)) / 86400000 : Infinity;
  const fresh = source === 'bank' ? days < 1.5 : days < 1;
  const full = !at ? '' : at.length > 10 ? new Date(at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : fmtShort(at);
  if (source === 'entered') {
    return (
      <span className={`sync-pill${fresh ? ' fresh' : ''}`} title={`Balance last entered: ${full}`}>
        <span className="sync-dot" aria-hidden="true" />Updated {ago(at!)}
      </span>
    );
  }
  return (
    <button type="button" className={`sync-pill bank${fresh ? ' fresh' : ''}${syncing ? ' busy' : ''}`} disabled={syncing}
      title={`Last synced from your bank${full ? `: ${full}` : ''}. Tap to check again now.`} aria-label={syncing ? 'Syncing with your bank' : `Synced ${at ? ago(at) : ''}. Sync again now`}
      onClick={(e) => { e.stopPropagation(); void syncBank(update, true); }}>
      <span className="sync-dot" aria-hidden="true" />
      <span>{syncing ? 'Syncing…' : `Synced ${at ? ago(at) : ''}`}</span>
      <span className="sync-icon" aria-hidden="true"><Icon name="sync" size={13} stroke={2.2} /></span>
    </button>
  );
}
