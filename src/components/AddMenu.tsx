import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { nextColor } from '../lib/colors';
import { fmtDay, fmtShort, monthName, todayISO } from '../lib/dates';
import { owed } from '../lib/debts';
import { matchDebt, readDocument, recordPayslip, recordStatement, type ReadDocument } from '../lib/documents';
import { centsToInput, money, parseMoney } from '../lib/money';
import { newId, useBudget } from '../lib/store';
import { DebtModal } from '../pages/Debts';
import { GoalModal } from '../pages/Savings';
import { Icon } from './Icon';
import { ItemModal } from './ItemModal';

type Adding = 'menu' | 'cost' | 'goal' | 'debt';

/**
 * The one "add" button: a cost, a savings goal, a debt, or a document (a payslip, or a card or loan
 * statement, as a PDF or a photo) that's read and filled in for you to check.
 */
export function AddMenu({ render }: { render: (open: () => void) => React.ReactNode }) {
  const [adding, setAdding] = useState<Adding | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const close = () => setAdding(null);
  const choices: { id: string; icon: string; title: string; hint: string; go: () => void }[] = [
    { id: 'doc', icon: 'upload', title: 'Upload a payslip or statement', hint: 'PDF or photo. It’s read on this device and filled in for you to check.', go: () => fileRef.current?.click() },
    { id: 'cost', icon: 'transfer', title: 'Cost', hint: 'A bill, rent or regular transfer that comes out of an account.', go: () => setAdding('cost') },
    { id: 'goal', icon: 'piggy', title: 'Savings goal', hint: 'Something to save towards, with a target and a date.', go: () => setAdding('goal') },
    { id: 'debt', icon: 'card', title: 'Debt', hint: 'A card, Afterpay, a loan or someone you owe.', go: () => setAdding('debt') },
  ];
  return (
    <>
      {render(() => setAdding('menu'))}
      <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); close(); } e.target.value = ''; }} />
      {/* On the page itself, not inside the sidebar or bottom bar the button sits in. */}
      {createPortal(<>
      {adding === 'menu' && (
        <div className="modal-back" onClick={close}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="between">
              <h2 id="add-title" className="h2">Add</h2>
              <button className="icon-btn" aria-label="Close" onClick={close}><Icon name="x" /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {choices.map((c) => (
                <button key={c.id} className="add-choice" onClick={c.go}>
                  <span className="add-choice-icon"><Icon name={c.icon} size={20} /></span>
                  <span style={{ minWidth: 0 }}>
                    <b>{c.title}</b>
                    <span className="small muted" style={{ display: 'block' }}>{c.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {adding === 'cost' && <ItemModal onClose={close} />}
      {adding === 'goal' && <GoalModal onClose={close} />}
      {adding === 'debt' && <DebtModal onClose={close} onDelete={close} />}
      {file && <DocumentModal file={file} onClose={() => setFile(null)} />}
      </>, document.body)}
    </>
  );
}

const NEW_DEBT = '__new';

/** Reads a payslip or statement, shows what it found, and saves it once you've checked it. */
function DocumentModal({ file, onClose }: { file: File; onClose: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const debts = (budget.debts ?? []).filter((d) => !d.payroll);
  const [doc, setDoc] = useState<ReadDocument | null>(null);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<'payslip' | 'statement'>('statement');
  const [done, setDone] = useState('');
  const [err, setErr] = useState('');
  // Payslip
  const [payDay, setPayDay] = useState(today);
  const [net, setNet] = useState('');
  // Statement
  const [debtId, setDebtId] = useState(debts[0]?.id ?? NEW_DEBT);
  const [newName, setNewName] = useState('');
  const [balance, setBalance] = useState('');
  const [asAt, setAsAt] = useState(today);
  const [limit, setLimit] = useState('');

  useEffect(() => {
    let live = true;
    readDocument(file, (p) => live && setProgress(p)).then((d) => {
      if (!live) return;
      setDoc(d); setKind(d.kind);
      if (d.kind === 'payslip') { setPayDay(d.payslip.payDay); setNet(centsToInput(d.payslip.net)); }
      else {
        const s = d.statement;
        if (s.balance !== undefined) setBalance(centsToInput(s.balance));
        if (s.date && s.date <= today) setAsAt(s.date);
        if (s.limit !== undefined) setLimit(centsToInput(s.limit));
        const match = matchDebt(debts, d.text);
        if (match) setDebtId(match.id);
      }
    }).catch(() => live && setFailed(true));
    return () => { live = false; };
    // Read once, for the file this pop-up was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const slip = doc?.kind === 'payslip' ? doc.payslip : undefined;
  const st = doc?.kind === 'statement' ? doc.statement : undefined;
  const debt = debts.find((d) => d.id === debtId);

  function save() {
    if (kind === 'payslip') {
      const c = parseMoney(net);
      if (c === null || c <= 0) return setErr('Enter the pay that reached your account.');
      if (!payDay) return setErr('Pick the pay day.');
      const after = structuredClone(budget);
      const { start, loan } = recordPayslip(after, { ...slip, payDay, net: c });
      update((b) => { recordPayslip(b, { ...slip, payDay, net: c }); return b; });
      return setDone(`${monthName(start)} pay recorded: ${money(c)}, paid ${fmtDay(payDay)}.${loan && slip?.studentLoan ? ` Student loan: ${money(slip.studentLoan)} taken off what you owe.` : ''}`);
    }
    const c = parseMoney(balance);
    if (c === null || c < 0) return setErr('Enter what’s owed, like 1,240.50');
    const lim = limit.trim() === '' ? undefined : parseMoney(limit);
    if (lim === null) return setErr('Check the credit limit.');
    if (debtId === NEW_DEBT && !newName.trim()) return setErr('Give the new debt a name.');
    if (!asAt) return setErr('Pick the date the balance is as at.');
    const name = debt?.name ?? newName.trim();
    update((b) => {
      let id = debtId;
      if (id === NEW_DEBT) {
        // A debt that isn't set up yet: add it, paid from the payday split like any other.
        id = newId();
        b.debts = b.debts ?? [];
        const groupId = b.groups.find((g) => g.id === 'debt')?.id ?? b.groups.find((g) => g.bucket === 'savings')?.id ?? b.groups[0]?.id ?? '';
        b.accounts.push({ id, name, kind: 'external', color: nextColor(b.accounts.map((x) => x.color)), groupId });
        b.split.push({ accountId: id, amount: 0, mode: 'exact' });
        b.debts.push({ id, name, kind: 'card', accountId: id, plans: [] });
      }
      recordStatement(b, id, { balance: c, date: asAt, limit: lim }, today);
      return b;
    });
    setDone(`${name}: ${money(c)} owed as at ${fmtShort(asAt)}${debt ? ` (was ${money(owed(debt))})` : ''}.`);
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="doc-title" onClick={(e) => e.stopPropagation()}>
        <div className="between" style={{ flexWrap: 'nowrap' }}>
          <div style={{ minWidth: 0 }}>
            <h2 id="doc-title" className="h2">{done ? 'Saved' : !doc && !failed ? 'Reading…' : kind === 'payslip' ? 'Check this payslip' : 'Check this statement'}</h2>
            <span className="small muted" style={{ overflowWrap: 'anywhere' }}>{file.name}</span>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>

        {done ? (
          <>
            <p role="status">{done}</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <a className="btn" href={kind === 'payslip' ? '#/planner' : '#/debts'} onClick={onClose} style={{ textDecoration: 'none', color: 'inherit' }}>{kind === 'payslip' ? 'Open Planner' : 'Open Debts'}</a>
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : !doc && !failed ? (
          <div role="status">
            <p className="small muted">{file.type.startsWith('image/') ? 'Reading the text in the photo on this device. This can take a little while the first time.' : 'Reading the PDF on this device.'}</p>
            <div className="bar" style={{ height: 8, marginTop: 8 }}><div style={{ height: 8, width: `${Math.max(6, Math.round(progress * 100))}%`, background: 'var(--brand)' }} /></div>
          </div>
        ) : (
          <>
            {failed && <p className="small error" role="alert">That file couldn't be read. You can still type the details in below.</p>}
            {!failed && kind === 'statement' && st?.balance === undefined && doc?.kind === 'statement' && (
              <p className="small error" role="alert">Couldn't find a balance in it. Type in what's owed, or try a clearer photo or the PDF.</p>
            )}
            <div className="seg" role="group" aria-label="What this is" style={{ alignSelf: 'flex-start' }}>
              <button aria-pressed={kind === 'statement'} onClick={() => { setKind('statement'); setErr(''); }}>Card or loan statement</button>
              <button aria-pressed={kind === 'payslip'} onClick={() => { setKind('payslip'); setErr(''); }}>Payslip</button>
            </div>

            {kind === 'payslip' ? (
              <>
                <div className="form-grid">
                  <label className="field">Pay that reached you (net)
                    <input inputMode="decimal" value={net} placeholder="4,000.00" onChange={(e) => { setNet(e.target.value); setErr(''); }} />
                  </label>
                  <label className="field">Pay day
                    <input type="date" value={payDay} onChange={(e) => { setPayDay(e.target.value); setErr(''); }} />
                  </label>
                </div>
                {slip && (slip.paye !== undefined || slip.studentLoan !== undefined || slip.kiwisaver !== undefined) && (
                  <p className="small muted">
                    Also read: {[slip.paye !== undefined ? `PAYE ${money(slip.paye)}` : '', slip.studentLoan !== undefined ? `student loan ${money(slip.studentLoan)}` : '', slip.kiwisaver !== undefined ? `KiwiSaver ${money(slip.kiwisaver)}` : ''].filter(Boolean).join(' · ')}.
                  </p>
                )}
              </>
            ) : (
              <>
                <label className="field">Which debt it's for
                  <select value={debtId} onChange={(e) => { setDebtId(e.target.value); setErr(''); }}>
                    {debts.map((d) => <option key={d.id} value={d.id}>{d.name} (now {money(owed(d))})</option>)}
                    <option value={NEW_DEBT}>+ A new debt…</option>
                  </select>
                </label>
                {debtId === NEW_DEBT && (
                  <label className="field">Name of the new debt
                    <input value={newName} placeholder="Gem Visa" onChange={(e) => { setNewName(e.target.value); setErr(''); }} />
                  </label>
                )}
                <div className="form-grid">
                  <label className="field">Owed
                    <input inputMode="decimal" value={balance} placeholder="1,240.50" onChange={(e) => { setBalance(e.target.value); setErr(''); }} />
                  </label>
                  <label className="field">As at
                    <input type="date" value={asAt} max={today} onChange={(e) => { setAsAt(e.target.value); setErr(''); }} />
                  </label>
                  <label className="field">Credit limit (optional)
                    <input inputMode="decimal" value={limit} placeholder={debt?.limit ? centsToInput(debt.limit) : ''} onChange={(e) => { setLimit(e.target.value); setErr(''); }} />
                  </label>
                </div>
                <p className="small muted">
                  {st?.minimum !== undefined ? `The statement's minimum payment is ${money(st.minimum)}. ` : ''}
                  This sets what's owed as at that date; payments planned since then are counted as paid. Purchases and plans stay as they are.
                </p>
              </>
            )}
            {err && <p className="error" role="alert">{err}</p>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={save}>{kind === 'payslip' ? 'Record pay' : 'Update what’s owed'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
