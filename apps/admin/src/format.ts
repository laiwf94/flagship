const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "5 minutes ago", "yesterday", "in 3 hours". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds <= 0 ? 'just now' : 'in a moment';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['month', 2_592_000],
    ['year', 31_536_000],
  ];
  let chosen: [Intl.RelativeTimeFormatUnit, number] = ['minute', 60];
  for (const u of units) if (abs >= u[1] * 0.75) chosen = u;
  return relative.format(Math.round(seconds / chosen[1]), chosen[0]);
}

/** Full local date and time, for tooltips. */
export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function percent(weight: number): string {
  const p = weight / 1000;
  return `${Number.isInteger(p) ? p : p.toFixed(p < 1 ? 3 : 1).replace(/0+$/, '')}%`;
}

/** Turns "New checkout flow" into "new-checkout-flow". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function formatValue(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}
