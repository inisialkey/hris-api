import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { CLOCK, type Clock } from '../shared/clock.port';
import { currentRequestContext } from '../shared/context';
import { ConnectionProvider } from './connection.provider';
import { domainEvents } from './schema';

export interface OutboxEvent {
  /** naming §6 — `leave.request.approved`. */
  name: string;
  tenantId: string;
  aggregateId: string;
  /** Pointers and primitives only (coding-standards-nestjs §7). */
  payload: Record<string, unknown>;
}

/**
 * ADR-0010's outbox, write side.
 *
 * One writer for every module, in `src/database/` beside the unit-of-work it
 * rides: the row commits or rolls back with the business change that caused it,
 * and that property has nothing to do with which module caused it. Modules keep
 * their own **port** — a typed event-name union is worth having per module —
 * and bind it here.
 *
 * The relay that dispatches `dispatched_at IS NULL` rows is worker machinery and
 * arrives with the first BullMQ wiring; rows written now are simply dispatched
 * then.
 */
@Injectable()
export class OutboxRepository {
  constructor(
    private readonly connection: ConnectionProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async emit(event: OutboxEvent): Promise<void> {
    await this.connection.handle().insert(domainEvents).values({
      id: uuidv7(),
      name: event.name,
      tenantId: event.tenantId,
      aggregateId: event.aggregateId,
      occurredAt: this.clock.now(),
      requestId: currentRequestContext()?.requestId,
      payload: event.payload,
    });
  }
}
