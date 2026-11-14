import { useId } from 'react';

/**
 * The Paydays mark: a flip calendar (the front page folded across the middle, the next page
 * peeking out behind) with a "$" on it, on an amber-to-coral tile. Same drawing as
 * public/icon.svg and the PNG icons made from it.
 */
export function LogoMark({ size = 32 }: { size?: number }) {
  const tile = `${useId()}tile`;
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        {/* In page units, so the "$" painted with it matches the tile colour right behind it. */}
        <linearGradient id={tile} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="32">
          <stop offset="0" stopColor="#FFC24B" />
          <stop offset="1" stopColor="#F06A2B" />
        </linearGradient>
      </defs>
      <path d={SQUIRCLE} fill={`url(#${tile})`} />
      <path d={NEXT_PAGE} fill="#fff" opacity=".5" />
      <path d={PAGE_TOP} fill="#fff" />
      <path d={PAGE_BOTTOM} fill="#FFF1E0" />
      <path d={FOLD} stroke="#F6C08C" strokeWidth=".4" />
      <g fill="none" stroke={`url(#${tile})`} strokeLinecap="round" strokeLinejoin="round" transform="translate(16 17.4) scale(1.12) translate(-16 -20)">
        <path d={DOLLAR_S} strokeWidth="2" />
        <path d={DOLLAR_BAR} strokeWidth="1.9" />
      </g>
    </svg>
  );
}

const SQUIRCLE = 'M9 0h14c6.5 0 9 2.5 9 9v14c0 6.5-2.5 9-9 9H9c-6.5 0-9-2.5-9-9V9c0-6.5 2.5-9 9-9Z';
const NEXT_PAGE = 'M10.4 6.2h11.2c1.4 0 2.5 1.1 2.5 2.5V12H7.9V8.7c0-1.4 1.1-2.5 2.5-2.5Z';
/** The front page's two halves: the sides pinch in slightly at the fold, like a flip clock. */
const PAGE_TOP = 'M9.3 8.4h13.4c1.55 0 2.8 1.25 2.8 2.8 0 3.2-.1 4.9-.45 6H6.95c-.35-1.1-.45-2.8-.45-6 0-1.55 1.25-2.8 2.8-2.8Z';
const PAGE_BOTTOM = 'M6.95 17.2h18.1c.35 1.1.45 3.2.45 6.4 0 1.55-1.25 2.8-2.8 2.8H9.3c-1.55 0-2.8-1.25-2.8-2.8 0-3.2.1-5.3.45-6.4Z';
const FOLD = 'M6.95 17.2h18.1';
/** A heavy, round-ended "$": the S, then the short stubs above and below it. */
const DOLLAR_S = 'M17.89 17.76C17.50 17.03 16.75 16.70 16.00 16.70C14.85 16.70 14.07 17.36 14.07 18.25C14.07 19.27 15.00 19.67 16.00 19.90C17.10 20.26 17.93 20.73 17.93 21.78C17.93 22.71 17.05 23.30 16.00 23.30C15.20 23.30 14.40 22.97 14.05 22.31';
const DOLLAR_BAR = 'M16 15.25V16.00M16 24.00V24.75';
