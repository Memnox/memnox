/** Counter names exposed on /v1/metrics. Deterministic events the gateway already tracks. */
export const METRIC = {
  ACTIONS_TOTAL: 'memnox_actions_total',
  APPROVALS_TOTAL: 'memnox_approvals_total',
  RATE_LIMIT_REJECTIONS_TOTAL: 'memnox_rate_limit_rejections_total',
  AUDIT_APPEND_FAILURES_TOTAL: 'memnox_audit_append_failures_total',
  PROXY_CALLS_TOTAL: 'memnox_proxy_calls_total',
  PROXY_BLOCKED_TOTAL: 'memnox_proxy_blocked_total',
  PROXY_TOKENS_TOTAL: 'memnox_proxy_tokens_total',
  PLAINTEXT_RECORDS_READ_TOTAL: 'memnox_plaintext_records_read_total',
} as const;

export type MetricName = (typeof METRIC)[keyof typeof METRIC];

/** A registry's catalog: every counter it exposes, mapped to its HELP line. */
export type MetricCatalog<N extends string = string> = Record<N, string>;

const METRIC_HELP: MetricCatalog<MetricName> = {
  [METRIC.ACTIONS_TOTAL]: 'Authorization decisions by effect and risk level.',
  [METRIC.APPROVALS_TOTAL]: 'Approvals by lifecycle state (pending, resolved).',
  [METRIC.RATE_LIMIT_REJECTIONS_TOTAL]: 'Requests rejected by the check rate limiter.',
  [METRIC.AUDIT_APPEND_FAILURES_TOTAL]: 'Audit events that could not be appended.',
  [METRIC.PROXY_CALLS_TOTAL]: 'Inference calls relayed through the BYOK proxy.',
  [METRIC.PROXY_BLOCKED_TOTAL]: 'Inference calls the proxy refused to relay.',
  [METRIC.PROXY_TOKENS_TOTAL]: 'Tokens reported by upstream providers via the proxy.',
  [METRIC.PLAINTEXT_RECORDS_READ_TOTAL]:
    'Unencrypted records read while encryption is permissive. Reaching zero is the signal to switch to strict.',
};

export const APPROVAL_METRIC_STATE = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  /** Retired unread past its TTL — nobody ever decided it. */
  LAPSED: 'lapsed',
} as const;

export type MetricLabels = Record<string, string>;

/**
 * One process's view of its own counters. Multi-pod aggregation is the scrape
 * layer's job — Prometheus sums across instances, this registry never does.
 */
export class MetricsRegistry<N extends string = MetricName> {
  private readonly counters = new Map<string, number>();
  private readonly labelSets = new Map<string, MetricLabels>();

  /** Defaults to the runtime's own counters; the cloud passes its catalog. */
  constructor(
    private readonly catalog: MetricCatalog<N> = METRIC_HELP as MetricCatalog<N>,
  ) {}

  increment(name: N, labels: MetricLabels = {}): void {
    this.add(name, 1, labels);
  }

  /** Counters that move by more than one — token counts, byte counts. */
  add(name: N, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    this.labelSets.set(key, labels);
  }

  /** Reading a counter that was never incremented yields 0, not undefined. */
  value(name: N, labels: MetricLabels = {}): number {
    return this.counters.get(seriesKey(name, labels)) ?? 0;
  }

  /** Prometheus text exposition format (version 0.0.4). */
  render(): string {
    const lines: string[] = [];
    for (const name of Object.keys(this.catalog) as N[]) {
      const series = [...this.counters.entries()].filter(([key]) =>
        key.startsWith(`${name}{`),
      );
      lines.push(`# HELP ${name} ${this.catalog[name]}`, `# TYPE ${name} counter`);
      if (series.length === 0) {
        lines.push(`${name} 0`);
        continue;
      }
      for (const [key, count] of series) {
        lines.push(`${renderSeries(name, this.labelSets.get(key) ?? {})} ${count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function seriesKey(name: string, labels: MetricLabels): string {
  const pairs = Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([label, value]) => `${label}=${value}`);
  return `${name}{${pairs.join(',')}}`;
}

function renderSeries(name: string, labels: MetricLabels): string {
  const pairs = Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([label, value]) => `${label}="${escapeLabelValue(value)}"`);
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
