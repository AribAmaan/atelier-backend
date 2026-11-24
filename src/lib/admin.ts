// Admins are just a list of emails in an env var (ADMIN_EMAILS, comma
// separated) rather than a DB column + role UI — the moderation surface is
// deliberately minimal (a couple of API endpoints, not a full admin panel),
// so this is the smallest thing that works and is safe to change without a
// migration or a deploy of new code.
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}
