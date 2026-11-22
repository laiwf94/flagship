/** Formats rows as left-aligned columns separated by two spaces, header first. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** "name: value" lines with the names padded to one width. */
export function fields(pairs: readonly (readonly [string, string])[]): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${`${k}:`.padEnd(width + 1)} ${v}`.trimEnd()).join('\n');
}

/** A JSON value on one line, for variant values and clause values in text output. */
export function compact(value: unknown): string {
  // JSON.stringify(undefined) is undefined, whatever its type says.
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/** An ISO timestamp as "2026-11-22 05:09", in UTC. */
export function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** Comma-separated, or "-" for none. */
export function list(items: readonly string[]): string {
  return items.length === 0 ? '-' : items.join(', ');
}
