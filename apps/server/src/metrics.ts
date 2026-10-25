/**
 * Prometheus text exposition (format 0.0.4) without a client library: three
 * metric kinds, labels, and nothing else we don't use.
 */

type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelKey(names: readonly string[], labels: Labels): string {
  return names.map((n) => labels[n] ?? '').join('\u0000');
}

function renderLabels(names: readonly string[], values: readonly string[], extra = ''): string {
  const parts = names.map((n, i) => `${n}="${escapeLabel(values[i] ?? '')}"`);
  if (extra !== '') parts.push(extra);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

function formatNumber(n: number): string {
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return Number.isNaN(n) ? 'NaN' : String(n);
}

interface Metric {
  render(): string;
}

abstract class Base implements Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: string,
    readonly labelNames: readonly string[],
  ) {}

  protected header(): string {
    return `# HELP ${this.name} ${this.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}\n# TYPE ${this.name} ${this.type}\n`;
  }

  abstract render(): string;
}

export class Counter extends Base {
  private readonly values = new Map<string, { labels: string[]; value: number }>();

  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, 'counter', labelNames);
  }

  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new RangeError('counters only go up');
    const key = labelKey(this.labelNames, labels);
    const entry = this.values.get(key);
    if (entry === undefined) {
      this.values.set(key, { labels: this.labelNames.map((n) => labels[n] ?? ''), value: by });
    } else {
      entry.value += by;
    }
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(this.labelNames, labels))?.value ?? 0;
  }

  render(): string {
    let out = this.header();
    for (const { labels, value } of this.values.values()) {
      out += `${this.name}${renderLabels(this.labelNames, labels)} ${formatNumber(value)}\n`;
    }
    return out;
  }
}

export class Gauge extends Base {
  private readonly values = new Map<string, { labels: string[]; value: number }>();
  private readonly collectors: (() => void)[] = [];

  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, 'gauge', labelNames);
  }

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(this.labelNames, labels), {
      labels: this.labelNames.map((n) => labels[n] ?? ''),
      value,
    });
  }

  /** Sets the value lazily, right before each scrape. */
  collect(fn: () => void): void {
    this.collectors.push(fn);
  }

  render(): string {
    for (const fn of this.collectors) fn();
    let out = this.header();
    for (const { labels, value } of this.values.values()) {
      out += `${this.name}${renderLabels(this.labelNames, labels)} ${formatNumber(value)}\n`;
    }
    return out;
  }
}

export class Histogram extends Base {
  private readonly series = new Map<
    string,
    { labels: string[]; counts: number[]; sum: number; count: number }
  >();

  constructor(
    name: string,
    help: string,
    readonly buckets: readonly number[],
    labelNames: readonly string[] = [],
  ) {
    super(name, help, 'histogram', labelNames);
    if (buckets.some((b, i) => i > 0 && b <= (buckets[i - 1] ?? -Infinity))) {
      throw new RangeError('histogram buckets must increase');
    }
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(this.labelNames, labels);
    let s = this.series.get(key);
    if (s === undefined) {
      s = {
        labels: this.labelNames.map((n) => labels[n] ?? ''),
        counts: this.buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, s);
    }
    const index = this.buckets.findIndex((b) => value <= b);
    if (index >= 0) s.counts[index] = (s.counts[index] ?? 0) + 1;
    s.sum += value;
    s.count += 1;
  }

  render(): string {
    let out = this.header();
    for (const s of this.series.values()) {
      let cumulative = 0;
      this.buckets.forEach((b, i) => {
        cumulative += s.counts[i] ?? 0;
        out += `${this.name}_bucket${renderLabels(this.labelNames, s.labels, `le="${formatNumber(b)}"`)} ${cumulative}\n`;
      });
      out += `${this.name}_bucket${renderLabels(this.labelNames, s.labels, 'le="+Inf"')} ${s.count}\n`;
      out += `${this.name}_sum${renderLabels(this.labelNames, s.labels)} ${formatNumber(s.sum)}\n`;
      out += `${this.name}_count${renderLabels(this.labelNames, s.labels)} ${s.count}\n`;
    }
    return out;
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];

  register<M extends Metric>(metric: M): M {
    this.metrics.push(metric);
    return metric;
  }

  render(): string {
    return this.metrics.map((m) => m.render()).join('');
  }
}

/** The metrics the server records. One instance per app, so tests don't share counters. */
export function createMetrics() {
  const registry = new Registry();
  return {
    registry,
    httpRequests: registry.register(
      new Counter('flagship_http_requests_total', 'HTTP requests by route and status.', [
        'method',
        'route',
        'status',
      ]),
    ),
    httpDuration: registry.register(
      new Histogram(
        'flagship_http_request_duration_seconds',
        'HTTP request latency by route, excluding streams.',
        [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
        ['route'],
      ),
    ),
    streams: registry.register(
      new Gauge('flagship_sse_connections', 'Open Server-Sent Events connections.', ['kind']),
    ),
    streamEvents: registry.register(
      new Counter('flagship_sse_events_total', 'Events written to SSE connections.', ['event']),
    ),
    streamDrops: registry.register(
      new Counter('flagship_sse_dropped_total', 'Streams closed by the server.', ['reason']),
    ),
    exposures: registry.register(
      new Counter('flagship_exposure_counts_total', 'Exposure counts by outcome.', ['result']),
    ),
    exposureQueue: registry.register(
      new Gauge('flagship_exposure_queue_entries', 'Distinct exposure rows waiting to be flushed.'),
    ),
    schedules: registry.register(
      new Counter('flagship_scheduled_changes_total', 'Scheduled changes processed.', ['result']),
    ),
    rulesetBuilds: registry.register(
      new Counter('flagship_ruleset_builds_total', 'Rulesets rebuilt from the database.'),
    ),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
