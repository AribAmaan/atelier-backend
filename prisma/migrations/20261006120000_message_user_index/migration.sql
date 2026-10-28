-- GET /api/characters aggregates Message rows filtered by userId first. The
-- existing indexes both lead with characterId, so that query scanned.
CREATE INDEX `Message_userId_characterId_createdAt_idx` ON `Message`(`userId`, `characterId`, `createdAt`);
