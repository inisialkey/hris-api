-- Custom SQL migration file, put your code below! --
--> statement-breakpoint
-- manual: btree_gist backs the effective-dating EXCLUDE constraints every
-- effective-dated table adds later (database-conventions §5.2). It is created
-- first because an extension is not something a table migration should discover
-- it needs halfway through.
CREATE EXTENSION IF NOT EXISTS btree_gist;
