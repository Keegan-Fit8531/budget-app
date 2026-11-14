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
          <path d={DOLLAR} fill="none" stroke="#000" strokeWidth="2.2" strokeLinecap="round" />
        </mask>
      </defs>
      <path d={SQUIRCLE} fill={`url(#${id}g)`} />
      <rect width="32" height="32" fill="#fff" mask={`url(#${id}m)`} />
    </svg>
  );
}

const SQUIRCLE = 'M9 0h14c6.5 0 9 2.5 9 9v14c0 6.5-2.5 9-9 9H9c-6.5 0-9-2.5-9-9V9c0-6.5 2.5-9 9-9Z';
const DOLLAR = 'M18.6 16.6c-.45-.75-1.4-1.2-2.6-1.2-1.5 0-2.6.75-2.6 1.85 0 2.6 5.25 1.4 5.25 4.1 0 1.15-1.1 1.95-2.75 1.95-1.2 0-2.2-.45-2.7-1.3M16 14.1v1.3M16 23.3v1.3';
