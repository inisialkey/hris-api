// The approval facade — the only import path other modules may use (ADR-0001 §1).
//
// One port crosses it, and it is the widest contract in the system: nine module
// documents declare `ApprovalPort` and §13 registers eight request types for V1.
// Every one of its five methods runs **inside the caller's transaction**, which
// is what BR-APRV-001's integration contract requires and what makes §9's
// "module submits inside a failing transaction → no orphan instances" true.
//
// The engine exposes no HTTP action endpoints (§7's design decision): a module
// owns the `approve`/`reject`/`return`/`cancel` routes with its own static
// permission key, and calls this port for gate two.

export { ApprovalModule } from './approval.module';
export {
  APPROVAL_PORT,
  type ApprovalPort,
  type DecisionResult,
  type SubmitCommand,
} from './domain/approval.ports';
export type { RequestContext } from './domain/approval.types';
export { REQUEST_TYPES, isRegisteredRequestType } from './domain/request-types';
