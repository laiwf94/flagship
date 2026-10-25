const PATHS = {
  flag: 'M5 21V4m0 1h12l-2.5 4L17 13H5',
  segment:
    'M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-5 7c0-2.8 2.2-5 5-5s5 2.2 5 5m1-3.5c.6-.3 1.3-.5 2-.5 2.8 0 5 2.2 5 5',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4m5-1v5l3 2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.2-1.3L14.3 3h-4l-.4 2.4a7.6 7.6 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3-4.3-4.3',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  power: 'M12 3v8m5.7-5.2a8 8 0 1 1-11.4 0',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5m5 5H4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4l3 2',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H3',
  key: 'M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-3 3v9m0-4h3m-3-2h2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8c0-3.3 3.1-6 7-6s7 2.7 7 6',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  archive: 'M3 5h18v4H3zm2 4v10h14V9m-9 4h4',
  restore: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  up: 'M12 19V5m-6 6 6-6 6 6',
  down: 'M12 5v14m6-6-6 6-6-6',
  diff: 'M12 3v18M5 8h4M7 6v4M15 16h4',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  alert:
    'M12 9v4m0 4h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z',
  back: 'M15 18l-6-6 6-6',
  menu: 'M4 6h16M4 12h16M4 18h16',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  label,
}: {
  name: IconName;
  size?: number;
  label?: string;
}) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label === undefined ? undefined : 'img'}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
