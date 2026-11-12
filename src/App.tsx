import { useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { ItemModal } from './components/ItemModal';
import { Accounts } from './pages/Accounts';
import { Insights } from './pages/Insights';
import { Planner } from './pages/Planner';
import { Settings } from './pages/Settings';
import { PeriodProvider } from './lib/period';
import { Debts } from './pages/Debts';
import { Deposits } from './pages/Deposits';
import { Savings } from './pages/Savings';

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

const NAV = [
  { id: 'planner', label: 'Planner', icon: 'home' },
  { id: 'accounts', label: 'Accounts', icon: 'wallet' },
  { id: 'deposits', label: 'Deposits', icon: 'transfer' },
  { id: 'debts', label: 'Debts', icon: 'card' },
  { id: 'savings', label: 'Savings', icon: 'target' },
  { id: 'insights', label: 'Insights', icon: 'pie' },
];
const byId = (id: string) => NAV.find((n) => n.id === id)!;
const MOBILE_LEFT = ['planner', 'accounts'].map(byId);
const MOBILE_RIGHT = ['debts', 'savings'].map(byId);

export default function App() {
  const [page = 'planner', sub] = useHash();
  const [adding, setAdding] = useState(false);

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
        <div className="logo"><span className="logo-mark">$</span>Paydays</div>
        {NAV.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={`nav-link ${page === n.id ? 'active' : ''}`} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} />{n.label}
          </a>
        ))}
        <div className="nav-sep" />
        <a href="#/settings" className={`nav-link ${page === 'settings' ? 'active' : ''}`}><Icon name="settings" />Settings</a>
        <button className="btn side-add" onClick={() => setAdding(true)}><Icon name="plus" /> Add a cost</button>
      </nav>

      <PeriodProvider>
      <main className="main">
        <div className="mobile-top">
          <span className="logo-mark" aria-hidden="true">$</span>
          <span style={{ flex: 1, fontWeight: 700 }}>Paydays</span>
          <a href="#/deposits" className="icon-btn" aria-label="Deposits and transfers"><Icon name="transfer" /></a>
          <a href="#/insights" className="icon-btn" aria-label="Insights"><Icon name="pie" /></a>
          <a href="#/settings" className="icon-btn" aria-label="Settings"><Icon name="settings" /></a>
        </div>
        {content}
      </main>
      </PeriodProvider>

      <nav className="bottom-nav" aria-label="Main">
        {MOBILE_LEFT.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} size={22} />{n.label}
          </a>
        ))}
        <button className="fab" aria-label="Add a cost" onClick={() => setAdding(true)}><Icon name="plus" size={26} stroke={2.4} /></button>
        {MOBILE_RIGHT.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} size={22} />{n.label}
          </a>
        ))}
      </nav>

      {adding && <ItemModal onClose={() => setAdding(false)} />}
    </div>
  );
}
