// The inbox facade — the only import path other modules may use (ADR-0001 §1).
//
// One port leaves and one arrives, which is the shape of a materialized view
// over other modules' facts. `InboxPort` is announcement.md's: `createAckItems`
// fans acknowledgment items out at publish, `closeAckItems` closes them on
// retraction, and inbox owns the action behind them because it owns the offline
// queue class (BR-INB-007) while announcement owns the fact.
//
// **The approval half crosses no facade at all.** Items materialize from §12's
// events, and approval-engine's `ApprovalTaskPort` is consumed rather than
// exported — this module tells nobody about approval tasks, it only shows them
// to the person who has to act.
//
// **`InboxEventHandlers` is deliberately not exported.** It is the seam the
// outbox relay will call, and the relay does not exist — ADR-0010 dispatches
// from a BullMQ worker this repository does not have. Exporting a concrete class
// through a facade for a caller that has not been written would also be the one
// thing backend-nestjs §4 rules out: a facade exports port tokens with
// interfaces, never classes. The relay gets a port when there is a relay.

export { InboxModule } from './inbox.module';
export { INBOX_PORT, type InboxPort } from './domain/inbox.ports';
export type { AckItemsReport, CreateAckItemsCommand } from './domain/inbox.types';
