import nodemailer from "nodemailer";

// Local development may print emails for testing. Production requires SMTP;
// reset and verification links must never be written to production logs.
let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  transporter = nodemailer.createTransport({
    host,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

export async function sendMail(to: string, subject: string, html: string, text: string) {
  const t = getTransporter();
  const from = process.env.MAIL_FROM || "Rolichat <no-reply@rolichat.local>";

  if (!t) {
    if (process.env.NODE_ENV === "production") throw new Error("Email is not configured. Set SMTP_HOST before sending account emails.");
    // Dev fallback — no SMTP configured. Print the email so whoever's
    // testing locally can grab the link out of the server logs.
    console.log(`\n[mailer] SMTP not configured — printing email instead of sending.`);
    console.log(`[mailer] To: ${to}\n[mailer] Subject: ${subject}\n[mailer] ${text}\n`);
    return { delivered: false as const };
  }

  await t.sendMail({ from, to, subject, html, text });
  return { delivered: true as const };
}
