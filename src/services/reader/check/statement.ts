import { addDays, addMonths, fmtShort, type ISODate } from '../../../core/dates';
import { gemPlanEnds, gemPlanType, planEnds } from '../../../features/debts/logic/gem';
import { owed } from '../../../features/debts/logic/amounts';
import { cash } from '../../../core/money';
import type { Budget, Cents, DebtPlan } from '../../../core/types';
import { NEW_DEBT, type Draft, type PlanUpdate, type OrderUpdate, type Issue, type Review } from './draft';
import { toCents, validDate, isStudentLoan, afterpayDebt, ordersOnly, keepsPlans } from './figures';
import { resolvePlanRow, resolveOrder, purchaseRows } from './review';

export function reviewStatement(d: Draft, b: Budget, today: ISODate): Review {
  const issues: Issue[] = [];
  const ignored: string[] = [];
  const block = (text: string) => issues.push({ level: 'block', text });
  const note = (text: string) => issues.push({ level: 'note', text });
  const s = d.statement;
  const isNew = s.debtId === NEW_DEBT;
  const debt = isNew ? undefined : (b.debts ?? []).find((x) => x.id === s.debtId);

  if (isNew) { if (!s.newName.trim()) block('Give the new debt a name.'); }
  else if (!debt) block(s.nameOnDocument ? `Choose which debt this statement is for (it says “${s.nameOnDocument}”).` : 'Choose which debt this statement is for.');
  else if (debt.payroll && !isStudentLoan(debt)) block(`${debt.name} comes out of your pay, so it isn’t updated from a statement. Choose the card or loan this is for.`);
  else if (debt.payroll) note(`IRD can take a few weeks to count what your employer deducts, so a deduction from a recent payslip may not be in IRD’s balance yet. Upload the loan balance again now and then to keep ${debt.name} matching IRD.`);
  else if (ordersOnly(debt)) block(`${debt.name} is worked out from its orders, not a balance. Upload a screenshot of your Afterpay orders instead.`);

  let bal = toCents(s.balance.value);
  if (bal === undefined) {
    // Some app screens show only what's available: what's owed is the limit less that.
    const av = toCents(s.available.value);
    const lim = toCents(s.limit.value)?.cents ?? debt?.limit;
    if (av && !av.credit && lim && av.cents <= lim) {
      bal = { cents: lim - av.cents, credit: false };
      note(`Only what’s available (${cash(av.cents)}) is shown, so what’s owed is the ${cash(lim)} limit less that: ${cash(lim - av.cents)}.`);
    }
  }
  if (bal === undefined) block(debt && isStudentLoan(debt) ? 'The loan balance wasn’t found on this screenshot. Type in the “Total loan balance” from myIR’s Loan breakdown.' : 'Enter what’s owed.');
  else if (bal === null) block('Check what’s owed: it should look like 1,240.50.');
  const credit = !!bal && (bal.credit || s.inCredit);
  const balance = bal ? (credit ? 0 : bal.cents) : undefined;
  if (credit) note('The statement is in credit, so nothing is owed.');

  const date = validDate(s.date);
  if (!date) block(s.date.trim() ? `Check the date (${s.date}).` : 'Enter the date what’s owed is as at.');
  else if (date > today) note(`The statement is dated ${fmtShort(date)}, after today, so it’s treated as today.`);
  else if (date < addDays(today, -400)) block(`The statement date, ${fmtShort(date)}, is over a year ago. Check it.`);

  const lim = toCents(s.limit.value);
  if (lim === null) block('Check the credit limit.');
  const limit = lim && lim.cents > 0 ? lim.cents : undefined;

  const plans: PlanUpdate[] = [];
  const newPlans: DebtPlan[] = [];
  if (debt && !ordersOnly(debt) && balance !== undefined) {
    const max = limit ?? debt.limit;
    if (max && balance > max) note(`What’s owed (${cash(balance)}) is more than the credit limit (${cash(max)}). Check the figures.`);
    const now = owed(debt);
    if (Math.abs(balance - now) > 100000 || (now > 0 && Math.abs(balance - now) > now * 0.5)) {
      note(`That’s a big change from the ${cash(now)} ${debt.name} shows now. Check it’s the right figure and the right debt.`);
    }
  }
  if (debt && keepsPlans(debt)) {
    const used = new Map<string, string>();
    let unmatched = 0;
    for (const row of s.plans) {
      const rem = toCents(row.remaining.value);
      const what = row.description || (validDate(row.ends) ? `Plan ending ${fmtShort(row.ends)}` : 'A plan');
      if (!rem) { block(`Check the amount left on “${what}”.`); continue; }
      const plan = resolvePlanRow(row, debt);
      if (plan) {
        if (used.has(plan.id)) { block(`Two plans on the statement matched ${plan.name}. Check them.`); continue; }
        used.set(plan.id, what);
        const asOfRow = date && date <= today ? date : today;
        const ends = validDate(row.ends) ?? (row.monthsLeft ? gemPlanEnds(asOfRow, row.monthsLeft) : undefined);
        const months = row.months && row.months > 0 ? row.months : undefined;
        const nextType = row.type ?? (months && debt.rules === 'gem' ? gemPlanType(months) : undefined);
        const type = nextType === 'interest-free' || nextType === 'equal' ? nextType : undefined;
        const update: PlanUpdate = { planId: plan.id, remaining: rem.credit ? 0 : rem.cents };
        if (ends && ends !== planEnds(plan)) update.ends = ends;
        if (months && months !== plan.months) update.months = months;
        if (type && type !== plan.type) update.type = type;
        plans.push(update);
      } else if (row.addAsNew) {
        const asOf = date && date <= today ? date : today;
        const ends = validDate(row.ends) ?? (row.monthsLeft ? gemPlanEnds(asOf, row.monthsLeft) : undefined);
        if (!ends) { block(`Enter when “${what}” stops being interest-free, or how many months are left, to add it as a new plan.`); continue; }
        const months = row.months && row.months > 0 ? row.months : row.monthsLeft && row.monthsLeft > 0 ? row.monthsLeft : undefined;
        const type = row.type ?? (months && debt.rules === 'gem' ? gemPlanType(months) : 'interest-free');
        newPlans.push({
          id: row.newId, name: row.description || `Interest-free until ${fmtShort(ends)}`, type,
          original: rem.cents, remaining: rem.cents, asOf, purchaseDate: asOf, ends,
          ...(months ? { months } : {}),
          ...(type === 'equal' && months ? { payment: Math.round(rem.cents / Math.max(1, row.monthsLeft ?? months)) } : {}),
        });
      } else {
        unmatched++;
        ignored.push(`${what}: ${cash(rem.cents)}${validDate(row.ends) ? `, ends ${fmtShort(row.ends)}` : ''}. It didn’t match one of your plans (tick it to add it as a new one).`);
      }
    }
    if (unmatched) note(`${unmatched === 1 ? 'A plan' : `${unmatched} plans`} on the statement didn’t match one of yours. See “Not changed”.`);
    if (s.plans.length) for (const p of debt.plans) if (!used.has(p.id)) ignored.push(`${p.name}: not on this statement, left as it is.`);
    if (debt.rules === 'gem' && debt.plans.length && !plans.length && !s.appScreen) {
      note('None of the Gem plans were updated, so the difference between the balance and the plans counts as “other purchases”, which are paid first. That changes the recommended payment.');
    }
    const planTotal = [...plans, ...newPlans].reduce((t, x) => t + x.remaining, 0);
    if (balance !== undefined && planTotal > balance + 100) note('The plans add up to more than what’s owed. Check them.');
  } else if (s.plans.length) {
    ignored.push(`${s.plans.length === 1 ? 'A plan' : `${s.plans.length} plans`} listed on the statement: the balance already covers ${s.plans.length === 1 ? 'it' : 'them'}.`);
  }
  const rows = purchaseRows(d, debt);
  const asOf = date && date <= today ? date : today;
  for (const row of rows) {
    const what = `${row.description || 'Purchase'} ${cash(row.cents)} on ${fmtShort(row.date)}`;
    if (!row.months) continue;
    if (row.existing) { ignored.push(`${what}: already your plan “${row.existing.name}”.`); continue; }
    if (!row.add) { ignored.push(`${what}: not added as a plan (tick it to add it).`); continue; }
    // Gem months end on the 20th; other cards keep calendar months from the purchase date.
    const ends = debt?.rules === 'gem' ? gemPlanEnds(row.date, row.months) : addMonths(row.date, row.months);
    newPlans.push({ id: s.purchases[row.index].newId, name: row.description || `Purchase on ${fmtShort(row.date)}`, type: 'interest-free', months: row.months, original: row.cents, remaining: row.cents, asOf, purchaseDate: row.date, ends });
  }
  const added = newPlans.filter((x) => s.purchases.some((y) => y.newId === x.id));
  if (debt && added.length && balance !== undefined) {
    const planned = debt.plans.reduce((t, x) => t + (plans.find((u) => u.planId === x.id)?.remaining ?? x.remaining), 0) + added.reduce((t, x) => t + x.remaining, 0);
    if (planned > balance + 100) note(`With ${added.length === 1 ? 'that new plan' : 'those new plans'}, your plans add up to ${cash(planned)}, more than the ${cash(balance)} owed. Some may be paid off or already plans: check them.`);
  }
  const others = s.purchases.length - rows.filter((r) => r.months).length;
  if (others > 0) ignored.push(`${others === 1 ? 'A purchase' : `${others} purchases`} on the ${s.appScreen ? 'screenshot' : 'statement'}: already in what’s owed.`);
  for (const x of s.payments) ignored.push(`Payment${x.amount ? ` of ${cash(toCents(x.amount)?.cents ?? 0)}` : ''}${validDate(x.date) ? ` on ${fmtShort(x.date)}` : ''}: payments are counted automatically on their due dates.`);
  if (d.source === 'device' && debt) note(`Read on this device, which guesses the debt from words in the statement: check it’s ${debt.name}.`);

  if (issues.some((i) => i.level === 'block') || balance === undefined || !date) return { proposal: null, issues, ignored };
  return {
    proposal: {
      kind: 'statement', debtId: isNew ? s.newDebtId : s.debtId, ...(isNew ? { newDebt: { name: s.newName.trim() } } : {}),
      balance, inCredit: credit, date, ...(limit ? { limit } : {}), plans, newPlans,
    },
    issues, ignored,
  };
}

export function reviewAfterpay(d: Draft, b: Budget, today: ISODate): Review {
  const issues: Issue[] = [];
  const ignored: string[] = [];
  const block = (text: string) => issues.push({ level: 'block', text });
  const note = (text: string) => issues.push({ level: 'note', text });
  const debt = afterpayDebt(b, d.afterpay.debtId);
  if (!debt) return { proposal: null, ignored, issues: [{ level: 'block', text: 'There’s no Afterpay set up in Debts yet. Add it there first.' }] };
  // Upcoming payments can be empty (nothing left to pay) — that still pays off every open order.
  if (!d.afterpay.orders.length && !d.afterpay.listsAllDue) {
    block('No orders were found. Try a screenshot that shows your orders and their instalments.');
  }

  const updates: OrderUpdate[] = [];
  const paidOff: string[] = [];
  const newPlans: DebtPlan[] = [];
  const used = new Set<string>();
  for (const o of d.afterpay.orders) {
    const name = o.merchant || 'An order';
    const total = toCents(o.total.value);
    const inst: { date: ISODate; amount: Cents; label?: string; paid: boolean }[] = [];
    let bad = false;
    for (const i of o.instalments) {
      const date = validDate(i.date);
      const c = toCents(i.amount);
      if (!date || !c) { bad = true; continue; }
      inst.push({ date, amount: c.cents, label: i.label, paid: i.paid });
    }
    if (bad) { block(`Check the instalments for ${name}: a date or amount couldn’t be read.`); continue; }
    // Only instalments still to come: anything paid or due before today is already counted.
    const keep = inst.filter((i) => !i.paid && i.date >= today).sort((x, y) => x.date.localeCompare(y.date)).map(({ date, amount, label }) => ({ date, amount, ...(label ? { label } : {}) }));
    const done = inst.length - keep.length;
    if (done) ignored.push(`${name}: ${done} instalment${done === 1 ? '' : 's'} already paid or due before today, already counted.`);
    const all = inst.reduce((t, i) => t + i.amount, 0);
    const remainingSum = keep.reduce((t, i) => t + i.amount, 0);
    // Upcoming payments often only shows the amount still due, not the original order total.
    const orderTotal = total?.cents ?? (all || remainingSum);
    if (total === null && !keep.length && !inst.length) { block(`Check the total for ${name}.`); continue; }
    if (total === null && keep.length) note(`${name}: no order total on the screen — using the ${cash(remainingSum)} still due.`);
    if (total?.cents && inst.length >= 4 && Math.abs(all - total.cents) > 4) note(`${name}: the instalments add up to ${cash(all)}, not the total of ${cash(total.cents)}. Check them.`);

    const plan = resolveOrder({ ...o, total: total?.cents ?? remainingSum }, debt);
    if (plan) {
      if (used.has(plan.id)) { block(`Two orders on the screenshot matched ${plan.name}. Check them.`); continue; }
      used.add(plan.id);
      if (!keep.length) paidOff.push(plan.id);
      else updates.push({ planId: plan.id, instalments: keep });
    } else if (!keep.length) {
      ignored.push(`${name}: fully paid, so it isn’t added.`);
    } else {
      const purchaseDate = validDate(o.purchaseDate) ?? today;
      newPlans.push({
        id: o.newId, name: o.merchant.trim() || 'Afterpay order', type: 'afterpay',
        original: orderTotal || remainingSum, remaining: remainingSum,
        asOf: today, purchaseDate, instalments: keep,
      });
    }
  }
  const others = debt.plans.filter((p) => !used.has(p.id));
  if (d.afterpay.listsAllDue) {
    // Upcoming payments lists everything still due — anything not on it is paid off.
    for (const p of others) paidOff.push(p.id);
    if (others.length) note(`${others.length} other order${others.length === 1 ? '' : 's'} not on Upcoming payments: marked paid off.`);
  } else if (others.length && (updates.length || paidOff.length || newPlans.length)) {
    ignored.push(`${others.length} other order${others.length === 1 ? '' : 's'} not on this screenshot: left as ${others.length === 1 ? 'it is' : 'they are'}.`);
  }
  if (issues.some((i) => i.level === 'block')) return { proposal: null, issues, ignored };
  if (!updates.length && !paidOff.length && !newPlans.length) {
    return { proposal: null, ignored, issues: [...issues, { level: 'block', text: d.afterpay.listsAllDue && !debt.plans.length ? 'Nothing to change: Afterpay is already clear.' : 'Nothing to change: every order on the screenshot is already paid.' }] };
  }
  return { proposal: { kind: 'afterpay', debtId: debt.id, updates, paidOff, newPlans }, issues, ignored };
}
