-- Ultra and Supreme were retired: Plus is the only paid plan and includes every
-- engine. Existing paid accounts keep their access (and renewal date) as Plus.
-- The application also treats any leftover 'ultra'/'supreme' value as Plus, so
-- this is a cleanup, safe to run more than once.
UPDATE `User`
SET `membershipTier` = 'plus'
WHERE `membershipTier` IN ('ultra', 'supreme');
