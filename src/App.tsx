import { useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { AddMenu } from './components/AddMenu';
import { Accounts } from './pages/Accounts';
import { Insights } from './pages/Insights';
import { Planner } from './pages/Planner';
import { Settings } from './pages/Settings';
import { PeriodProvider } from './lib/period';
import { Debts } from './pages/Debts';
import { Deposits } from './pages/Deposits';
import { Savings } from './pages/Savings';
import { LogoMark } from './components/LogoMark';

function useHash(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => { setParts(read()); window.scrollTo(0, 0); };
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
  { id: 'deposits', label: 'Deposits', icon: 'transfer' },
  { id: 'insights', label: 'Insights', icon: 'pie' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export default function App() {
  const [page = 'planner', sub] = useHash();

  const content =
    page === 'accounts' ? <Accounts /> :
    page === 'deposits' ? <Deposits openId={sub} /> :
    page === 'insights' ? <Insights /> :
    page === 'settings' ? <Settings /> :
    page === 'debts' ? <Debts /> :
    page === 'savings' ? <Savings /> :
    <Planner />;

  return (
    <div className="app">
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
        {content}
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
