const PATHS: Record<string, string> = {
  home: 'M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  wallet: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 10h18 M16 15h2',
  card: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M2 10h20',
  target: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z M12 11.5v1',
  pie: 'M21 12A9 9 0 1 1 12 3v9z M15 3.5A9 9 0 0 1 20.5 9H15z',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9L7 7 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  plus: 'M12 5v14 M5 12h14',
  alert: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 8v5 M12 16h.01',
  x: 'M6 6l12 12 M18 6L6 18',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  bulb: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z',
  bank: 'M3 10l9-6 9 6 M5 10v8 M9.5 10v8 M14.5 10v8 M19 10v8 M3 20h18',
  send: 'M4 12h14 M13 6l6 6-6 6',
  check: 'M5 12l5 5 9-10',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  transfer: 'M4 8h14 M14 4l4 4-4 4 M20 16H6 M10 12l-4 4 4 4',
};

export function Icon({ name, size = 18, stroke = 2 }: { name: keyof typeof PATHS | string; size?: number; stroke?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {(PATHS[name] ?? '').split(' M').map((d, i) => <path key={i} d={i ? `M${d}` : d} />)}
    </svg>
  );
}
