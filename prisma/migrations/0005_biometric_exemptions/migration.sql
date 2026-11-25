-- Face enrolment became compulsory by institutional decision (docs/DECISIONS.md D-039). A compulsory biometric
-- requirement needs a way out for people who cannot or must not use it (disability, objection, safeguarding): an
-- exemption lets that student keep using the card and QR code without enrolling. One live exemption per student.
CREATE TABLE "biometric_exemptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    CONSTRAINT "biometric_exemptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "biometric_exemptions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "biometric_exemptions_student_id_key" ON "biometric_exemptions"("student_id");
