-- Card wallet activation (one-time code, hash only) and AES tap sessions.
ALTER TABLE "cards" ADD COLUMN "activation_hash" TEXT,
                    ADD COLUMN "activation_expires_at" TIMESTAMPTZ(6),
                    ADD COLUMN "activated_at" TIMESTAMPTZ(6);
CREATE UNIQUE INDEX "cards_activation_hash_key" ON "cards"("activation_hash");

CREATE TABLE "tap_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reader_id" UUID NOT NULL,
    "card_id" UUID,
    "uid_hex" TEXT NOT NULL,
    "rnd_r" TEXT NOT NULL,
    "rnd_c" TEXT,
    "state" TEXT NOT NULL DEFAULT 'BEGUN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "tap_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tap_sessions_state_valid" CHECK ("state" IN ('BEGUN','AUTHENTICATED','USED','FAILED'))
);
CREATE INDEX "tap_sessions_expires_at_idx" ON "tap_sessions"("expires_at");
