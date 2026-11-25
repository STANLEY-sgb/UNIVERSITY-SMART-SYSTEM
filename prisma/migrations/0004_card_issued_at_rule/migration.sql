-- Correction to 0002: only ACTIVE cards must carry issued_at. A card that was never activated may legitimately
-- become EXPIRED (superseded by a newer request) or LOST (reported before activation) without ever being issued.
ALTER TABLE "cards" DROP CONSTRAINT "cards_active_has_issued_at";
ALTER TABLE "cards" ADD CONSTRAINT "cards_active_has_issued_at"
  CHECK ("status" <> 'ACTIVE' OR "issued_at" IS NOT NULL);
