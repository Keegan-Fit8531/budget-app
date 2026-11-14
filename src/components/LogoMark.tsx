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
          <g fill="none" stroke="#000" strokeLinecap="round" strokeLinejoin="round">
            <path d={DOLLAR_S} strokeWidth="2" />
            <path d={DOLLAR_BAR} strokeWidth="1.9" />
          </g>
        </mask>
      </defs>
      <path d={SQUIRCLE} fill={`url(#${id}g)`} />
      <rect width="32" height="32" fill="#fff" mask={`url(#${id}m)`} />
    </svg>
  );
}

const SQUIRCLE = 'M9 0h14c6.5 0 9 2.5 9 9v14c0 6.5-2.5 9-9 9H9c-6.5 0-9-2.5-9-9V9c0-6.5 2.5-9 9-9Z';
/** A heavy, round-ended "$": the S, then the short stubs above and below it. */
const DOLLAR_S = 'M17.89 17.76C17.50 17.03 16.75 16.70 16.00 16.70C14.85 16.70 14.07 17.36 14.07 18.25C14.07 19.27 15.00 19.67 16.00 19.90C17.10 20.26 17.93 20.73 17.93 21.78C17.93 22.71 17.05 23.30 16.00 23.30C15.20 23.30 14.40 22.97 14.05 22.31';
const DOLLAR_BAR = 'M16 15.25V16.00M16 24.00V24.75';
