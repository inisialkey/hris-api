import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { domainEvents } from '../../../database/schema';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { currentRequestContext } from '../../../shared/context';
import type { AuthOutboxPort } from '../domain/auth.ports';

/**
 * ADR-0010's outbox, write side only: the row commits or rolls back with the
 * business change that caused it, which is the whole point of an outbox. The
 * relay that dispatches `dispatched_at IS NULL` rows is worker machinery and
 * arrives with the first BullMQ wiring — rows written now are simply dispatched
 * then. Payloads are pointers and primitives (coding-standards-nestjs §7).
 */
@Injectable()
export class AuthOutboxRepository implements AuthOutboxPort {
  constructor(
    private readonly connection: ConnectionProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async emit(event: {
    name: 'auth.session.revoked' | 'auth.device.revoked' | 'auth.password.changed';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
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
