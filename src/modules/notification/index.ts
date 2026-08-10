// The notification facade — the only import path other modules may use
// (ADR-0001 §1).
//
// Two ports leave and nothing arrives, which is the shape of a terminal effect.
// §12 says it in one line — **events emitted: none** — because nothing
// downstream should react to "a notification was sent"; delivery state is
// queryable, not evented.
//
// `NotificationPort` is the wide one: UC-NTF-002's direct send and UC-NTF-006's
// fan-out, named by eight module documents. Callers hand over a registered
// template key, their recipients, and a dedupe key; everything after that —
// preference, locale, render, the dedupe index, the per-channel delivery rows —
// is this module's.
//
// `NotificationStatsPort` is §13's narrow one: a count of failed deliveries for
// the platform-health page, with no channel breakdown, no content and no
// recipients. It exists so system-administration can show that number without
// reaching a table.
//
// **`NotificationEventHandlers` is deliberately not exported.** It is the seam
// the outbox relay will call, and the relay does not exist — ADR-0010 dispatches
// from a BullMQ worker this repository does not have. Exporting a concrete
// class through a facade for a caller that has not been written would also be
// the one thing backend-nestjs §4 rules out: a facade exports port tokens with
// interfaces, never classes. The relay gets a port when there is a relay.

export { NotificationModule } from './notification.module';
export {
  NOTIFICATION_PORT,
  NOTIFICATION_STATS_PORT,
  type NotificationPort,
  type NotificationStatsPort,
} from './domain/notification.ports';
export type {
  FanoutCommand,
  Recipients,
  SendCommand,
  SendReport,
  TemplateParams,
} from './domain/notification.types';
