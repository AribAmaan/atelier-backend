import type { Prisma } from "@prisma/client";

/**
 * Anonymizes a user instead of hard-deleting the row, and removes everything
 * that is "their content". PaymentOrder rows hang off userId with
 * onDelete: Cascade, and financial records must stay retrievable for tax
 * purposes, so the User row (and with it the payment trail) is kept while
 * everything that identifies the person is scrubbed.
 *
 * Shared by the inactivity retention job and DELETE /api/auth/me so both go
 * through the same path. `extraWhere` lets the retention job re-check its
 * inactivity conditions atomically. Returns false if no row was claimed.
 */
export async function anonymizeUserInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  extraWhere: Prisma.UserWhereInput = {}
): Promise<boolean> {
  const claim = await tx.user.updateMany({
    where: { id: userId, deletedAt: null, ...extraWhere },
    data: {
      email: `deleted-${userId}@rolichat.invalid`,
      passwordHash: "DELETED_ACCOUNT",
      displayName: "Deleted user",
      googleId: null,
      username: null,
      highlights: null,
      avatarUrl: null,
      birthdate: new Date("1970-01-01T00:00:00Z"),
      emailVerified: false,
      sparkBalance: 0,
      membershipTier: "free",
      membershipRenewsAt: null,
      deletionWarningSentAt: null,
      deletedAt: new Date(),
    },
  });
  if (claim.count !== 1) return false;
  await tx.message.deleteMany({ where: { userId } });
  await tx.character.deleteMany({ where: { ownerId: userId } });
  await tx.report.deleteMany({ where: { reporterId: userId } });
  await tx.passwordResetToken.deleteMany({ where: { userId } });
  await tx.emailVerificationToken.deleteMany({ where: { userId } });
  return true;
}
