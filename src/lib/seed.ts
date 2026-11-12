import type { Budget } from './types';

/**
 * A blank budget to start from: one account your pay lands in, and the usual groups. Add your own
 * accounts, costs, debts and goals in the app, or restore a backup in Settings.
 */
export const seedBudget: Budget = {
  version: 1,
  settings: {
    paydayDay: 15,
    saturday: 'friday',
    sunday: 'monday',
    expectedPay: 0,
    payAccountId: 'everyday',
    rule: { name: '50/30/20', needs: 50, wants: 30, savings: 20 },
  },
  groups: [
    { id: 'needs', name: 'Essentials', color: '#14A38B', bucket: 'needs' },
    { id: 'lifestyle', name: 'Lifestyle', color: '#F59E0B', bucket: 'wants' },
    { id: 'savings', name: 'Savings', color: '#E0527F', bucket: 'savings' },
    { id: 'debt', name: 'Debt', color: '#6366F1', bucket: 'savings' },
  ],
  accounts: [
    { id: 'everyday', name: 'Everyday', kind: 'bank', color: '#6366F1', groupId: 'lifestyle', note: 'Pay lands here' },
  ],
  items: [],
  split: [],
  payActuals: {},
  flags: [],
  debts: [],
  savings: [],
};
