-- Adds the "shared to discovery gallery" flag used by the new
-- GET /api/characters/discover and POST /api/characters/:id/remix routes.
ALTER TABLE "Character" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;

-- Speeds up the discovery gallery query (WHERE "isPublic" = true).
CREATE INDEX "Character_isPublic_idx" ON "Character"("isPublic");
