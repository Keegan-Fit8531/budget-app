import { useId } from 'react';

/** The Paydays mark: a calendar page with a dollar on it, on an ochre tile. Same drawing as public/icon.svg. */
export function LogoMark({ size = 32 }: { size?: number }) {
  const grad = useId();
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F5C766" />
          <stop offset="1" stopColor="#D48A1E" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${grad})`} />
      <rect x="6.5" y="9.5" width="19" height="17.5" rx="3.2" fill="#B8741A" opacity=".35" />
      <rect x="6.5" y="8.5" width="19" height="17.5" rx="3.2" fill="#FFF9EC" />
      <path d="M6.5 11.7a3.2 3.2 0 0 1 3.2-3.2h12.6a3.2 3.2 0 0 1 3.2 3.2v1.8h-19z" fill="#14424D" />
      <rect x="10.4" y="5.6" width="2.4" height="5.4" rx="1.2" fill="#14424D" />
      <rect x="19.2" y="5.6" width="2.4" height="5.4" rx="1.2" fill="#14424D" />
      <g fill="none" stroke="#14424D" strokeWidth="1.9" strokeLinecap="round">
        <path d="M18.4 16.9c-.4-.7-1.3-1.1-2.4-1.1-1.4 0-2.4.7-2.4 1.7 0 2.4 4.9 1.3 4.9 3.8 0 1.1-1 1.8-2.6 1.8-1.1 0-2-.4-2.5-1.2" />
        <path d="M16 14.6v1.2M16 22.9v1.2" />
      </g>
    </svg>
  );
}
