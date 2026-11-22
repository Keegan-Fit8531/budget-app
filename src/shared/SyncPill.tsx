import { useBudget } from '../state/store';
import { fmtShort } from '../core/dates';
import { syncBank, useBankSyncing } from '../services/bank/BankCard';
import { Icon } from '../ui/Icon';
import { ago } from '../ui/components';

/**
 * Where a balance came from and how fresh it is: "Synced 2h ago" from the bank connection (tap it to
 * ask the bank again now), or "Updated today" when it was typed in. The dot is lit while it's current.
 * `canSync`: an entered balance that a bank sync can still change (a card whose payments are seen in
 * the bank, or that links itself once added in Akahu), so it's a sync button too.
 */
export function SyncPill({ source, at, canSync }: { source: 'bank' | 'entered' | 'none'; at?: string; canSync?: boolean }) {
  const { update } = useBudget();
  const syncing = useBankSyncing();
  if (source === 'none' || (!at && source !== 'bank')) return <span className="sync-pill stale">Not updated yet</span>;
  const days = at ? (Date.now() - Date.parse(at.length <= 10 ? `${at}T12:00:00` : at)) / 86400000 : Infinity;
  // Current, getting old, or old: the whole pill shows which.
  const state = days < 1.5 ? 'fresh' : days < 4 ? 'aging' : 'stale';
  const full = !at ? '' : at.length > 10 ? new Date(at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : fmtShort(at);
  if (source === 'entered' && !canSync) {
    return (
      <span className={`sync-pill ${state}`} title={`Balance you entered: ${full}`}>
        {ago(at!)}
      </span>
    );
  }
  return (
    <button type="button" className={`sync-pill ${syncing ? 'busy' : state}`} disabled={syncing}
      title={source === 'entered' ? `Balance you entered: ${full}. Tap to sync with your bank.` : `From your bank${full ? `, ${full}` : ''}. Tap to check again now.`}
      aria-label={syncing ? 'Syncing with your bank' : source === 'entered' ? `Updated ${ago(at!)}. Sync with your bank` : `From your bank ${at ? ago(at) : ''}. Sync again now`}
      onClick={(e) => { e.stopPropagation(); void syncBank(update, true); }}>
      <span className="sync-icon" aria-hidden="true"><Icon name="sync" size={13} stroke={2.2} /></span>
      {/* On a phone a current pill is just its icon: the card's name gets the room. */}
      <span className="sync-when">{syncing ? 'Syncing' : at ? ago(at) : 'Sync'}</span>
    </button>
  );
}
