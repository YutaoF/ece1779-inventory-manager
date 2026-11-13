\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL READ COMMITTED;

-- Serialize migration runs for this database, including the first one.
SELECT pg_catalog.pg_advisory_xact_lock(1779, 1);
SET LOCAL search_path TO public, pg_temp;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

SELECT NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = 1
) AS apply_initial_schema \gset

\if :apply_initial_schema
    \echo Applying migration 001_initial_schema
    \ir migrations/001_initial_schema.sql
    INSERT INTO schema_migrations (version) VALUES (1);
\else
    \echo Migration 001_initial_schema already applied
\endif

SELECT NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = 2
) AS apply_complete_schema \gset

\if :apply_complete_schema
    \echo Applying migration 002_complete_schema
    \ir migrations/002_complete_schema.sql
    INSERT INTO schema_migrations (version) VALUES (2);
\else
    \echo Migration 002_complete_schema already applied
\endif

COMMIT;
