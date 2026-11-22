import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';
import { AddMenu } from './AddMenu';
import { AccountsPage } from '../features/accounts/AccountsPage';
import { InsightsPage } from '../features/insights/InsightsPage';
import { PlannerPage } from '../features/planner/PlannerPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { PeriodProvider } from '../state/period';
import { DebtsPage } from '../features/debts/DebtsPage';
import { SavingsPage } from '../features/savings/SavingsPage';
import { LogoMark } from '../ui/LogoMark';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { BankAutoSync } from '../services/bank/BankCard';
import { ReviewAutoRun, ShopSortAutoRun } from '../features/insights/MonthlyInsights';

function useHash(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    // A new page starts at the top; a pop-up opening on the same page (Deposits) leaves it where it is.
    let page = read()[0];
    const on = () => {
      const next = read();
      if (next[0] !== page && !(next[0] === 'deposits' && page === 'accounts')) window.scrollTo(0, 0);
      page = next[0] === 'deposits' ? 'accounts' : next[0];
      setParts(next);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

// The same two groups on a computer and a phone: the pages you use day to day (the sidebar's first group,
// the phone's bottom bar), then the ones for setting things up (after the line, the phone's top bar).
const MAIN = [
  { id: 'planner', label: 'Planner', icon: 'home' },
  { id: 'accounts', label: 'Accounts', icon: 'wallet' },
  { id: 'debts', label: 'Debts', icon: 'card' },
  { id: 'savings', label: 'Savings', icon: 'piggy' },
];
const SETUP = [
  { id: 'insights', label: 'Insights', icon: 'pie' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export default function App() {
  const [rawPage = 'planner', ...rest] = useHash();
  // Deposits is a pop-up on Accounts now: #/accounts/deposits/<account>, and older #/deposits links too.
  const page = rawPage === 'deposits' ? 'accounts' : rawPage;
  const deposits = rawPage === 'deposits' ? (rest[0] ?? '') : rest[0] === 'deposits' ? (rest[1] ?? '') : undefined;

  const content =
    page === 'accounts' ? <AccountsPage deposits={deposits} /> :
    page === 'insights' ? <InsightsPage /> :
    page === 'settings' ? <SettingsPage /> :
    page === 'debts' ? <DebtsPage /> :
    page === 'savings' ? <SavingsPage /> :
    <PlannerPage />;

  return (
    <div className="app">
      <BankAutoSync />
      <ReviewAutoRun />
      <ShopSortAutoRun />
      <nav className="sidebar" aria-label="Main">
        <div className="logo"><LogoMark size={36} />Paydays</div>
        {MAIN.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={`nav-link ${page === n.id ? 'active' : ''}`} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} />{n.label}
          </a>
        ))}
        <div className="nav-sep" />
        {SETUP.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={`nav-link ${page === n.id ? 'active' : ''}`} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} />{n.label}
          </a>
        ))}
        <AddMenu render={(open) => <button className="btn side-add" onClick={open}><Icon name="plus" /> Add</button>} />
      </nav>

      <PeriodProvider>
      <main className="main">
        <div className="mobile-top">
          <LogoMark size={28} />
          <span style={{ flex: 1, fontWeight: 700 }}>Paydays</span>
          {SETUP.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={`icon-btn ${page === n.id ? 'active' : ''}`} aria-label={n.label} aria-current={page === n.id ? 'page' : undefined}><Icon name={n.icon} /></a>
          ))}
        </div>
        {/* Keyed by page: going to another page clears a page that couldn't be shown. */}
        <ErrorBoundary key={page}>{content}</ErrorBoundary>
      </main>
      </PeriodProvider>

      <nav className="bottom-nav" aria-label="Main">
        {MAIN.slice(0, 2).map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} size={22} />{n.label}
          </a>
        ))}
        <AddMenu render={(open) => <button className="fab" aria-label="Add" onClick={open}><Icon name="plus" size={26} stroke={2.4} /></button>} />
        {MAIN.slice(2).map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} size={22} />{n.label}
          </a>
        ))}
      </nav>

    </div>
  );
}
