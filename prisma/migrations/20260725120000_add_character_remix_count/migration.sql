-- Adds the "remix popularity" counter used to rank the Discover gallery
-- and to show a popularity badge on remixed characters.
ALTER TABLE "Character" ADD COLUMN "remixCount" INTEGER NOT NULL DEFAULT 0;

-- Speeds up the discovery gallery query (ORDER BY "remixCount" DESC).
CREATE INDEX "Character_remixCount_idx" ON "Character"("remixCount");
