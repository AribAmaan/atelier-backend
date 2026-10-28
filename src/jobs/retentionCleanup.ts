import { prisma } from "../lib/db";
import { sendMail } from "../lib/mailer";
import { anonymizeUserInTx } from "../lib/accountDeletion";

// Inactivity data-retention policy:
//   - No activity for WARNING_AFTER_DAYS  -> warning email, one time
//   - No activity for DELETE_AFTER_DAYS   -> account anonymized + owned
//                                            content deleted
//
// We anonymize rather than hard-delete the User row. PaymentOrder rows
// (Razorpay transactions) hang off userId and Indian tax law expects
// financial records to be retrievable for several years after the fact —
// hard-deleting the user would cascade-delete those too (see the
// onDelete: Cascade on PaymentOrder.user). Anonymizing keeps the User row
// (and therefore the payment trail) intact while scrubbing everything that
// identifies the person and deleting everything that's "their content"
// rather than "a financial record".
//
// If your business/legal read is different (e.g. you don't need the payment
// trail, or you want a harder delete), the one-line change is to swap the
// prisma.user.update(...) below for prisma.user.delete(...) — but talk to
// whoever owns compliance/finance before doing that.

const WARNING_AFTER_DAYS = 335; // ~11 months
const NOTICE_DAYS = 30;
const DELETE_AFTER_DAYS = 365; // 1 year

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }

async function sendInactivityWarnings(frontendUrl: string) {
  const candidates = await prisma.user.findMany({
    where: {
      deletedAt: null,
      deletionWarningSentAt: null,
      lastActiveAt: { lt: daysAgo(WARNING_AFTER_DAYS) },
    },
    select: { id: true, email: true, displayName: true },
  });

  let completed = 0;
  for (const user of candidates) {
    try {
      const sent = await sendMail(
        user.email,
        "Your Rolichat account will be deleted in 30 days due to inactivity",
        `<p>Hi ${escapeHtml(user.displayName)},</p>
         <p>We haven't seen you on Rolichat in a while. To keep your account, characters, and
         chat history, just log in any time in the next 30 days: <a href="${frontendUrl}">${frontendUrl}</a></p>
         <p>If we don't hear from you, your account and data will be permanently removed
         (this cannot be undone).</p>`,
        `Hi ${user.displayName}, your Rolichat account has been inactive and will be deleted in 30 days ` +
          `unless you log in: ${frontendUrl}`
      );
      if (!sent.delivered) continue;
      const claimed = await prisma.user.updateMany({
        where: { id: user.id, deletedAt: null, lastActiveAt: { lt: daysAgo(WARNING_AFTER_DAYS) }, deletionWarningSentAt: null },
        data: { deletionWarningSentAt: new Date() },
      });
      completed += claimed.count;
    } catch (err) {
      console.error(`[retention] failed to send warning to user ${user.id}`, err);
    }
  }

  return completed;
}

async function anonymizeInactiveAccounts() {
  const candidates = await prisma.user.findMany({
    where: {
      deletedAt: null,
      lastActiveAt: { lt: daysAgo(DELETE_AFTER_DAYS) },
      deletionWarningSentAt: { lte: daysAgo(NOTICE_DAYS) },
    },
    select: { id: true },
  });

  let completed = 0;
  for (const user of candidates) {
    try {
      // Atomically recheck activity and the full notice period before deletion.
      const removed = await prisma.$transaction(tx =>
        anonymizeUserInTx(tx, user.id, {
          lastActiveAt: { lt: daysAgo(DELETE_AFTER_DAYS) },
          deletionWarningSentAt: { lte: daysAgo(NOTICE_DAYS) },
        })
      );
      if (removed) completed++;
    } catch (err) {
      console.error(`[retention] failed to anonymize user ${user.id}`, err);
    }
  }

  return completed;
}

export async function runRetentionCleanup() {
  const frontendUrl = (process.env.FRONTEND_URL || "").split(",")[0]?.trim() || "https://rolichat.app";
  const warned = await sendInactivityWarnings(frontendUrl);
  const anonymized = await anonymizeInactiveAccounts();
  console.log(`[retention] sent ${warned} warning email(s), anonymized ${anonymized} account(s)`);
  return { warned, anonymized };
}
