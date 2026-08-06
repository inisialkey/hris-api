// The organization facade — the only import path other modules may use
// (ADR-0001 §1, BR-ORG-010).
//
// Two ports cross it. `OrgQueryPort` is the most-consumed contract in the system
// — attendance reads a branch timezone through it, the approval engine resolves
// `direct_manager` and `position_holder` through it, announcement resolves an
// audience through it. `OrgPlacementPort` is the write half, and it exists so
// that BR-ORG-002 can hold: a hire seeds its placement inside the caller's
// transaction, or the employee is not created.

export { OrganizationModule } from './organization.module';
export {
  ORG_PLACEMENT_PORT,
  ORG_QUERY_PORT,
  type AudienceRules,
  type OrgPlacementPort,
  type OrgQueryPort,
} from './domain/organization.ports';
export type { Placement } from './domain/organization.types';
