import { useState } from 'react';
import { Section } from '../../ui/components';
import { fmtDay, todayISO } from '../../core/dates';
import { budgetPeriod } from '../../engine/periods';
import { downloadMonth, exportablePeriods, periodLabel } from './logic/export';
import { useBudget } from '../../state/store';

/** Download one pay (its summary, accounts and payments) as an Excel spreadsheet. */
export function ExportMonth() {
  const { budget } = useBudget();
  const today = todayISO();
  const periods = exportablePeriods(budget, today);
  const [start, setStart] = useState(() => budgetPeriod(budget, today).start);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // If the paydays change, the chosen pay may no longer exist: fall back to the pay you're in.
  const period = periods.find((p) => p.start === start) ?? periods.find((p) => p.end >= today) ?? periods[0];

  async function download() {
    setBusy(true); setMsg(null);
    try {
      await downloadMonth(budget, period);
      setMsg({ ok: true, text: `Downloaded ${periodLabel(period)}.` });
    } catch {
      setMsg({ ok: false, text: 'Couldn\u2019t make the spreadsheet. Check your connection and try again.' });
    } finally { setBusy(false); }
  }

  return (
    <Section title="Export a month" summary="Download one pay as a spreadsheet">
      <p className="small muted">Download one pay as a spreadsheet (.xlsx) that opens in Excel, Numbers or Google Sheets: a summary, what payday sends to each account, and every payment due.</p>
      <div className="form-grid bottom">
        <label className="field">Month
          <select value={period.start} onChange={(e) => { setStart(e.target.value); setMsg(null); }}>
            {periods.map((p) => (
              <option key={p.start} value={p.start}>{periodLabel(p)} ({fmtDay(p.start)} – {fmtDay(p.end)})</option>
            ))}
          </select>
        </label>
        <div className="row"><button className="btn primary" onClick={download} disabled={busy}>{busy ? 'Making spreadsheet\u2026' : 'Export to spreadsheet'}</button></div>
      </div>
      {period.end < today && <p className="small muted">A past month is worked out from your budget as it is now, so costs you've changed since show their current amounts.</p>}
      {msg && <p className={`small${msg.ok ? '' : ' error'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </Section>
  );
}
