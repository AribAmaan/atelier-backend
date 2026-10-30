/** Date-only parsing avoids locale ambiguity and JS's rollover of invalid dates. */
export function validateAccount(displayName: string, raw: string, tosAccepted: boolean, now = new Date()) {
  if (!displayName || displayName.length > 100) return { error: "Enter a display name between 1 and 100 characters." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: "Enter your date of birth as YYYY-MM-DD." };
  const birthdate = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(birthdate.getTime()) || birthdate.toISOString().slice(0, 10) !== raw) return { error: "Enter a valid date of birth." };
  const today = now.toISOString().slice(0, 10);
  if (raw > today) return { error: "That date of birth is in the future." };
  let age = now.getUTCFullYear() - birthdate.getUTCFullYear();
  if (today.slice(5) < raw.slice(5)) age--;
  if (age < 18) return { error: "You must be 18 or older to use Rolichat." };
  if (!tosAccepted) return { error: "You must accept the Terms of Service and Content Policy to continue." };
  return { birthdate };
}

export function validEmail(email: string) {
  // Matches the existing MySQL User.email VARCHAR(191) column.
  return email.length <= 191 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function passwordError(password: string) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (Buffer.byteLength(password, "utf8") > 72) return "Password must be at most 72 UTF-8 bytes; use fewer characters.";
  return null;
}
