-- ---------------------------------------------------------------------------
-- Integrity guarantees, append-only guards and search indexes.
--
-- Everything here is deliberately hand-written SQL: it expresses constraints
-- Prisma's schema language cannot (partial unique indexes, CHECK constraints,
-- triggers, trigram indexes). Prisma is told to keep this migration as-is and
-- never regenerates it.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Extensions
-- ===========================================================================

-- Trigram matching powers the global search box: "sher" finds "Sherzod" with an
-- index, instead of a sequential scan with LIKE '%sher%'.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Accent-insensitive comparison so "Nodira" matches "Nodirà".
CREATE EXTENSION IF NOT EXISTS unaccent;


-- ===========================================================================
-- 2. Partial unique indexes
--
-- These express "at most one CURRENT x" rules. A plain @@unique cannot: it
-- would forbid the historical rows we deliberately keep.
-- ===========================================================================

-- A student may hold many enrollment rows for the same group over time, but only
-- ONE may be open. This is the database-level guarantee behind
-- TransferStudent / EnrollStudent; without it, a concurrent double-submit could
-- open two active enrollments and double-bill the student.
CREATE UNIQUE INDEX "enrollments_one_open_per_student_group"
  ON "enrollments" ("studentId", "groupId")
  WHERE "endDate" IS NULL;

-- One primary guardian per student.
CREATE UNIQUE INDEX "student_guardians_one_primary_per_student"
  ON "student_guardians" ("studentId")
  WHERE "isPrimary";

-- One primary branch per user.
CREATE UNIQUE INDEX "user_branches_one_primary_per_user"
  ON "user_branches" ("userId")
  WHERE "isPrimary";

-- One current academic year per organisation, and one current term per year.
CREATE UNIQUE INDEX "academic_years_one_current_per_org"
  ON "academic_years" ("organizationId")
  WHERE "isCurrent";

CREATE UNIQUE INDEX "terms_one_current_per_year"
  ON "terms" ("academicYearId")
  WHERE "isCurrent";

-- One default grading scale, and one default tax rate, per organisation.
CREATE UNIQUE INDEX "grading_scales_one_default_per_org"
  ON "grading_scales" ("organizationId")
  WHERE "isDefault";

CREATE UNIQUE INDEX "tax_rates_one_default_per_org"
  ON "tax_rates" ("organizationId")
  WHERE "isDefault";

-- One open teacher assignment per (group, role): a group cannot have two
-- current primary teachers, though it keeps every past assignment.
CREATE UNIQUE INDEX "group_teachers_one_open_per_group_role"
  ON "group_teachers" ("groupId", "role")
  WHERE "endDate" IS NULL;

-- One active fee plan per (student, fee plan, group) at a time.
CREATE UNIQUE INDEX "student_fee_plans_one_open_per_student_plan"
  ON "student_fee_plans" ("studentId", "feePlanId")
  WHERE "endDate" IS NULL;

-- Codes and numbers must be unique among LIVE rows only; a soft-deleted student
-- must not permanently consume its student code.
CREATE UNIQUE INDEX "students_live_code_unique"
  ON "students" ("organizationId", "studentCode")
  WHERE "deletedAt" IS NULL;


-- ===========================================================================
-- 3. CHECK constraints
--
-- Business invariants that must hold no matter which code path writes the row.
-- The service layer validates these too, with friendly messages; these exist so
-- a bug, a migration script or a manual psql session cannot corrupt the data.
-- ===========================================================================

-- --- Money: amounts are non-negative; direction/type carries the sign. -------
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_amounts_non_negative" CHECK (
    "subtotalMinor" >= 0 AND "discountTotalMinor" >= 0 AND "taxTotalMinor" >= 0
    AND "totalMinor" >= 0 AND "paidTotalMinor" >= 0 AND "refundedTotalMinor" >= 0
    AND "writtenOffMinor" >= 0
  );

-- The derived balance must always equal the ledger-derived identity. Enforcing
-- it here means a recalculation bug fails loudly at write time rather than
-- quietly producing a wrong debt report.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_balance_identity" CHECK (
    "balanceMinor" = "totalMinor" - "paidTotalMinor" - "writtenOffMinor" + "refundedTotalMinor"
  );

ALTER TABLE "invoice_items"
  ADD CONSTRAINT "invoice_items_sane" CHECK (
    "quantity" > 0 AND "unitPriceMinor" >= 0 AND "discountMinor" >= 0
    AND "taxRatePpm" >= 0 AND "taxRatePpm" <= 1000000
  );

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amountMinor" > 0);

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_amount_positive" CHECK ("amountMinor" > 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amountMinor" > 0);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_non_negative" CHECK ("amountMinor" >= 0);

ALTER TABLE "student_credits"
  ADD CONSTRAINT "student_credits_balance_within_amount" CHECK (
    "amountMinor" > 0 AND "balanceMinor" >= 0 AND "balanceMinor" <= "amountMinor"
  );

ALTER TABLE "fee_plans"
  ADD CONSTRAINT "fee_plans_amount_non_negative" CHECK (
    "amountMinor" >= 0 AND "dueDaysAfterIssue" >= 0
    AND ("installmentCount" IS NULL OR "installmentCount" > 0)
  );

ALTER TABLE "student_fee_plans"
  ADD CONSTRAINT "student_fee_plans_amount_non_negative" CHECK ("amountMinor" >= 0);

-- A discount carries exactly the value field its type implies.
ALTER TABLE "discounts"
  ADD CONSTRAINT "discounts_value_matches_type" CHECK (
    ("type" = 'PERCENT' AND "percentPpm" IS NOT NULL AND "amountMinor" IS NULL
      AND "percentPpm" > 0 AND "percentPpm" <= 1000000)
    OR ("type" IN ('FIXED', 'SCHOLARSHIP') AND "amountMinor" IS NOT NULL
      AND "percentPpm" IS NULL AND "amountMinor" > 0)
  );

ALTER TABLE "payment_schedule_installments"
  ADD CONSTRAINT "installments_amount_positive" CHECK ("amountMinor" > 0 AND "sequence" > 0);

ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_ppm_range" CHECK ("ratePpm" >= 0 AND "ratePpm" <= 1000000);

-- --- Dates: intervals must not run backwards. ------------------------------
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_dates_ordered" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "group_teachers"
  ADD CONSTRAINT "group_teachers_dates_ordered" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "student_fee_plans"
  ADD CONSTRAINT "student_fee_plans_dates_ordered" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "salary_components"
  ADD CONSTRAINT "salary_components_dates_ordered" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_dates_ordered" CHECK ("endDate" >= "startDate" AND "days" > 0);

ALTER TABLE "academic_years"
  ADD CONSTRAINT "academic_years_dates_ordered" CHECK ("endDate" > "startDate");

ALTER TABLE "terms"
  ADD CONSTRAINT "terms_dates_ordered" CHECK ("endDate" > "startDate" AND "sequence" > 0);

ALTER TABLE "payroll_runs"
  ADD CONSTRAINT "payroll_runs_period_ordered" CHECK ("periodEnd" >= "periodStart");

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_period_ordered" CHECK (
    ("periodStart" IS NULL AND "periodEnd" IS NULL)
    OR ("periodStart" IS NOT NULL AND "periodEnd" IS NOT NULL AND "periodEnd" >= "periodStart")
  );

ALTER TABLE "lessons"
  ADD CONSTRAINT "lessons_times_ordered" CHECK ("endsAt" > "startsAt");

-- --- Scheduling: wall-clock minutes stay inside a day and run forwards. -----
ALTER TABLE "schedule_slots"
  ADD CONSTRAINT "schedule_slots_minutes_valid" CHECK (
    "startMinute" >= 0 AND "startMinute" < 1440
    AND "endMinute" > "startMinute" AND "endMinute" <= 1440
  );

ALTER TABLE "schedule_slots"
  ADD CONSTRAINT "schedule_slots_dates_ordered" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

-- --- Attendance ------------------------------------------------------------
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_sane" CHECK (
    ("minutesLate" IS NULL OR "minutesLate" >= 0)
    AND ("confidencePpm" IS NULL OR ("confidencePpm" >= 0 AND "confidencePpm" <= 1000000))
    -- Only a LATE record may carry a positive lateness.
    AND ("status" = 'LATE' OR COALESCE("minutesLate", 0) = 0)
  );

ALTER TABLE "employee_attendances"
  ADD CONSTRAINT "employee_attendances_sane" CHECK (
    "minutesLate" >= 0 AND "overtimeMinutes" >= 0
    AND ("workedMinutes" IS NULL OR "workedMinutes" >= 0)
    AND ("checkOutAt" IS NULL OR "checkInAt" IS NULL OR "checkOutAt" >= "checkInAt")
  );

-- An attendance correction that changes nothing is a no-op that would pollute
-- the audit trail.
ALTER TABLE "attendance_corrections"
  ADD CONSTRAINT "attendance_corrections_actually_change" CHECK (
    "previousStatus" <> "newStatus"
    OR COALESCE("previousMinutesLate", -1) <> COALESCE("newMinutesLate", -1)
  );

-- --- Assessment ------------------------------------------------------------
ALTER TABLE "exams"
  ADD CONSTRAINT "exams_scores_sane" CHECK (
    "maxScore" > 0 AND "passingScore" >= 0 AND "passingScore" <= "maxScore"
    AND "durationMinutes" > 0
    AND "weightPpm" >= 0 AND "weightPpm" <= 1000000
  );

ALTER TABLE "exam_results"
  ADD CONSTRAINT "exam_results_score_in_range" CHECK (
    "maxScore" > 0
    AND ("score" IS NULL OR ("score" >= 0 AND "score" <= "maxScore"))
    -- An absent student has no score.
    AND (NOT "isAbsent" OR "score" IS NULL)
  );

ALTER TABLE "grades"
  ADD CONSTRAINT "grades_score_in_range" CHECK (
    "maxScore" > 0 AND "score" >= 0 AND "score" <= "maxScore"
    AND "weightPpm" >= 0 AND "weightPpm" <= 1000000
  );

ALTER TABLE "homework_submissions"
  ADD CONSTRAINT "homework_submissions_score_in_range" CHECK (
    ("score" IS NULL AND "maxScore" IS NULL)
    OR ("maxScore" IS NOT NULL AND "maxScore" > 0
        AND ("score" IS NULL OR ("score" >= 0 AND "score" <= "maxScore")))
  );

ALTER TABLE "grading_scale_bands"
  ADD CONSTRAINT "grading_scale_bands_range_valid" CHECK (
    "minPercentPpm" >= 0 AND "maxPercentPpm" <= 1000000
    AND "maxPercentPpm" >= "minPercentPpm"
  );

-- --- Rooms / capacity ------------------------------------------------------
ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_capacity_positive" CHECK ("capacity" > 0);

ALTER TABLE "groups"
  ADD CONSTRAINT "groups_capacity_positive" CHECK (
    "capacity" > 0
    AND ("endDate" IS NULL OR "startDate" IS NULL OR "endDate" >= "startDate")
    -- A group's assistant cannot also be its primary teacher.
    AND ("assistantTeacherId" IS NULL OR "assistantTeacherId" <> "primaryTeacherId")
  );

-- --- Exactly-one-recipient / exactly-one-owner polymorphic guards ----------

-- A notification targets exactly one recipient.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_single_recipient" CHECK (
    (("recipientUserId" IS NOT NULL)::int
     + ("recipientGuardianId" IS NOT NULL)::int
     + ("recipientStudentId" IS NOT NULL)::int) = 1
  );

-- A notification preference belongs to exactly one subject.
ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_single_subject" CHECK (
    (("userId" IS NOT NULL)::int + ("guardianId" IS NOT NULL)::int) = 1
  );

-- A biometric enrollment points at exactly one person, and that person's type
-- matches the discriminator.
ALTER TABLE "biometric_enrollments"
  ADD CONSTRAINT "biometric_enrollments_subject_consistent" CHECK (
    ("subjectType" = 'STUDENT' AND "studentId" IS NOT NULL AND "employeeId" IS NULL)
    OR ("subjectType" = 'EMPLOYEE' AND "employeeId" IS NOT NULL AND "studentId" IS NULL)
  );

-- A document has exactly one owner, and the owner matches ownerType.
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_single_owner" CHECK (
    (("studentId" IS NOT NULL)::int
     + ("guardianId" IS NOT NULL)::int
     + ("employeeId" IS NOT NULL)::int
     + ("applicationId" IS NOT NULL)::int
     + ("invoiceId" IS NOT NULL)::int
     + ("leadId" IS NOT NULL)::int
     + ("groupId" IS NOT NULL)::int
     + ("homeworkId" IS NOT NULL)::int
     + ("homeworkSubmissionId" IS NOT NULL)::int
     + ("certificateId" IS NOT NULL)::int
     + ("leaveRequestId" IS NOT NULL)::int
     + ("announcementId" IS NOT NULL)::int)
    = (CASE WHEN "ownerType" = 'ORGANIZATION' THEN 0 ELSE 1 END)
  );

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_owner_type_matches" CHECK (
    ("ownerType" <> 'STUDENT' OR "studentId" IS NOT NULL)
    AND ("ownerType" <> 'GUARDIAN' OR "guardianId" IS NOT NULL)
    AND ("ownerType" <> 'EMPLOYEE' OR "employeeId" IS NOT NULL)
    AND ("ownerType" <> 'APPLICATION' OR "applicationId" IS NOT NULL)
    AND ("ownerType" <> 'INVOICE' OR "invoiceId" IS NOT NULL)
    AND ("ownerType" <> 'LEAD' OR "leadId" IS NOT NULL)
    AND ("ownerType" <> 'GROUP' OR "groupId" IS NOT NULL)
    AND ("ownerType" <> 'HOMEWORK' OR "homeworkId" IS NOT NULL)
    AND ("ownerType" <> 'HOMEWORK_SUBMISSION' OR "homeworkSubmissionId" IS NOT NULL)
    AND ("ownerType" <> 'CERTIFICATE' OR "certificateId" IS NOT NULL)
    AND ("ownerType" <> 'LEAVE_REQUEST' OR "leaveRequestId" IS NOT NULL)
    AND ("ownerType" <> 'ANNOUNCEMENT' OR "announcementId" IS NOT NULL)
  );

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_size_positive" CHECK ("sizeBytes" > 0);

-- A financial adjustment must name what it adjusts.
ALTER TABLE "financial_adjustments"
  ADD CONSTRAINT "financial_adjustments_has_subject" CHECK (
    "studentId" IS NOT NULL OR "invoiceId" IS NOT NULL
  );

-- A follow-up task must be about a lead or a student.
ALTER TABLE "follow_up_tasks"
  ADD CONSTRAINT "follow_up_tasks_has_subject" CHECK (
    "leadId" IS NOT NULL OR "studentId" IS NOT NULL
  );

-- A user cannot be their own role granter, and a lead cannot be its own duplicate.
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_not_own_duplicate" CHECK ("duplicateOfLeadId" IS NULL OR "duplicateOfLeadId" <> "id");

ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_not_own_transfer" CHECK ("transferredToId" IS NULL OR "transferredToId" <> "id");

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_not_own_reversal" CHECK ("reversalOfId" IS NULL OR "reversalOfId" <> "id");

-- Currency codes are ISO-4217 alpha-3, upper case.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_currency_format" CHECK ("defaultCurrency" ~ '^[A-Z]{3}$');


-- ===========================================================================
-- 4. Append-only guards
--
-- `ledger_entries` and `audit_logs` are the two tables whose whole value rests
-- on being immutable. Application code has no UPDATE/DELETE path for either,
-- but "we promise not to" is not an integrity guarantee -- a future refactor, a
-- migration script or a manual session could still rewrite financial history.
--
-- The guard blocks UPDATE and DELETE unless the session explicitly opts out
-- with `SET LOCAL app.allow_history_mutation = 'on'`. That escape hatch exists
-- for exactly two operations, both documented in docs/DATABASE.md:
--   * purging a tenant (hard-deleting an Organization cascades into these tables)
--   * test teardown
-- Because it is SET LOCAL, the permission dies with the transaction, and any use
-- of it is visible in the code that sets it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION "append_only_guard"() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    '% on %.% is not permitted: this table is append-only. Record a compensating row instead (see docs/DATABASE.md).',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION "append_only_guard"() IS
  'Blocks UPDATE/DELETE on append-only tables unless app.allow_history_mutation is set to ''on'' for the current transaction.';

CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

CREATE TRIGGER "attendance_corrections_append_only"
  BEFORE UPDATE OR DELETE ON "attendance_corrections"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();


-- ===========================================================================
-- 5. Search indexes
--
-- Global search hits students, guardians, leads, employees, groups, invoices and
-- payments. Names use trigram GIN indexes so an infix match ("zod" -> "Sherzod")
-- is index-backed; identifiers and phone numbers use plain btree because search
-- against them is a prefix or exact match.
-- ===========================================================================

-- Immutable accent-and-case-folding helper. Marked IMMUTABLE so it can be used
-- in an index expression; `unaccent()` itself is only STABLE because its
-- dictionary is a configurable object, but we always call it with the default
-- dictionary, which does not change at runtime.
CREATE OR REPLACE FUNCTION "search_normalize"(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, value)) $$;

COMMENT ON FUNCTION "search_normalize"(text) IS
  'Lower-cases and strips accents for search indexes. IMMUTABLE by construction: always uses the default unaccent dictionary.';

CREATE INDEX "students_name_trgm"
  ON "students" USING gin ("search_normalize"("firstName" || ' ' || "lastName") gin_trgm_ops);

CREATE INDEX "students_code_trgm"
  ON "students" USING gin ("search_normalize"("studentCode") gin_trgm_ops);

CREATE INDEX "guardians_name_trgm"
  ON "guardians" USING gin ("search_normalize"("firstName" || ' ' || "lastName") gin_trgm_ops);

CREATE INDEX "leads_name_trgm"
  ON "leads" USING gin ("search_normalize"("firstName" || ' ' || COALESCE("lastName", '')) gin_trgm_ops);

CREATE INDEX "users_name_trgm"
  ON "users" USING gin ("search_normalize"("firstName" || ' ' || "lastName") gin_trgm_ops);

CREATE INDEX "groups_name_trgm"
  ON "groups" USING gin ("search_normalize"("name") gin_trgm_ops);

CREATE INDEX "invoices_number_trgm"
  ON "invoices" USING gin ("invoiceNumber" gin_trgm_ops);

CREATE INDEX "payments_number_trgm"
  ON "payments" USING gin ("paymentNumber" gin_trgm_ops);

-- Phone search is a suffix match in practice ("last four digits"), so index the
-- reversed normalised number and query with a prefix.
CREATE INDEX "students_phone_reversed"
  ON "students" (reverse("phoneNormalized")) WHERE "phoneNormalized" IS NOT NULL;

CREATE INDEX "guardians_phone_reversed"
  ON "guardians" (reverse("phoneNormalized")) WHERE "phoneNormalized" IS NOT NULL;

CREATE INDEX "leads_phone_reversed"
  ON "leads" (reverse("phoneNormalized"));


-- ===========================================================================
-- 6. Operational indexes that Prisma's @@index cannot express
-- ===========================================================================

-- The queue claim query only ever looks at runnable jobs; a partial index keeps
-- it small no matter how much completed history accumulates.
CREATE INDEX "jobs_runnable"
  ON "jobs" ("runAt", "priority" DESC)
  WHERE "status" = 'PENDING';

-- Debt reporting scans only invoices that still owe money.
CREATE INDEX "invoices_outstanding"
  ON "invoices" ("organizationId", "dueDate")
  WHERE "balanceMinor" > 0 AND "status" NOT IN ('CANCELLED', 'VOID', 'WRITTEN_OFF');

-- Notification dispatch scans only undelivered rows.
CREATE INDEX "notifications_dispatchable"
  ON "notifications" ("channel", "createdAt")
  WHERE "status" IN ('PENDING', 'QUEUED');

-- Follow-up dashboards care only about open tasks.
CREATE INDEX "follow_up_tasks_open"
  ON "follow_up_tasks" ("organizationId", "assignedToUserId", "dueAt")
  WHERE "status" = 'OPEN';

-- Soft-delete-aware listing indexes: every list screen filters deletedAt IS NULL.
CREATE INDEX "students_live_listing"
  ON "students" ("organizationId", "branchId", "status", "lastName")
  WHERE "deletedAt" IS NULL;

CREATE INDEX "leads_live_pipeline"
  ON "leads" ("organizationId", "status", "createdAt" DESC)
  WHERE "deletedAt" IS NULL;
