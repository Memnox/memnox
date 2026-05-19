import type {
  ActionEvent,
  AuditChainVerification,
  AuditLog,
  AuditQuery,
} from '@memnox/core';
import { chainAuditEvent, GENESIS_HASH, verifyAuditChain } from '@memnox/core';
import { matchesAuditQuery } from './jsonl-audit-log';

export class InMemoryAuditLog implements AuditLog {
  private events: ActionEvent[] = [];

  async append(event: ActionEvent): Promise<void> {
    const tip = this.events[this.events.length - 1];
    const previousHash =
      tip === undefined || tip.hash === undefined ? GENESIS_HASH : tip.hash;
    this.events.push(chainAuditEvent(event, previousHash));
  }

  async recent(limit: number): Promise<ActionEvent[]> {
    return this.events.slice(-limit).reverse();
  }

  async query(filter: AuditQuery): Promise<ActionEvent[]> {
    const matching = this.events.filter((event) => matchesAuditQuery(event, filter));
    return filter.limit === undefined ? matching : matching.slice(-filter.limit);
  }

  async pruneBefore(cutoff: string): Promise<number> {
    const retained = this.events.filter((event) => event.occurredAt >= cutoff);
    const removed = this.events.length - retained.length;
    this.events = retained;
    return removed;
  }

  async verifyChain(): Promise<AuditChainVerification> {
    return verifyAuditChain(this.events);
  }
}
