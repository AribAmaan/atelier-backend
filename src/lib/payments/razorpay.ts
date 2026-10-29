import crypto from "crypto";
import Razorpay from "razorpay";

/**
 * Master off switch for the whole billing feature. Every route in
 * routes/billing.ts checks this FIRST and 503s if it's not "true" — so
 * setting RAZORPAY_KEY_ID/SECRET alone does nothing by itself; both this
 * flag AND the keys have to be set before a single rupee can move.
 *
 * This is deliberately a separate, server-only flag from the frontend's
 * PREMIUM_PAYMENTS_ENABLED (lib/premium.ts) — the frontend flag only
 * controls whether buy/subscribe buttons render as clickable, which is a UI
 * nicety, not a security boundary. This one is the real boundary: even if
 * someone bypassed the frontend and called the API directly, nothing here
 * executes until an operator explicitly flips PAYMENTS_ENABLED on the
 * backend too.
 *
 * To go live: set PAYMENTS_ENABLED=true, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 * (and ideally RAZORPAY_WEBHOOK_SECRET) on the backend, set
 * NEXT_PUBLIC_RAZORPAY_KEY_ID on the frontend, and flip
 * PREMIUM_PAYMENTS_ENABLED to true in the frontend's lib/premium.ts.
 */
export const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === "true";

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

let client: Razorpay | null = null;

/** Lazily constructs the SDK client so a missing key doesn't crash the
 * process at import time — routes check isRazorpayConfigured()/PAYMENTS_ENABLED
 * before ever calling this. */
export function getRazorpayClient(): Razorpay {
  if (!isRazorpayConfigured()) {
    throw new Error("Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing).");
  }
  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });
  }
  return client;
}

/**
 * Verifies the signature Razorpay's Checkout returns to the browser after a
 * successful payment (order_id + payment_id + signature). Per Razorpay's
 * docs: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret).
 * This MUST be checked server-side before crediting anything — the values
 * posted from the browser are otherwise fully attacker-controlled.
 */
export function verifyCheckoutSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${params.orderId}|${params.paymentId}`)
    .digest("hex");
  return timingSafeEqualHex(expected, params.signature);
}

/**
 * Verifies a webhook payload's signature (different scheme from the
 * checkout signature above: HMAC_SHA256 of the *raw request body* against
 * RAZORPAY_WEBHOOK_SECRET, sent in the X-Razorpay-Signature header). Only
 * meaningful once a webhook is configured in the Razorpay dashboard — the
 * /verify route covers the common path (user completes checkout in-browser)
 * on its own, the webhook is a resilience backstop for the cases where the
 * browser never calls back (closed tab, network drop, etc).
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqualHex(expected, signatureHeader);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Pricing catalog — the server-side source of truth
// ---------------------------------------------------------------------------
//
// The client sends a pack/tier ID and this catalog decides the price; the
// client never gets to say how much to charge. Keep these in sync with the
// frontend's display copy in rolichat-frontend-main/lib/premium.ts — this
// file is what's actually charged, that one is what's shown before payments
// are live. Amounts are in paise (1 INR = 100 paise), Razorpay's native unit.
//
// The INR amounts below are placeholders carried over from the frontend's
// display-only USD prices at a rough, unrounded conversion — review and set
// real India pricing (and consider whether Razorpay's international-card
// support or a separate USD price list is needed for non-INR customers)
// before flipping PAYMENTS_ENABLED on.

export type SparkPackId = "s200" | "s1000" | "s1500" | "s3000" | "s5000" | "s10000";

export const SPARK_PACK_PRICES: Record<SparkPackId, { sparks: number; amountInPaise: number }> = {
  s200: { sparks: 200 + 40, amountInPaise: 16900 }, // ₹169
  s1000: { sparks: 1000 + 200, amountInPaise: 84900 }, // ₹849
  s1500: { sparks: 1500 + 300, amountInPaise: 124900 }, // ₹1,249
  s3000: { sparks: 3000 + 600, amountInPaise: 249900 }, // ₹2,499
  s5000: { sparks: 5000 + 1200, amountInPaise: 419900 }, // ₹4,199
  s10000: { sparks: 10000 + 4000, amountInPaise: 839900 }, // ₹8,399
};

export type MembershipTierId = "plus" | "ultra" | "supreme";
export type BillingCycle = "monthly" | "quarterly" | "yearly";

const MEMBERSHIP_MONTHLY_PAISE: Record<MembershipTierId, number> = {
  plus: 109900, // ₹1,099 / mo
  ultra: 169900, // ₹1,699 / mo
  supreme: 419900, // ₹4,199 / mo
};

// Mirrors cycleMultiplier() in the frontend's lib/premium.ts.
function cycleMultiplier(cycle: BillingCycle): number {
  if (cycle === "quarterly") return 2.85;
  if (cycle === "yearly") return 10;
  return 1;
}

export function membershipAmountInPaise(tier: MembershipTierId, cycle: BillingCycle): number {
  return Math.round(MEMBERSHIP_MONTHLY_PAISE[tier] * cycleMultiplier(cycle));
}

export function nextRenewalDate(cycle: BillingCycle, from: Date = new Date()): Date {
  const months = cycle === "monthly" ? 1 : cycle === "quarterly" ? 3 : 12;
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function paymentMatchesOrder(payment: { id?: unknown; order_id?: unknown; amount?: unknown; currency?: unknown; status?: unknown },
  order: { razorpayOrderId: string; amountInPaise: number; currency: string }): boolean {
  return typeof payment.id === "string" && payment.id.length > 0 && payment.status === "captured" &&
    payment.order_id === order.razorpayOrderId && Number(payment.amount) === order.amountInPaise && payment.currency === order.currency;
}
