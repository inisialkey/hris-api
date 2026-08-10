// The approval facade — the only import path other modules may use (ADR-0001 §1).
//
// Two ports cross it. `ApprovalPort` is the widest contract in the system: nine module
// documents declare `ApprovalPort` and §13 registers eight request types for V1.
// Every one of its five methods runs **inside the caller's transaction**, which
// is what BR-APRV-001's integration contract requires and what makes §9's
// "module submits inside a failing transaction → no orphan instances" true.
//
// The engine exposes no HTTP action endpoints (§7's design decision): a module
// owns the `approve`/`reject`/`return`/`cancel` routes with its own static
// permission key, and calls this port for gate two.
//
// `ApprovalTaskPort` is the read counterpart, added 2026-08-10 for inbox.md
// (A-199, hris-handbook PR #33). It turns one step into its seats-as-tasks, so
// that the module materializing an inbox item from `approval.step.activated`
// gets the assignee row ids, the request identity, the SLA deadline and the
// delegate pairing without reading `approval_assignees` — the table §13 used to
// point at, and which ADR-0001 rule 2 has always kept behind this boundary.

export { ApprovalModule } from './approval.module';
export {
  APPROVAL_PORT,
  APPROVAL_TASK_PORT,
  type ApprovalPort,
  type ApprovalStepTasks,
  type ApprovalTask,
  type ApprovalTaskPort,
  type DecisionResult,
  type SubmitCommand,
} from './domain/approval.ports';
export type { RequestContext } from './domain/approval.types';
// `contextFieldsOf` leaves too: it is the engine's own answer to "what may
// this request type's chain conditions reference", and inbox.md's item
// subtitles are built over the same declared fields (A-199).
export { REQUEST_TYPES, contextFieldsOf, isRegisteredRequestType } from './domain/request-types';
