import type { PaydayMode } from './types';

/** Short labels for the payday-amount control in account settings. */
export const PAYDAY_MODE_LABEL: Record<PaydayMode, string> = {
  fixed: 'Set amount',
  smooth: 'Level amount',
  exact: "This pay's costs",
};

/** What each option does, shown under the control. */
export const PAYDAY_MODE_HINT: Record<PaydayMode, string> = {
  fixed: 'You type the figure. It stays the same every payday.',
  smooth: 'Same figure every payday. 4-week pays leave a buffer that covers the 5th week.',
  exact: 'Sends exactly what this pay needs — more in a 5-week pay, less in a 4-week pay.',
};
