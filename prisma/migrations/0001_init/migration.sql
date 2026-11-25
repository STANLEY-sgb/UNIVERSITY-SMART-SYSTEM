-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('STAFF', 'STUDENT');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "StudentAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED', 'LOST', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('AES_CARD_KEY', 'ED25519_QR');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('VIRTUAL_TAP', 'QR', 'FACE', 'NFC_FUTURE', 'MANUAL_OVERRIDE');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('GRANT', 'DENY');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('ENTRY', 'EXIT', 'NONE');

-- CreateEnum
CREATE TYPE "ReaderStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OfflinePolicy" AS ENUM ('DENY_ALL', 'CACHED_ALLOW');

-- CreateEnum
CREATE TYPE "ExamAttendanceStatus" AS ENUM ('PRESENT', 'REFUSED', 'OVERRIDDEN');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('FINANCE', 'REGISTRY', 'LIBRARY', 'HOSTEL', 'OFFLINE_LOGS', 'CACHE_PUBLISH');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BiometricStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'DELETED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BiometricOutcome" AS ENUM ('MATCH', 'NO_MATCH', 'AMBIGUOUS', 'LIVENESS_FAILED', 'QUALITY_FAILED', 'NOT_ENROLLED', 'CONSENT_REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'RETURNED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_type" "UserType" NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_enc" TEXT,
    "mfa_recovery_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "student_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "rotated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "faculty" TEXT NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programmes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" UUID NOT NULL,
    "duration_years" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "academic_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semesters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "semesters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reg_no" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "photo_ref" TEXT,
    "photo_sha256" TEXT,
    "programme_id" UUID NOT NULL,
    "year_of_study" INTEGER NOT NULL,
    "account_status" "StudentAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_fictional" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_status" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "semester_registered" BOOLEAN NOT NULL DEFAULT false,
    "fees_paid_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "exam_cleared" BOOLEAN NOT NULL DEFAULT false,
    "library_overdue_items" INTEGER NOT NULL DEFAULT 0,
    "library_fines_ugx" INTEGER NOT NULL DEFAULT 0,
    "hostel_fees_paid" BOOLEAN NOT NULL DEFAULT false,
    "meal_plan_active" BOOLEAN NOT NULL DEFAULT false,
    "facts_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "student_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_units" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department_id" UUID NOT NULL,
    "credit_units" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "course_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrolments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "course_unit_id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "capacity" INTEGER,
    "opens_at" TEXT,
    "closes_at" TEXT,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_unit_id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "entry_opens_at" TIMESTAMPTZ(6) NOT NULL,
    "entry_closes_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_seats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "seat_label" TEXT NOT NULL,

    CONSTRAINT "exam_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lecture_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_unit_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "starts_at" TEXT NOT NULL,
    "ends_at" TEXT NOT NULL,

    CONSTRAINT "lecture_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "card_number" TEXT NOT NULL,
    "uid_hex" TEXT NOT NULL,
    "aid_hex" TEXT NOT NULL DEFAULT '4B4955',
    "student_id" UUID NOT NULL,
    "status" "CardStatus" NOT NULL DEFAULT 'PENDING',
    "issued_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "tx_counter" BIGINT NOT NULL DEFAULT 0,
    "reg_no_hash" TEXT NOT NULL,
    "photo_hash" TEXT,
    "issued_by" UUID,
    "replaces_card_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "card_id" UUID NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "public_key_hex" TEXT,
    "secret_enc" TEXT,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "card_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "card_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_revocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "card_id" UUID NOT NULL,
    "version" BIGSERIAL NOT NULL,
    "reason" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" UUID,

    CONSTRAINT "card_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_nonces" (
    "nonce" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "biometric_model_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "is_mock" BOOLEAN NOT NULL DEFAULT true,
    "evaluation" JSONB,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "status" "BiometricStatus" NOT NULL DEFAULT 'PENDING',
    "enrolled_by" UUID,
    "enrolled_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "quality_meta" JSONB,
    "audit_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "model_version_id" UUID NOT NULL,
    "encrypted_template_ref" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "biometric_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "notice_version" TEXT NOT NULL,
    "lawful_basis" TEXT NOT NULL,
    "recorded_by" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reader_id" UUID,
    "student_id" UUID,
    "mode" TEXT NOT NULL,
    "outcome" "BiometricOutcome" NOT NULL,
    "liveness_ok" BOOLEAN,
    "latency_ms" INTEGER,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "biometric_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_revocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "initiated_by" TEXT NOT NULL,
    "actor_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_device_authorizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reader_id" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "biometric_device_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "offline_policy" "OfflinePolicy" NOT NULL DEFAULT 'DENY_ALL',
    "requires_direction" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" TEXT NOT NULL DEFAULT 'NORMAL',

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_id" UUID NOT NULL,
    "published_version_id" UUID,

    CONSTRAINT "access_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_rule_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rule_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "effective_from" TIMESTAMPTZ(6),
    "created_by" UUID,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(6),
    "change_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "service_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "status" "ReaderStatus" NOT NULL DEFAULT 'PENDING',
    "supports_face" BOOLEAN NOT NULL DEFAULT false,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "last_heartbeat_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "readers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reader_id" UUID NOT NULL,
    "key_id" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "reader_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_heartbeats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reader_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "online" BOOLEAN NOT NULL DEFAULT true,
    "queued_logs" INTEGER NOT NULL DEFAULT 0,
    "cache_version" BIGINT,

    CONSTRAINT "reader_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_cache_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reader_id" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "manifest_sig" TEXT NOT NULL,
    "valid_until" TIMESTAMPTZ(6) NOT NULL,
    "revocation_version" BIGINT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_cache_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offline_log_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reader_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "entry_count" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciled_at" TIMESTAMPTZ(6),
    "conflicts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "offline_log_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reader_id" UUID,
    "service_id" UUID,
    "venue_id" UUID,
    "student_id" UUID,
    "card_id" UUID,
    "auth_method" "AuthMethod" NOT NULL,
    "direction" "Direction" NOT NULL DEFAULT 'NONE',
    "decision" "Decision" NOT NULL,
    "reason_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "rule_version_id" UUID,
    "processing_ms" INTEGER,
    "request_nonce" TEXT,
    "idempotency_key" TEXT,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "override_id" UUID,
    "context" JSONB,

    CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_overrides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "reader_id" UUID,
    "actor_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "original_reason_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "reader_id" UUID,
    "student_id" UUID,
    "card_id" UUID,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_at" TIMESTAMPTZ(6),
    "acked_by" UUID,

    CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presence_state" (
    "student_id" UUID NOT NULL,
    "zone" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "presence_state_pkey" PRIMARY KEY ("student_id","zone")
);

-- CreateTable
CREATE TABLE "exam_attendance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "ExamAttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "marked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "access_log_id" UUID,

    CONSTRAINT "exam_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lecture_attendance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schedule_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "held_on" DATE NOT NULL,
    "marked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_loans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "item_ref" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "borrowed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "returned_at" TIMESTAMPTZ(6),
    "fine_ugx" INTEGER NOT NULL DEFAULT 0,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "library_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venue_id" UUID NOT NULL,

    CONSTRAINT "hostels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hostel_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "hostel_id" UUID NOT NULL,
    "room_no" TEXT,
    "semester_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "allocated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hostel_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_sittings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_id" UUID NOT NULL,
    "meal_type" "MealType" NOT NULL,
    "starts_at" TEXT NOT NULL,
    "ends_at" TEXT NOT NULL,

    CONSTRAINT "meal_sittings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "sitting_id" UUID NOT NULL,
    "served_on" DATE NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "access_log_id" UUID,

    CONSTRAINT "meal_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "uses_left" INTEGER,

    CONSTRAINT "service_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "graduation_clearances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "department" TEXT NOT NULL,
    "cleared" BOOLEAN NOT NULL DEFAULT false,
    "cleared_at" TIMESTAMPTZ(6),
    "note" TEXT,

    CONSTRAINT "graduation_clearances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "SyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "file_sha256" TEXT,
    "idempotency_key" TEXT,
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "rows_ok" INTEGER NOT NULL DEFAULT 0,
    "rows_failed" INTEGER NOT NULL DEFAULT 0,
    "error_report" JSONB,
    "started_by" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "student_id" UUID,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_trail" (
    "seq" BIGSERIAL NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "request_meta" JSONB,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_trail_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "note" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_student_id_key" ON "users"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "programmes_code_key" ON "programmes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "academic_sessions_code_key" ON "academic_sessions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "semesters_session_id_number_key" ON "semesters"("session_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "students_reg_no_key" ON "students"("reg_no");

-- CreateIndex
CREATE INDEX "students_programme_id_idx" ON "students"("programme_id");

-- CreateIndex
CREATE INDEX "students_full_name_idx" ON "students"("full_name");

-- CreateIndex
CREATE UNIQUE INDEX "student_status_student_id_semester_id_key" ON "student_status"("student_id", "semester_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_units_code_key" ON "course_units"("code");

-- CreateIndex
CREATE INDEX "enrolments_course_unit_id_semester_id_idx" ON "enrolments"("course_unit_id", "semester_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrolments_student_id_course_unit_id_semester_id_key" ON "enrolments"("student_id", "course_unit_id", "semester_id");

-- CreateIndex
CREATE UNIQUE INDEX "venues_code_key" ON "venues"("code");

-- CreateIndex
CREATE INDEX "exam_sessions_venue_id_starts_at_idx" ON "exam_sessions"("venue_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "exam_seats_exam_session_id_student_id_key" ON "exam_seats"("exam_session_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_seats_exam_session_id_seat_label_key" ON "exam_seats"("exam_session_id", "seat_label");

-- CreateIndex
CREATE UNIQUE INDEX "cards_card_number_key" ON "cards"("card_number");

-- CreateIndex
CREATE UNIQUE INDEX "cards_uid_hex_key" ON "cards"("uid_hex");

-- CreateIndex
CREATE UNIQUE INDEX "cards_replaces_card_id_key" ON "cards"("replaces_card_id");

-- CreateIndex
CREATE INDEX "cards_student_id_status_idx" ON "cards"("student_id", "status");

-- CreateIndex
CREATE INDEX "card_credentials_card_id_kind_status_idx" ON "card_credentials"("card_id", "kind", "status");

-- CreateIndex
CREATE INDEX "card_events_card_id_at_idx" ON "card_events"("card_id", "at");

-- CreateIndex
CREATE INDEX "card_revocations_version_idx" ON "card_revocations"("version");

-- CreateIndex
CREATE INDEX "credential_nonces_expires_at_idx" ON "credential_nonces"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_model_versions_name_version_key" ON "biometric_model_versions"("name", "version");

-- CreateIndex
CREATE INDEX "biometric_enrollments_student_id_status_idx" ON "biometric_enrollments"("student_id", "status");

-- CreateIndex
CREATE INDEX "biometric_consents_enrollment_id_at_idx" ON "biometric_consents"("enrollment_id", "at");

-- CreateIndex
CREATE INDEX "biometric_attempts_at_idx" ON "biometric_attempts"("at");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_policies_key_key" ON "biometric_policies"("key");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_device_authorizations_reader_id_key" ON "biometric_device_authorizations"("reader_id");

-- CreateIndex
CREATE UNIQUE INDEX "services_code_key" ON "services"("code");

-- CreateIndex
CREATE UNIQUE INDEX "access_rules_service_id_key" ON "access_rules"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_rules_published_version_id_key" ON "access_rules"("published_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_rule_versions_rule_id_version_key" ON "access_rule_versions"("rule_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "readers_code_key" ON "readers"("code");

-- CreateIndex
CREATE INDEX "readers_service_id_venue_id_idx" ON "readers"("service_id", "venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "reader_credentials_key_id_key" ON "reader_credentials"("key_id");

-- CreateIndex
CREATE INDEX "reader_credentials_reader_id_idx" ON "reader_credentials"("reader_id");

-- CreateIndex
CREATE INDEX "reader_heartbeats_reader_id_at_idx" ON "reader_heartbeats"("reader_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "reader_cache_versions_reader_id_version_key" ON "reader_cache_versions"("reader_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "offline_log_batches_idempotency_key_key" ON "offline_log_batches"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "access_logs_idempotency_key_key" ON "access_logs"("idempotency_key");

-- CreateIndex
CREATE INDEX "access_logs_reader_id_occurred_at_idx" ON "access_logs"("reader_id", "occurred_at");

-- CreateIndex
CREATE INDEX "access_logs_card_id_occurred_at_idx" ON "access_logs"("card_id", "occurred_at");

-- CreateIndex
CREATE INDEX "access_logs_student_id_occurred_at_idx" ON "access_logs"("student_id", "occurred_at");

-- CreateIndex
CREATE INDEX "access_logs_occurred_at_idx" ON "access_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "access_overrides_student_id_created_at_idx" ON "access_overrides"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "security_alerts_created_at_idx" ON "security_alerts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "exam_attendance_exam_session_id_student_id_key" ON "exam_attendance"("exam_session_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "lecture_attendance_schedule_id_student_id_held_on_key" ON "lecture_attendance"("schedule_id", "student_id", "held_on");

-- CreateIndex
CREATE INDEX "library_loans_student_id_status_idx" ON "library_loans"("student_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hostels_code_key" ON "hostels"("code");

-- CreateIndex
CREATE INDEX "hostel_allocations_student_id_active_idx" ON "hostel_allocations"("student_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "meal_sittings_service_id_meal_type_key" ON "meal_sittings"("service_id", "meal_type");

-- CreateIndex
CREATE UNIQUE INDEX "meal_usage_student_id_sitting_id_served_on_key" ON "meal_usage"("student_id", "sitting_id", "served_on");

-- CreateIndex
CREATE INDEX "service_memberships_student_id_service_id_idx" ON "service_memberships"("student_id", "service_id");

-- CreateIndex
CREATE UNIQUE INDEX "graduation_clearances_student_id_department_key" ON "graduation_clearances"("student_id", "department");

-- CreateIndex
CREATE UNIQUE INDEX "sync_jobs_idempotency_key_key" ON "sync_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "sync_jobs_kind_started_at_idx" ON "sync_jobs"("kind", "started_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_trail_id_key" ON "audit_trail"("id");

-- CreateIndex
CREATE INDEX "audit_trail_entity_type_entity_id_idx" ON "audit_trail"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_trail_actor_id_at_idx" ON "audit_trail"("actor_id", "at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programmes" ADD CONSTRAINT "programmes_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semesters" ADD CONSTRAINT "semesters_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "academic_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_status" ADD CONSTRAINT "student_status_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_status" ADD CONSTRAINT "student_status_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_units" ADD CONSTRAINT "course_units_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_course_unit_id_fkey" FOREIGN KEY ("course_unit_id") REFERENCES "course_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_course_unit_id_fkey" FOREIGN KEY ("course_unit_id") REFERENCES "course_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_seats" ADD CONSTRAINT "exam_seats_exam_session_id_fkey" FOREIGN KEY ("exam_session_id") REFERENCES "exam_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecture_schedules" ADD CONSTRAINT "lecture_schedules_course_unit_id_fkey" FOREIGN KEY ("course_unit_id") REFERENCES "course_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecture_schedules" ADD CONSTRAINT "lecture_schedules_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_replaces_card_id_fkey" FOREIGN KEY ("replaces_card_id") REFERENCES "cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_credentials" ADD CONSTRAINT "card_credentials_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_revocations" ADD CONSTRAINT "card_revocations_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrollments" ADD CONSTRAINT "biometric_enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_templates" ADD CONSTRAINT "biometric_templates_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "biometric_enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_templates" ADD CONSTRAINT "biometric_templates_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "biometric_model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_consents" ADD CONSTRAINT "biometric_consents_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "biometric_enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_attempts" ADD CONSTRAINT "biometric_attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_revocations" ADD CONSTRAINT "biometric_revocations_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "biometric_enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_device_authorizations" ADD CONSTRAINT "biometric_device_authorizations_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "readers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "access_rule_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_rule_versions" ADD CONSTRAINT "access_rule_versions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "access_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readers" ADD CONSTRAINT "readers_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "readers" ADD CONSTRAINT "readers_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_credentials" ADD CONSTRAINT "reader_credentials_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "readers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_heartbeats" ADD CONSTRAINT "reader_heartbeats_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "readers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_cache_versions" ADD CONSTRAINT "reader_cache_versions_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "readers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_log_batches" ADD CONSTRAINT "offline_log_batches_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "readers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "readers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "access_rule_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_overrides" ADD CONSTRAINT "access_overrides_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "readers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presence_state" ADD CONSTRAINT "presence_state_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attendance" ADD CONSTRAINT "exam_attendance_exam_session_id_fkey" FOREIGN KEY ("exam_session_id") REFERENCES "exam_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_attendance" ADD CONSTRAINT "exam_attendance_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecture_attendance" ADD CONSTRAINT "lecture_attendance_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "lecture_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecture_attendance" ADD CONSTRAINT "lecture_attendance_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostels" ADD CONSTRAINT "hostels_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_allocations" ADD CONSTRAINT "hostel_allocations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hostel_allocations" ADD CONSTRAINT "hostel_allocations_hostel_id_fkey" FOREIGN KEY ("hostel_id") REFERENCES "hostels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_sittings" ADD CONSTRAINT "meal_sittings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_usage" ADD CONSTRAINT "meal_usage_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_usage" ADD CONSTRAINT "meal_usage_sitting_id_fkey" FOREIGN KEY ("sitting_id") REFERENCES "meal_sittings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_memberships" ADD CONSTRAINT "service_memberships_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_memberships" ADD CONSTRAINT "service_memberships_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graduation_clearances" ADD CONSTRAINT "graduation_clearances_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

