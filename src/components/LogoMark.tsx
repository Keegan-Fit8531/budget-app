import { useId } from 'react';

/**
 * The Paydays mark: a white calendar with a dollar cut out of it, on an amber-to-coral tile.
 * Same drawing as public/icon.svg (and the PNG icons made from it).
 */
export function LogoMark({ size = 32 }: { size?: number }) {
  const id = useId();
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFC24B" />
          <stop offset="1" stopColor="#F06A2B" />
        </linearGradient>
        <mask id={`${id}m`}>
          <rect x="6.2" y="8" width="19.6" height="18.6" rx="4" fill="#fff" />
          <rect x="10" y="5" width="2.8" height="5.6" rx="1.4" fill="#fff" />
          <rect x="19.2" y="5" width="2.8" height="5.6" rx="1.4" fill="#fff" />
          <rect x="6" y="11.8" width="20" height="1.6" fill="#000" />
          <path d={DOLLAR} fill="#000" />
        </mask>
      </defs>
      <path d={SQUIRCLE} fill={`url(#${id}g)`} />
      <rect width="32" height="32" fill="#fff" mask={`url(#${id}m)`} />
    </svg>
  );
}

const SQUIRCLE = 'M9 0h14c6.5 0 9 2.5 9 9v14c0 6.5-2.5 9-9 9H9c-6.5 0-9-2.5-9-9V9c0-6.5 2.5-9 9-9Z';
/** The "$" from Plus Jakarta Sans ExtraBold (the app's font), outlined and placed on the calendar. */
const DOLLAR = 'M15.64 25.6V24.52Q15.13 24.45 14.67 24.25Q13.94 23.95 13.41 23.4Q12.88 22.84 12.62 22.08L14.13 21.4Q14.46 22.13 15.05 22.54Q15.34 22.74 15.64 22.85V20.76L15.06 20.57Q14.01 20.23 13.48 19.6Q12.94 18.96 12.94 18.07Q12.94 17.29 13.33 16.7Q13.71 16.11 14.41 15.77Q14.96 15.51 15.64 15.45V14.4H16.71V15.5Q17.1 15.57 17.47 15.72Q18.15 15.99 18.64 16.49Q19.13 16.98 19.38 17.68L17.88 18.36Q17.64 17.74 17.14 17.39Q16.94 17.26 16.71 17.16V19.27L17.26 19.45Q18.32 19.79 18.85 20.41Q19.38 21.03 19.38 21.91Q19.38 22.68 18.97 23.28Q18.57 23.88 17.87 24.21Q17.35 24.46 16.71 24.53V25.6ZM15.64 18.93V17.08Q15.49 17.1 15.35 17.16Q15.06 17.28 14.91 17.5Q14.76 17.72 14.76 18Q14.76 18.31 14.96 18.54Q15.16 18.77 15.56 18.9ZM16.71 22.92Q16.87 22.9 17 22.84Q17.27 22.72 17.42 22.51Q17.58 22.31 17.58 22.02Q17.58 21.71 17.39 21.49Q17.2 21.27 16.79 21.14L16.71 21.12Z';
