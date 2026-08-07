// The single schema root drizzle-kit reads (backend-nestjs §2 rule 2).
// Centralised for the tool, owned per module by the file it lives in.

export * from './core.schema';
export * from './auth.schema';
export * from './audit.schema';
export * from './settings.schema';
export * from './organization.schema';
export * from './employee.schema';
export * from './approval.schema';
export * from './sysadmin.schema';
export * from './scratch.schema';
