// Names shown for each kind of debt (Debt['kind'] in core/types.ts).
import type { Debt } from '../../../core/types';

export const KIND_LABEL: Record<Debt['kind'], string> = { card: 'Credit card', bnpl: 'Buy now, pay later', person: 'Person', loan: 'Loan' };
