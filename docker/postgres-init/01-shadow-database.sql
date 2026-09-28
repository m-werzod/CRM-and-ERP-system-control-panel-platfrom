-- Prisma diffs migrations against a scratch database. `migrate dev` needs it;
-- `migrate deploy` (CI/production) does not.
CREATE DATABASE edu_crm_erp_shadow;
