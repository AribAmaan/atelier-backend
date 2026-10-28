-- A memory reset must exclude previously folded messages from later semantic
-- callbacks while leaving the visible conversation history intact.
ALTER TABLE `Character`
  ADD COLUMN `recallAfterCreatedAt` DATETIME(3) NULL,
  ADD COLUMN `recallAfterId` VARCHAR(191) NOT NULL DEFAULT '';
