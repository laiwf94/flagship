import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram, Registry, createMetrics } from './metrics.js';

describe('metrics', () => {
  it('renders counters with escaped labels', () => {
    const c = new Counter('requests_total', 'Requests.\nSecond line \\', ['route']);
    c.inc({ route: '/a"b\\c\nd' });
    c.inc({ route: '/a"b\\c\nd' }, 2);
    c.inc();
    expect(c.get({ route: '/a"b\\c\nd' })).toBe(3);
    expect(c.render()).toBe(
      '# HELP requests_total Requests.\\nSecond line \\\\\n' +
        '# TYPE requests_total counter\n' +
        'requests_total{route="/a\\"b\\\\c\\nd"} 3\n' +
        'requests_total{route=""} 1\n',
    );
    expect(() => {
      c.inc({}, -1);
    }).toThrow(RangeError);
  });

  it('renders gauges, including lazily collected ones', () => {
    const g = new Gauge('open', 'Open things.');
    let n = 1;
    g.collect(() => {
      g.set(n);
    });
    expect(g.render()).toContain('open 1\n');
    n = 5;
    expect(g.render()).toContain('open 5\n');
    const special = new Gauge('special', 'x');
    special.set(Infinity);
    expect(special.render()).toContain('special +Inf');
    special.set(-Infinity);
    expect(special.render()).toContain('special -Inf');
    special.set(Number.NaN);
    expect(special.render()).toContain('special NaN');
  });

  it('renders cumulative histogram buckets with sum and count', () => {
    const h = new Histogram('latency_seconds', 'Latency.', [0.1, 1], ['route']);
    h.observe(0.05, { route: 'a' });
    h.observe(0.5, { route: 'a' });
    h.observe(5, { route: 'a' });
    expect(h.render()).toBe(
      '# HELP latency_seconds Latency.\n# TYPE latency_seconds histogram\n' +
        'latency_seconds_bucket{route="a",le="0.1"} 1\n' +
        'latency_seconds_bucket{route="a",le="1"} 2\n' +
        'latency_seconds_bucket{route="a",le="+Inf"} 3\n' +
        'latency_seconds_sum{route="a"} 5.55\n' +
        'latency_seconds_count{route="a"} 3\n',
    );
    expect(() => new Histogram('bad', 'x', [1, 1])).toThrow(RangeError);
  });

  it('collects everything in a registry', () => {
    const r = new Registry();
    r.register(new Counter('a_total', 'A.')).inc();
    r.register(new Gauge('b', 'B.')).set(2);
    expect(r.render()).toContain('a_total 1\n');
    expect(r.render()).toContain('b 2\n');
    expect(createMetrics().registry.render()).toContain(
      '# TYPE flagship_http_requests_total counter',
    );
  });
});
