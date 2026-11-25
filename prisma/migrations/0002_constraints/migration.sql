-- Advanced PostgreSQL constraints that Prisma's schema language cannot express.
-- Each block states the requirement it enforces.

-- FR: a student may hold at most ONE active card (database-level, not just application logic).
CREATE UNIQUE INDEX "cards_one_active_per_student"
  ON "cards" ("student_id") WHERE "status" = 'ACTIVE';

-- A student has at most one active hostel allocation.
CREATE UNIQUE INDEX "hostel_allocations_one_active_per_student"
  ON "hostel_allocations" ("student_id") WHERE "active" = true;

-- Active/issued cards must record when they were issued.
ALTER TABLE "cards" ADD CONSTRAINT "cards_active_has_issued_at"
  CHECK ("status" = 'PENDING' OR "issued_at" IS NOT NULL);
ALTER TABLE "cards" ADD CONSTRAINT "cards_uid_format"
  CHECK ("uid_hex" ~ '^[0-9A-F]{14}$');           -- random 7-byte UID
ALTER TABLE "cards" ADD CONSTRAINT "cards_aid_format"
  CHECK ("aid_hex" ~ '^[0-9A-F]{6}$');            -- KIU AID 4B4955
ALTER TABLE "cards" ADD CONSTRAINT "cards_counter_nonneg"
  CHECK ("tx_counter" >= 0);

-- Eligibility facts must be sane.
ALTER TABLE "student_status" ADD CONSTRAINT "student_status_percent_range"
  CHECK ("fees_paid_percent" >= 0 AND "fees_paid_percent" <= 100);
ALTER TABLE "student_status" ADD CONSTRAINT "student_status_nonneg"
  CHECK ("library_overdue_items" >= 0 AND "library_fines_ugx" >= 0);
ALTER TABLE "students" ADD CONSTRAINT "students_year_range"
  CHECK ("year_of_study" BETWEEN 1 AND 7);

-- Exam windows must be coherent.
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_time_order"
  CHECK ("starts_at" < "ends_at" AND "entry_opens_at" <= "entry_closes_at");

-- Offline log uploads must be non-empty.
ALTER TABLE "offline_log_batches" ADD CONSTRAINT "offline_log_batches_nonempty"
  CHECK ("entry_count" > 0);

-- Audit trail is APPEND-ONLY: UPDATE, DELETE and TRUNCATE are rejected for every role.
CREATE FUNCTION audit_trail_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_trail is append-only (% blocked)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_trail_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_trail"
  FOR EACH ROW EXECUTE FUNCTION audit_trail_immutable();
CREATE TRIGGER audit_trail_no_truncate
  BEFORE TRUNCATE ON "audit_trail"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_trail_immutable();

-- Access logs are immutable once written; retention jobs may DELETE expired rows, never edit them.
CREATE FUNCTION access_logs_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'access_logs rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER access_logs_immutable
  BEFORE UPDATE ON "access_logs"
  FOR EACH ROW EXECUTE FUNCTION access_logs_no_update();
