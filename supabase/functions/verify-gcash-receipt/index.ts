// verify-gcash-receipt
// ----------------------------------------------------------------------------
// Server-side digital-payment receipt verification + fraud detection.
//
// Actions (POST JSON):
//   multipart { action: "stage", bookingRef, bookingAccessToken, provider, receipt }
//     -> stores a private, token-authorized receipt checkpoint without OCR or
//        changing booking/payment state.
//   multipart { action: "verify", bookingRef, provider, receipt, contentType }
//   JSON { action: "verify", bookingRef, provider, imageBase64, contentType }
//     -> OCR (Google Vision) + provider-specific evidence checks.
//        Stores the image (private bucket), writes an audit row, advances
//        payment_status only for a clean auto-approval, and otherwise alerts
//        the owner for review.
//   { action: "sign", bookingRef }    (admin-only, requires a user JWT)
//     -> returns a short-lived signed URL to view the stored receipt image.
//
// Decision lanes:
//   auto_approved : a persisted booking passes every dedicated check
//   manual_review : any uncertain, mismatched, duplicate, or unreadable evidence
//
// Automated verification never rejects or cancels a booking. An authorized
// owner can still deliberately mark a pending receipt as not received.
// ----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  calculateCourtPayment,
  chooseExpectedDue,
  classifyStoredSessionPayment,
  closeMoney,
  roundMoney,
  toNumber,
} from "../_shared/booking-payment.ts";
import type {
  GcashReceiptParse,
  GcashRecipientComparison,
} from "../_shared/gcash-receipt.ts";
import {
  isDedicatedReceiptProvider,
  parseProviderReceipt,
  type ProviderReceiptParse,
  type ProviderReceiptVerificationEvidence,
  verifyProviderReceipt,
} from "../_shared/receipt-providers/index.ts";
import {
  detectReceiptImageContentType,
  googleVisionOcr,
  type ReceiptImageContentType,
  receiptImageSafeToDecode,
} from "../_shared/google-vision.ts";
import { extractReceiptAmount } from "../_shared/receipt-amount.ts";
import {
  activeReceiptRole,
  bookingAccessTokenMatches,
  canViewBookingReceipt,
  canViewDashboardReceipt,
  canViewHostSessionReceipt,
  type ReceiptAccount,
} from "../_shared/receipt-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Payment must happen within this many minutes after the booking/session join
// is started.
// Keep this aligned with the customer-facing reservation countdown.
const PAYMENT_WINDOW_MINUTES = 15;
// OCR usually reads only minute-level timestamps. A receipt paid during the
// same minute as the hold can look a few seconds "before" the booking.
const PAYMENT_EARLY_TOLERANCE_MINUTES = 2;

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const PESO_TOLERANCE = 5; // allow ±₱5 rounding; underpay beyond this is a hard flag

type PaymentProvider =
  | "gcash"
  | "bdopay"
  | "maya"
  | "bpi"
  | "gotyme"
  | "maribank"
  | "pnb";
type OcrProvider = "google_vision" | "none";

type OcrResult = {
  text: string;
  layoutText?: string;
  confidence: number;
  confidenceSource: "native" | "heuristic" | "none";
  provider: OcrProvider;
  primaryProvider?: OcrProvider;
  fallbackProvider?: OcrProvider;
  fallbackReason?: string;
  error?: string;
};

type ReceiptCaller = {
  userId: string;
  account: ReceiptAccount;
};

type BookingMutationScope = {
  customerAccessTokenHash?: string;
  hostUserId?: string;
};

function publicReceiptMessage(
  result: "auto_approved" | "manual_review" | "rejected",
  flags: string[],
): string {
  if (result === "auto_approved") return "Payment verified.";
  if (result === "manual_review") {
    return "Received - the owner will verify your payment shortly.";
  }

  const flagSet = new Set(flags);
  if (flagSet.has("AMOUNT_MISMATCH")) {
    return "Payment amount is lower than required. Please upload the correct payment receipt.";
  }
  if (
    flagSet.has("TIME_EXPIRED") || flagSet.has("TIME_FUTURE") ||
    flagSet.has("DATE_NOT_TODAY")
  ) {
    return `Payment was sent outside the allowed ${PAYMENT_WINDOW_MINUTES}-minute window. Please create a new booking.`;
  }
  if (flagSet.has("IMAGE_UNREADABLE") || flagSet.has("OCR_UNAVAILABLE")) {
    return "Receipt image is unreadable. Please upload a clearer screenshot.";
  }
  if (
    flagSet.has("SUSPECTED_FAKE") ||
    flagSet.has("GCASH_RECEIPT_UNREADABLE") ||
    flagSet.has("BDO_PAY_UNREADABLE") ||
    flagSet.has("MAYA_UNREADABLE") ||
    flagSet.has("BPI_UNREADABLE")
  ) {
    return "Payment could not be verified. Please upload a valid receipt or contact admin.";
  }
  return "Payment details do not match this booking. Please check your receipt and try again, or contact admin.";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = err as Record<string, unknown>;
    if (typeof m.message === "string") return m.message;
    if (typeof m.error === "string") return m.error;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function base64ToBytes(b64: string): Uint8Array {
  // Accept raw base64 or a data: URL.
  const comma = b64.indexOf(",");
  const raw = b64.startsWith("data:") && comma !== -1
    ? b64.slice(comma + 1)
    : b64;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Build the binary string in chunks so a mobile-upload-sized image does not
  // exceed the JavaScript argument/call-stack limit.
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copy.buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Difference-hash (dHash): 64-bit perceptual hash robust to recompression and
// light cropping/scaling. Returns 16-hex-char string, or null if undecodable.
async function dHash(
  bytes: Uint8Array,
  contentType: ReceiptImageContentType,
): Promise<string | null> {
  // ImageScript expands pixels in Edge memory. Skip perceptual hashing when a
  // compressed image declares unsafe dimensions; exact SHA-256 and OCR still
  // provide the audit/detection signals without risking decompression OOM.
  if (!receiptImageSafeToDecode(bytes, contentType)) return null;
  try {
    const img = await Image.decode(bytes);
    const small = img.resize(9, 8); // 9x8 -> 8 horizontal comparisons per row
    let bits = "";
    for (let y = 1; y <= 8; y++) {
      for (let x = 1; x <= 8; x++) {
        const lPix = small.getPixelAt(x, y);
        const rPix = small.getPixelAt(x + 1, y);
        const lGray = ((lPix >>> 24) & 0xff) + ((lPix >>> 16) & 0xff) +
          ((lPix >>> 8) & 0xff);
        const rGray = ((rPix >>> 24) & 0xff) + ((rPix >>> 16) & 0xff) +
          ((rPix >>> 8) & 0xff);
        bits += lGray < rGray ? "1" : "0";
      }
    }
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null; // HEIC/unknown formats — skip perceptual dedupe, not fatal
  }
}

function phManilaNow(): Date {
  // Current instant shifted to UTC+8 wall clock.
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function phTodayStr(): string {
  return phManilaNow().toISOString().slice(0, 10); // YYYY-MM-DD in PH
}

function toPhWallClockDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000);
}

function formatPhDateTime12(d: Date | null): string | null {
  if (!d) return null;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  let hour = d.getUTCHours();
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${year}-${month}-${day} ${hour}:${minute} ${ampm} PH`;
}

function formatPhInstantDateTime12(d: Date | null): string | null {
  if (!d) return null;
  return formatPhDateTime12(toPhWallClockDate(d.toISOString()));
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Parse a GCash-style timestamp e.g. "Jun 13, 2026 10:30 AM" into a Date
// interpreted as PH wall-clock (returned as a UTC+8-shifted Date for comparison
// against phManilaNow()). If OCR only finds the date, return the date but no
// shifted time so it routes to manual review instead of assuming midnight.
function parseReceiptDateTime(
  text: string,
): { date: string | null; shifted: Date | null } {
  const normalized = String(text || "")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const datePattern =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[\s,.\-]+(\d{4})\b/i;
  const dateOnly = normalized.match(datePattern);
  if (!dateOnly) return { date: null, shifted: null };

  const mon = MONTHS[dateOnly[1].toLowerCase().slice(0, 3)];
  const day = parseInt(dateOnly[2], 10);
  const year = parseInt(dateOnly[3], 10);
  const dateStr = `${year}-${String(mon + 1).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;

  const afterDate = normalized.slice(
    (dateOnly.index || 0) + dateOnly[0].length,
    (dateOnly.index || 0) + dateOnly[0].length + 80,
  );
  const beforeDate = normalized.slice(
    Math.max(0, (dateOnly.index || 0) - 40),
    dateOnly.index || 0,
  );
  const timePattern =
    /\b(\d{1,2})\s*[:;.]\s*(\d{2})(?:\s*[:;.]\s*\d{2})?\s*([ap](?:\s*\.?\s*m\.?)?|[ap])\b/i;
  const time = afterDate.match(timePattern) || beforeDate.match(timePattern);
  if (time) {
    let hour = parseInt(time[1], 10);
    const min = parseInt(time[2], 10);
    const ap = time[3].toLowerCase().replace(/[^apm]/g, "");
    if (ap.startsWith("p") && hour !== 12) hour += 12;
    if (ap.startsWith("a") && hour === 12) hour = 0;
    const shifted = new Date(Date.UTC(year, mon, day, hour, min, 0));
    return { date: dateStr, shifted };
  }

  return { date: dateStr, shifted: null };
}

function digitsOnly(s: string): string {
  return (s || "").replace(/\D/g, "");
}

function normalizeReferenceForProvider(
  value: string,
  provider: PaymentProvider,
): string {
  const raw = value || "";
  if (provider === "gcash") return digitsOnly(raw);
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isBdoPayReference(value: string): boolean {
  return /^BN\d{16}$/.test(normalizeReferenceForProvider(value, "bdopay"));
}

function isMayaReference(value: string): boolean {
  return /^[A-Z0-9]{12}$/.test(normalizeReferenceForProvider(value, "maya"));
}

function isBpiConfirmationNo(value: string): boolean {
  return /^\d{10,20}$/.test(digitsOnly(value));
}

function flexibleDigitPattern(digits: string): RegExp {
  return new RegExp(digits.split("").join("[^0-9]*"));
}

// Extract candidate 13-digit GCash reference numbers from OCR text.
function extractGcashRef(text: string, typedRef = ""): string | null {
  const normalizedTyped = digitsOnly(typedRef);

  // If the customer-entered ref is visible in the OCR text, trust it. This
  // avoids false mismatches when OCR sees the receiver mobile number before the
  // "Ref No." line and a broad numeric scan accidentally joins nearby digits.
  if (
    normalizedTyped.length === 13 &&
    flexibleDigitPattern(normalizedTyped).test(text)
  ) {
    return normalizedTyped;
  }

  // Prefer numbers immediately following receipt reference labels.
  const labelPattern =
    /\b(?:ref(?:erence)?(?:\s*(?:no|number|#))?\.?)\s*[:#]?\s*([0-9][0-9\s-]{11,30}[0-9])/gi;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelPattern.exec(text)) !== null) {
    const d = digitsOnly(labelMatch[1]);
    if (d.length === 13) return d;
    if (normalizedTyped.length === 13 && d.includes(normalizedTyped)) {
      return normalizedTyped;
    }
  }

  // Fallback: any standalone 13-digit run.
  const standalone = text.match(/\b\d{13}\b/);
  if (standalone) return standalone[0];

  // Last resort: tolerate OCR spaces inside a single long numeric group.
  // Keep this after label/typed matching because phone numbers and amounts can
  // otherwise be accidentally joined into a fake 13-digit reference.
  const cleaned = text.replace(/[^\d\s-]/g, " ");
  const groups = cleaned.match(/(?:\d[\d\s-]{11,30}\d)/g) || [];
  for (const g of groups) {
    const d = digitsOnly(g);
    if (d.length === 13) return d;
  }
  return null;
}

function extractBpiConfirmationNo(text: string, typedRef = ""): string | null {
  const normalizedTyped = digitsOnly(typedRef);
  if (
    isBpiConfirmationNo(normalizedTyped) &&
    flexibleDigitPattern(normalizedTyped).test(text)
  ) {
    return normalizedTyped;
  }

  const patterns = [
    /\bconfirmation\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{8,24}[0-9])\b/i,
    /\bconfirm(?:ation)?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{8,24}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (isBpiConfirmationNo(ref)) return ref;
  }
  return null;
}

function extractReference(
  text: string,
  provider: PaymentProvider,
  typedRef: string,
): string | null {
  if (provider === "gcash") return extractGcashRef(text, typedRef);
  if (provider === "bpi") return extractBpiConfirmationNo(text, typedRef);

  // BDO Pay/GoTyme/PNB references are not guaranteed to be 13-digit GCash-style refs.
  // For those providers, trust the customer-entered reference only if OCR sees
  // the same alphanumeric token in the receipt text.
  const normalizedTyped = normalizeReferenceForProvider(typedRef, provider);
  if (normalizedTyped.length >= 6) {
    const normalizedText = normalizeReferenceForProvider(text, provider);
    if (normalizedText.includes(normalizedTyped)) return normalizedTyped;
  }
  return null;
}

function hasBdoPayIndicator(text: string): boolean {
  return isBdoPayReceipt(text);
}

function hasMayaIndicator(text: string): boolean {
  return isMayaReceipt(text);
}

function hasBpiIndicator(text: string): boolean {
  return isBpiReceipt(text);
}

function hasInstapayQrphIndicator(text: string): boolean {
  return /\binsta\s*pay\b|\bqrph\b|\bqr\s*ph\b/i.test(text);
}

function hasBdoBnReference(text: string): boolean {
  return /\bbn[\s-]*\d{8}[\s-]*\d{8}\b/i.test(text);
}

function isBdoPayReceipt(text: string): boolean {
  const t = text || "";
  const hasBnRef = hasBdoBnReference(t);
  return /\bbdo\s*pay\b/i.test(t) ||
    /\bthank\s+you\s+for\s+using\s+bdo\b/i.test(t) ||
    (hasBnRef && /\binsta\s*pay\b/i.test(t)) ||
    (hasBnRef && /\bbdo\b/i.test(t)) ||
    (hasBnRef && extractBdoInvoiceNumber(t) !== null);
}

function isMayaReceipt(text: string): boolean {
  const t = text || "";
  return /\bmaya\b/i.test(t) &&
    (/\bsent\s+money\s+via\b/i.test(t) ||
      /\breference\s+id\b/i.test(t) ||
      /\binstapay\s+ref\b/i.test(t) ||
      /\bqrph\b|\bqr\s*ph\b/i.test(t));
}

function isBpiReceipt(text: string): boolean {
  const t = text || "";
  return /\bsent\s+via\s+bpi\b/i.test(t) ||
    /\bbpi\b/i.test(t) ||
    (/\btransfer\s+successful\b/i.test(t) &&
      /\bconfirmation\s*(?:no|number|#)?\.?\b/i.test(t) &&
      /\binsta\s*pay\b/i.test(t));
}

function isGotymeReceipt(text: string): boolean {
  return /\bgo\s*tyme\b|\bgotyme\b/i.test(text || "");
}

function isMaribankReceipt(text: string): boolean {
  return /\bmari\s*bank\b|\bmaribank\b/i.test(text || "");
}

function hasGcashGxiDestination(text: string): boolean {
  return /\bgcash\s*\/\s*g-?xchange\b/i.test(text) ||
    /\bg-?xchange\b/i.test(text) ||
    /\bgcash\b/i.test(text);
}

function isGcashToGcashReceipt(text: string): boolean {
  const t = text || "";
  if (
    isBdoPayReceipt(t) || isMayaReceipt(t) || isBpiReceipt(t) ||
    isGotymeReceipt(t) || isMaribankReceipt(t)
  ) return false;
  return /\bsent\s+via\s+gcash\b/i.test(t) ||
    /\bsent\s+through\s+gcash\b/i.test(t) ||
    /\bgcash\s+receipt\b/i.test(t) ||
    /\btotal\s+amount\s+sent\b/i.test(t);
}

function selectedMethodMismatch(
  provider: PaymentProvider,
  text: string,
): boolean {
  const bdoReceipt = isBdoPayReceipt(text);
  const mayaReceipt = isMayaReceipt(text);
  const bpiReceipt = isBpiReceipt(text);
  const gotymeReceipt = isGotymeReceipt(text);
  const maribankReceipt = isMaribankReceipt(text);
  const gcashReceipt = isGcashToGcashReceipt(text);
  if (provider === "gcash") {
    return bdoReceipt || mayaReceipt || bpiReceipt || gotymeReceipt ||
      maribankReceipt;
  }
  if (provider === "bdopay") {
    return gcashReceipt || mayaReceipt || bpiReceipt || gotymeReceipt ||
      maribankReceipt;
  }
  if (provider === "maya") {
    return gcashReceipt || bdoReceipt || bpiReceipt || gotymeReceipt ||
      maribankReceipt;
  }
  if (provider === "bpi") {
    return gcashReceipt || bdoReceipt || mayaReceipt || gotymeReceipt ||
      maribankReceipt;
  }
  if (provider === "gotyme") {
    return gcashReceipt || bdoReceipt || mayaReceipt || bpiReceipt ||
      maribankReceipt;
  }
  if (provider === "maribank") {
    return gcashReceipt || bdoReceipt || mayaReceipt || bpiReceipt ||
      gotymeReceipt;
  }
  return false;
}

function hasExpectedReceiverName(text: string, expectedName: string): boolean {
  const upper = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const expected = (expectedName || "Paddle Rage Pickleball").toUpperCase()
    .replace(
      /[^A-Z0-9]/g,
      "",
    );
  if (expected.length >= 3 && upper.includes(expected)) return true;
  return upper.includes("PADDLERAGE");
}

function extractBdoInvoiceNumber(text: string): string | null {
  const patterns = [
    /\binvoice\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
    /\binv\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const invoice = match ? digitsOnly(match[1]) : "";
    if (invoice.length >= 4 && invoice.length <= 20) return invoice;
  }
  return null;
}

function extractMayaInstapayRefNo(text: string): string | null {
  const patterns = [
    /\binstapay\s*ref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
    /\binstapay\s*(?:reference|ref)\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (ref.length >= 4 && ref.length <= 20) return ref;
  }
  return null;
}

function extractBpiTransactionRefNo(text: string): string | null {
  const patterns = [
    /\btransaction\s*ref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
    /\btransaction\s*(?:reference|ref)\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (ref.length >= 4 && ref.length <= 20) return ref;
  }
  return null;
}

function extractAmount(text: string): number | null {
  // Legacy parser for non-Maya layouts. Require a complete money token so a
  // value such as P1,080.00 can never fall through as the suffix ,080.00.
  const near = text.match(
    /(?:amount|total|php|₱|p)\s*[:\-]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d,.])/i,
  );
  if (near) return parseFloat(near[1].replace(/,/g, ""));
  const any = text.match(
    /(?<![A-Za-z0-9,])((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d,.])/,
  );
  return any ? parseFloat(any[1].replace(/,/g, "")) : null;
}

function normalizedProvider(raw: string): PaymentProvider | null {
  return paymentMethodProvider(raw);
}

function paymentMethodProvider(raw: unknown): PaymentProvider | null {
  const method = String(raw || "").toLowerCase();
  if (
    method === "gcash" || method === "bdopay" || method === "maya" ||
    method === "bpi" || method === "gotyme" || method === "maribank" ||
    method === "pnb"
  ) {
    return method as PaymentProvider;
  }
  return null;
}

function expectedMerchantForProvider(
  settings: Record<string, string>,
  provider: PaymentProvider,
): { number: string; name: string } {
  if (provider === "bdopay") {
    return {
      number: settings.bdopay_merchant_number ||
        settings.gcash_merchant_number || "",
      name: settings.gcash_qr_receipt_recipient_name ||
        settings.bdopay_receipt_recipient_name ||
        settings.bdopay_merchant_name || settings.payment_merchant_name ||
        settings.gcash_merchant_name || "",
    };
  }
  if (provider === "maya") {
    return {
      number: settings.maya_merchant_number || settings.gcash_merchant_number ||
        "",
      name: settings.maya_merchant_name || settings.payment_merchant_name ||
        settings.gcash_merchant_name || "",
    };
  }
  if (provider === "bpi") {
    return {
      number: settings.bpi_merchant_number || settings.gcash_merchant_number ||
        "",
      name: settings.bpi_merchant_name || settings.gcash_merchant_name ||
        settings.payment_merchant_name || "",
    };
  }
  if (provider === "gotyme" || provider === "maribank") {
    // Both bank routes are transfers to the configured GCash destination.
    // Provider-specific sender settings must never weaken receiver matching.
    return {
      number: settings.gcash_merchant_number || "",
      name: settings.gcash_merchant_name ||
        settings.payment_merchant_name || "",
    };
  }
  if (provider === "pnb") {
    return {
      number: settings.pnb_merchant_number || "",
      name: settings.pnb_merchant_name || "",
    };
  }
  return {
    number: settings.gcash_merchant_number || "",
    name: settings.gcash_merchant_name || "",
  };
}

function expectedOpenPlayAmounts(
  booking: Record<string, unknown>,
  settings: Record<string, string>,
): { total: number; due: number } {
  const cfg = (() => {
    try {
      return settings.open_play_config
        ? JSON.parse(settings.open_play_config)
        : {};
    } catch {
      return {};
    }
  })() as Record<string, unknown>;
  const openPlayFee = toNumber(cfg.fee ?? settings.open_play_fee, 100);
  const platformFee = toNumber(
    settings.maintenance_fee ?? settings.service_fee_rate ??
      settings.booking_fee,
  );
  const total = roundMoney(openPlayFee + platformFee);
  const due = chooseExpectedDue(
    total,
    toNumber(booking.downpayment, -1),
    settings.payment_acceptance_mode,
  );
  return { total, due };
}

async function expectedHostSessionAmounts(
  db: any,
  booking: Record<string, unknown>,
): Promise<{ total: number; due: number }> {
  const sessionId = String(booking.host_session_id || "");
  if (!sessionId) throw new Error("Host session id is required");
  const { data: session, error } = await db
    .from("open_play_host_sessions")
    .select("fee_per_player")
    .eq("id", sessionId)
    .single();
  if (error || !session) throw error || new Error("Host session not found");

  const total = roundMoney(toNumber(session.fee_per_player));
  if (!closeMoney(toNumber(booking.downpayment, -1), total)) {
    throw new Error(
      "Host session payment amount does not match the configured fee",
    );
  }
  return { total, due: total };
}

async function expectedBookingAmounts(
  db: any,
  booking: Record<string, unknown>,
  settings: Record<string, string>,
): Promise<{ total: number; due: number }> {
  const courtId = String(booking.court_id || "");
  if (!courtId) return expectedOpenPlayAmounts(booking, settings);

  const { data: court, error: courtErr } = await db
    .from("courts")
    .select("rate,rate_schedule")
    .eq("id", courtId)
    .single();
  if (courtErr || !court) throw courtErr || new Error("Court not found");

  const courtRow = court as Record<string, unknown>;
  return calculateCourtPayment({
    slots: booking.slots,
    courtRate: courtRow.rate,
    courtRateSchedule: courtRow.rate_schedule,
    fallbackRateSchedule: settings.pricing_tiers,
    feeRate: settings.maintenance_fee ?? settings.service_fee_rate ??
      settings.booking_fee,
    feeType: settings.fee_type,
    storedTotal: booking.total,
    storedServiceFee: booking.booking_fee_amount_snapshot,
    storedDownpayment: booking.downpayment,
    hostBooking: booking.host_booking === true,
    paymentAcceptanceMode: settings.payment_acceptance_mode,
  });
}

async function loadBookingGroup(
  db: any,
  booking: Record<string, unknown>,
  scope: BookingMutationScope,
): Promise<Array<Record<string, unknown>>> {
  const groupRef = String(booking.booking_group_ref || "");
  if (!groupRef) return [booking];
  let query = db
    .from("bookings")
    .select(
      "ref, booking_group_ref, court_id, court_name, slots, total, booking_fee_amount_snapshot, downpayment, host_booking, gcash_ref, payment_method, date, start_time, end_time, payment_status, status, full_name, created_at",
    )
    .eq("booking_group_ref", groupRef);
  if (scope.customerAccessTokenHash) {
    query = query.eq(
      "customer_access_token_hash",
      scope.customerAccessTokenHash,
    );
  } else if (scope.hostUserId) {
    query = query.eq("host_user_id", scope.hostUserId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as Array<Record<string, unknown>>;
}

function bookingLogicalKey(row: Record<string, unknown>): string {
  const slots = Array.isArray(row.slots)
    ? row.slots.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  return [
    String(row.court_id || row.courtId || ""),
    String(row.date || ""),
    slots.join(","),
  ].join("|");
}

function uniqueBookingRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = bookingLogicalKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function expectedBookingGroupAmounts(
  db: any,
  bookings: Array<Record<string, unknown>>,
  settings: Record<string, string>,
): Promise<{ total: number; due: number }> {
  let total = 0;
  let due = 0;
  for (const row of uniqueBookingRows(bookings)) {
    const amounts = await expectedBookingAmounts(db, row, settings);
    total += amounts.total;
    due += amounts.due;
  }
  return { total: roundMoney(total), due: roundMoney(due) };
}

function bookingUpdateQuery(
  db: any,
  booking: Record<string, unknown>,
  update: Record<string, unknown>,
  scope: BookingMutationScope,
) {
  const groupRef = String(booking.booking_group_ref || "");
  let query = db.from("bookings").update(update);
  query = groupRef
    ? query.eq("booking_group_ref", groupRef)
    : query.eq("ref", String(booking.ref || ""));
  if (scope.customerAccessTokenHash) {
    query = query.eq(
      "customer_access_token_hash",
      scope.customerAccessTokenHash,
    );
  } else if (scope.hostUserId) {
    query = query.eq("host_user_id", scope.hostUserId);
  }
  return query;
}

const ACTIVE_RECEIPT_BOOKING_STATUSES = ["verifying", "pending"];
const ACTIVE_RECEIPT_PAYMENT_STATUSES = [
  "unpaid",
  "pending",
  "for_verification",
];

type AttachedReceiptMetadata = {
  path: string;
  hash: string;
  contentType: ReceiptImageContentType;
};

function receiptEvidenceWasVerified(row: Record<string, unknown>): boolean {
  const status = String(row.receipt_status || "").toLowerCase();
  const flags = Array.isArray(row.receipt_flags) ? row.receipt_flags : [];
  return !!row.receipt_verified_at ||
    ["auto_approved", "rejected"].includes(status) ||
    !!String(row.receipt_phash || "") ||
    row.receipt_extracted != null ||
    row.receipt_confidence != null ||
    flags.length > 0;
}

function receiptMetadataKey(row: Record<string, unknown>): string {
  return JSON.stringify([
    String(row.payment_method || "").toLowerCase(),
    String(row.payment_flow || "").toLowerCase(),
    String(row.receipt_image_url || ""),
    String(row.receipt_image_hash || "").toLowerCase(),
    String(row.receipt_status || "none").toLowerCase(),
    String(row.receipt_verified_at || ""),
  ]);
}

function attachedReceiptMetadata(
  row: Record<string, unknown>,
  allowedBookingRefs: Set<string>,
): AttachedReceiptMetadata | null {
  const path = String(row.receipt_image_url || "").trim();
  const hash = String(row.receipt_image_hash || "").trim().toLowerCase();
  if (!path && !hash) return null;
  const match = path.match(
    /^([A-Za-z0-9._-]+)\/([0-9a-f]{64})\.(jpg|jpeg|png|webp)$/,
  );
  if (!match || !allowedBookingRefs.has(match[1]) || match[2] !== hash) {
    throw new Error("Attached receipt metadata is inconsistent");
  }
  const contentType: ReceiptImageContentType = match[3] === "png"
    ? "image/png"
    : match[3] === "webp"
    ? "image/webp"
    : "image/jpeg";
  return { path, hash, contentType };
}

async function loadScopedReceiptBookingRows(
  db: any,
  booking: Record<string, unknown>,
  scope: BookingMutationScope,
): Promise<Array<Record<string, unknown>>> {
  const groupRef = String(booking.booking_group_ref || "").trim();
  let query = db.from("bookings").select(
    "ref,booking_group_ref,status,payment_status,payment_method,payment_flow,created_at,receipt_image_url,receipt_image_hash,receipt_phash,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_verified_at",
  );
  query = groupRef
    ? query.eq("booking_group_ref", groupRef)
    : query.eq("ref", String(booking.ref || ""));
  if (scope.customerAccessTokenHash) {
    query = query.eq(
      "customer_access_token_hash",
      scope.customerAccessTokenHash,
    );
  } else if (scope.hostUserId) {
    query = query.eq("host_user_id", scope.hostUserId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as Array<Record<string, unknown>>;
}

function receiptGroupIsActive(rows: Array<Record<string, unknown>>): boolean {
  return rows.length > 0 && rows.every((row) => {
    const status = String(row.status || "");
    const paymentStatus = String(row.payment_status || "");
    const createdAt = new Date(String(row.created_at || ""));
    const ageMs = Date.now() - createdAt.getTime();
    return ACTIVE_RECEIPT_BOOKING_STATUSES.includes(status) &&
      ACTIVE_RECEIPT_PAYMENT_STATUSES.includes(paymentStatus) &&
      Number.isFinite(createdAt.getTime()) && ageMs >= -60_000 &&
      ageMs <= PAYMENT_WINDOW_MINUTES * 60_000;
  });
}

function receiptGroupMetadataIsConsistent(
  rows: Array<Record<string, unknown>>,
): boolean {
  return new Set(rows.map(receiptMetadataKey)).size <= 1;
}

function clearedReceiptMetadata(): Record<string, unknown> {
  return {
    receipt_image_url: null,
    receipt_image_hash: null,
    receipt_phash: null,
    receipt_status: "none",
    receipt_flags: [],
    receipt_extracted: null,
    receipt_confidence: null,
    receipt_verified_at: null,
  };
}

function receiptMetadataSnapshot(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    payment_method: row.payment_method || null,
    payment_flow: row.payment_flow || null,
    receipt_image_url: row.receipt_image_url || null,
    receipt_image_hash: row.receipt_image_hash || null,
    receipt_phash: row.receipt_phash || null,
    receipt_status: String(row.receipt_status || "none"),
    receipt_flags: Array.isArray(row.receipt_flags) ? row.receipt_flags : [],
    receipt_extracted: row.receipt_extracted ?? null,
    receipt_confidence: row.receipt_confidence ?? null,
    receipt_verified_at: row.receipt_verified_at || null,
  };
}

// Best-effort "looks like a real GCash receipt" heuristic (soft signal only).
function looksLikeGcashReceipt(text: string): boolean {
  const t = text.toLowerCase();
  let score = 0;
  if (/ref(?:erence)?\s*(no|number|#)/.test(t)) score++;
  if (
    /gcash|bdo\s*pay|gotyme|mari\s*bank|maribank|maya|bpi|paymongo|qrph|insta\s*pay|pesonet|g-?xchange|gxi/
      .test(t)
  ) score++;
  if (
    /sent|received|paid|transfer|amount|confirmation\s*(no|number|#)/.test(t)
  ) score++;
  if (/\d{4}/.test(t)) score++;
  return score >= 2;
}

// Best-effort JPEG "edited in image software" detector (soft signal only).
function editedBySoftware(bytes: Uint8Array): boolean {
  // Scan the first 64KB for editor signatures embedded in EXIF/XMP.
  const slice = bytes.subarray(0, Math.min(bytes.length, 65536));
  let s = "";
  for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
  return /(adobe\s*photoshop|gimp|pixlr|snapseed|picsart|lightroom|inkscape)/i
    .test(s);
}

// Google Vision is the only OCR engine used for receipt verification.
function ocrCriticalGaps(
  text: string,
  provider: PaymentProvider,
  typedRef: string,
): string[] {
  if (!text) return ["text"];
  if (isDedicatedReceiptProvider(provider)) {
    const parsed = parseProviderReceipt(provider, text, {
      typedReference: typedRef,
    });
    const receipt = parsed.receipt;
    const gaps: string[] = [];
    if (
      !receipt.reference.value ||
      receipt.reference.typedMatch !== "match"
    ) gaps.push("reference");
    if (
      receipt.amount.amount == null || !receipt.amount.reliable ||
      receipt.amount.ambiguous ||
      (parsed.provider === "gcash" &&
        (parsed.receipt.amount.conflictingPrimaryAmounts ||
          !parsed.receipt.amount.matchingPrimaryAmountDisplays))
    ) gaps.push("amount");
    if (receipt.timestamp.completeness !== "date_time") gaps.push("date");
    return gaps;
  }
  const gaps: string[] = [];
  if (!extractReference(text, provider, typedRef)) gaps.push("reference");
  if (extractAmount(text) == null) gaps.push("amount");
  if (!parseReceiptDateTime(text).date) gaps.push("date");
  return gaps;
}

async function runOCR(
  visionKey: string,
  base64: string,
  provider: PaymentProvider,
  typedRef: string,
): Promise<OcrResult> {
  if (visionKey) {
    try {
      const v = await googleVisionOcr(visionKey, base64);
      const candidates = [v.text, v.layoutText]
        .filter((text): text is string => Boolean(text?.trim()))
        .filter((text, index, all) => all.indexOf(text) === index);
      const ranked = candidates.map((text, index) => ({
        text,
        index,
        gaps: ocrCriticalGaps(text, provider, typedRef),
      })).sort((a, b) => a.gaps.length - b.gaps.length || a.index - b.index);
      const selected = ranked[0] || {
        text: v.text,
        index: 0,
        gaps: ocrCriticalGaps(v.text, provider, typedRef),
      };
      const gaps = selected.gaps;
      const usedLayoutReconstruction = selected.index > 0;
      if (v.text && gaps.length === 0) {
        return {
          ...v,
          text: selected.text,
          provider: "google_vision",
          primaryProvider: "google_vision",
          fallbackReason: usedLayoutReconstruction
            ? "google_layout_reconstruction"
            : undefined,
        };
      }
      if (v.text) {
        return {
          ...v,
          text: selected.text,
          provider: "google_vision",
          primaryProvider: "google_vision",
          fallbackReason: usedLayoutReconstruction
            ? `google_layout_reconstruction_missing_${gaps.join("_")}`
            : gaps.length
            ? `google_missing_${gaps.join("_")}`
            : undefined,
        };
      }
      console.error("Vision OCR returned no text:", gaps.join(","));
      return {
        ...v,
        provider: "google_vision",
        primaryProvider: "google_vision",
      };
    } catch (e) {
      console.error("Vision OCR failed:", errMsg(e));
      return {
        text: "",
        confidence: 0,
        confidenceSource: "none",
        provider: "none",
        primaryProvider: "google_vision",
        error: errMsg(e),
      };
    }
  }
  return {
    text: "",
    confidence: 0,
    confidenceSource: "none",
    provider: "none",
  };
}

function telegramAdminUrl(): string {
  return Deno.env.get("APP_ADMIN_URL") ||
    "https://paddleragecdo.ph/admin.html";
}

function shortTelegramFlags(flags: string[]): string {
  const shown = flags.slice(0, 2);
  const remaining = Math.max(0, flags.length - shown.length);
  return `${shown.join(", ") || "REVIEW_REQUIRED"}${
    remaining ? ` +${remaining}` : ""
  }`;
}

function telegramPeso(value: unknown): string {
  return `₱${
    Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function telegramDate(value: unknown): string {
  const raw = String(value || "").slice(0, 10);
  const date = new Date(`${raw}T00:00:00+08:00`);
  if (!raw || Number.isNaN(date.getTime())) return raw || "—";
  return date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Manila",
  });
}

function telegramDateTime(value: unknown): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Manila",
  });
  const timePart = date.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  });
  return `${datePart} · ${timePart}`;
}

function telegramTimeMinutes(value: unknown): number | null {
  const match = String(value || "").trim().match(
    /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i,
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = String(match[3] || "").toUpperCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23)) return null;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function telegramCourtHours(row: Record<string, unknown>): number {
  if (Array.isArray(row.slots) && row.slots.length) return row.slots.length;
  const start = telegramTimeMinutes(row.start_time);
  const end = telegramTimeMinutes(row.end_time);
  if (start == null || end == null) return 0;
  return Math.max(0, (end - start) / 60);
}

function telegramHours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

async function sendTelegram(message: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const chatIdRaw = Deno.env.get("TELEGRAM_CHAT_ID") || "";
  if (!botToken || !chatIdRaw) return;
  const chatIds = chatIdRaw.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.allSettled(
    chatIds.map((chatId) =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      })
    ),
  );
}

// ── handler ─────────────────────────────────────────────────────────────────

async function loadReceiptCaller(
  req: Request,
  db: any,
): Promise<ReceiptCaller | null> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const { data: userData, error: userError } = await db.auth.getUser(token);
  const userId = String(userData?.user?.id || "");
  if (userError || !userId) return null;

  const { data: account, error: accountError } = await db
    .from("accounts")
    .select("role,status")
    .eq("id", userId)
    .maybeSingle();
  if (accountError) throw accountError;
  return { userId, account: account || null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ error: "Missing SERVICE_ROLE_KEY" }, 500);
  const db = createClient(supabaseUrl, serviceRoleKey);

  const requestLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(requestLength) && requestLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request too large" }, 413);
  }

  let body: Record<string, unknown>;
  let uploadedImage: File | null = null;
  const requestContentType = req.headers.get("content-type") || "";
  try {
    if (requestContentType.toLowerCase().includes("multipart/form-data")) {
      const form = await req.formData();
      const bookingDataRaw = String(form.get("bookingData") || "");
      let bookingData: Record<string, unknown> | null = null;
      if (bookingDataRaw) {
        try {
          const parsed = JSON.parse(bookingDataRaw);
          if (parsed && typeof parsed === "object") bookingData = parsed;
        } catch {
          return json({ error: "Invalid bookingData JSON" }, 400);
        }
      }
      const receipt = form.get("receipt");
      if (receipt instanceof File) uploadedImage = receipt;
      body = {
        action: String(form.get("action") || "verify"),
        bookingRef: String(form.get("bookingRef") || ""),
        bookingAccessToken: String(form.get("bookingAccessToken") || ""),
        provider: String(form.get("provider") || "gcash"),
        stagedReceiptPath: String(form.get("stagedReceiptPath") || ""),
        contentType: uploadedImage?.type ||
          String(form.get("contentType") || "image/jpeg"),
        ...(bookingData ? { bookingData } : {}),
      };
    } else {
      body = await req.json();
    }
  } catch {
    return json({
      error: requestContentType.toLowerCase().includes("multipart/form-data")
        ? "Invalid multipart body"
        : "Invalid JSON body",
    }, 400);
  }
  const action = (body.action as string) || "verify";

  // ── customer/staff: durable, private pre-verification evidence ────────────
  if (["stage", "recover-stage", "discard-stage"].includes(action)) {
    let actionLeaseKey = "";
    let actionLeaseToken = "";
    try {
      const bookingRef = String(body.bookingRef || "").trim();
      const bookingAccessToken = String(body.bookingAccessToken || "");
      const requestedStagedPath = String(body.stagedReceiptPath || "").trim();
      const provider = paymentMethodProvider(body.provider);
      const imageBase64 = String(body.imageBase64 || "");
      if (!bookingRef) return json({ error: "bookingRef required" }, 400);
      if (!/^[a-z0-9][a-z0-9-]{2,79}$/i.test(bookingRef)) {
        return json({ error: "Invalid bookingRef" }, 400);
      }
      if (action === "stage" && !provider) {
        return json({
          error: "A supported digital payment method is required",
        }, 400);
      }
      if (action === "stage" && !imageBase64 && !uploadedImage) {
        return json({ error: "receipt file or imageBase64 required" }, 400);
      }

      const { data: loadedBooking, error: bookingError } = await db.from(
        "bookings",
      )
        .select(
          "ref,booking_group_ref,status,payment_status,payment_method,payment_flow,created_at,receipt_image_url,receipt_image_hash,receipt_phash,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_verified_at,customer_access_token_hash,host_booking,host_user_id,created_by_user_id",
        )
        .eq("ref", bookingRef)
        .maybeSingle();
      if (bookingError) {
        return json({ error: "Booking could not be loaded" }, 500);
      }
      if (!loadedBooking) return json({ error: "Booking not found" }, 404);
      const booking = loadedBooking as Record<string, unknown>;

      const storedAccessTokenHash = String(
        booking.customer_access_token_hash || "",
      );
      const customerTokenAuthorized = await bookingAccessTokenMatches(
        bookingAccessToken,
        storedAccessTokenHash,
      );
      let caller: ReceiptCaller | null = null;
      if (!customerTokenAuthorized) {
        try {
          caller = await loadReceiptCaller(req, db);
        } catch (error) {
          console.error("receipt staging caller lookup failed:", errMsg(error));
          return json({
            error: "Receipt authorization could not be checked",
          }, 500);
        }
      }
      const authorizedReceiptCaller = !!caller &&
        canViewBookingReceipt(caller.account, caller.userId, booking);
      if (!customerTokenAuthorized && !authorizedReceiptCaller) {
        return json({
          error: "Receipt access is not authorized for this booking",
        }, 403);
      }

      const bookingMutationScope: BookingMutationScope = {};
      if (/^[0-9a-f]{64}$/.test(storedAccessTokenHash)) {
        bookingMutationScope.customerAccessTokenHash = storedAccessTokenHash;
      } else if (booking.host_booking === true && booking.host_user_id) {
        bookingMutationScope.hostUserId = String(booking.host_user_id);
      }

      let groupRows = await loadScopedReceiptBookingRows(
        db,
        booking,
        bookingMutationScope,
      );
      if (!groupRows.some((row) => String(row.ref || "") === bookingRef)) {
        return json({ error: "Receipt booking scope is invalid" }, 403);
      }
      if (!receiptGroupMetadataIsConsistent(groupRows)) {
        return json({
          error: "Receipt metadata is inconsistent across this booking group",
          code: "RECEIPT_GROUP_INCONSISTENT",
        }, 409);
      }

      let targetRow = groupRows.find((row) =>
        String(row.ref || "") === bookingRef
      )!;
      let allowedBookingRefs = new Set(
        groupRows.map((row) => String(row.ref || "")).filter(Boolean),
      );
      let attached: AttachedReceiptMetadata | null;
      try {
        attached = attachedReceiptMetadata(targetRow, allowedBookingRefs);
      } catch {
        return json({
          error: "Attached receipt metadata is invalid",
          code: "ATTACHED_RECEIPT_METADATA_INVALID",
        }, 409);
      }

      if (action === "recover-stage") {
        const verified = groupRows.some(receiptEvidenceWasVerified);
        if (!attached) {
          if (verified) {
            return json({
              error: "Verified receipt metadata is incomplete",
              code: "ATTACHED_RECEIPT_METADATA_INVALID",
            }, 409);
          }
          return json({
            ok: true,
            found: false,
            bookingRef,
            stagedReceiptPath: null,
            receiptImageUrl: null,
            receiptImageHash: null,
            receiptStatus: String(targetRow.receipt_status || "none"),
            receiptVerifiedAt: null,
            verified: false,
            bookingStatus: String(targetRow.status || "") || null,
            paymentStatus: String(targetRow.payment_status || "") || null,
          });
        }
        return json({
          ok: true,
          found: true,
          bookingRef,
          stagedReceiptPath: attached.path,
          receiptImageUrl: attached.path,
          receiptImageHash: attached.hash,
          contentType: attached.contentType,
          receiptStatus: String(targetRow.receipt_status || "manual_review"),
          receiptVerifiedAt: targetRow.receipt_verified_at || null,
          verified,
          bookingStatus: String(targetRow.status || "") || null,
          paymentStatus: String(targetRow.payment_status || "") || null,
        });
      }

      if (action === "stage") {
        if (!receiptGroupIsActive(groupRows)) {
          return json({
            error: "This booking no longer accepts receipt uploads",
          }, 409);
        }
        if (groupRows.some(receiptEvidenceWasVerified)) {
          return json({
            error: "Verified receipt evidence cannot be replaced",
            code: "RECEIPT_ALREADY_VERIFIED",
          }, 409);
        }
        const { data: methodReady, error: methodReadyError } = await db.rpc(
          "public_payment_method_ready",
          { p_method: provider },
        );
        if (methodReadyError) {
          return json({
            error: "Payment method availability could not be checked.",
            code: "PAYMENT_METHOD_CHECK_UNAVAILABLE",
          }, 503);
        }
        if (methodReady !== true) {
          return json({
            error: "This payment method is not currently enabled.",
            code: "PAYMENT_METHOD_DISABLED",
          }, 409);
        }
      }

      actionLeaseKey = String(booking.booking_group_ref || bookingRef).trim();
      const { data: leaseRows, error: leaseError } = await db.rpc(
        "claim_receipt_verification_lease",
        { p_booking_key: actionLeaseKey, p_lease_seconds: 600 },
      );
      const lease = Array.isArray(leaseRows) ? leaseRows[0] : leaseRows;
      if (leaseError) {
        console.error("receipt staging lease failed:", errMsg(leaseError));
        return json({
          error:
            "Receipt evidence could not be changed safely. Please try again shortly.",
          code: "RECEIPT_LEASE_UNAVAILABLE",
        }, 503);
      }
      if (!lease?.claimed || !lease?.claim_token) {
        return json({
          error:
            "This receipt is already being processed. Please wait and do not upload or pay again.",
          code: "RECEIPT_VERIFICATION_IN_PROGRESS",
          retryAfterSeconds: 15,
        }, 409);
      }
      actionLeaseToken = String(lease.claim_token);

      // Re-read after claiming. A verifier may have completed between the
      // authorization read and the lease claim; never replace or discard it.
      groupRows = await loadScopedReceiptBookingRows(
        db,
        booking,
        bookingMutationScope,
      );
      if (
        !groupRows.some((row) => String(row.ref || "") === bookingRef) ||
        !receiptGroupMetadataIsConsistent(groupRows)
      ) {
        return json({
          error: "Receipt metadata changed while the request was starting",
          code: "RECEIPT_GROUP_INCONSISTENT",
        }, 409);
      }
      if (groupRows.some(receiptEvidenceWasVerified)) {
        return json({
          error: "Verified receipt evidence cannot be changed",
          code: "RECEIPT_ALREADY_VERIFIED",
        }, 409);
      }
      if (action === "stage" && !receiptGroupIsActive(groupRows)) {
        return json({
          error: "This booking no longer accepts receipt uploads",
        }, 409);
      }

      targetRow = groupRows.find((row) =>
        String(row.ref || "") === bookingRef
      )!;
      allowedBookingRefs = new Set(
        groupRows.map((row) => String(row.ref || "")).filter(Boolean),
      );
      try {
        attached = attachedReceiptMetadata(targetRow, allowedBookingRefs);
      } catch {
        return json({
          error: "Attached receipt metadata is invalid",
          code: "ATTACHED_RECEIPT_METADATA_INVALID",
        }, 409);
      }
      const previousMetadata = receiptMetadataSnapshot(targetRow);

      if (action === "discard-stage") {
        if (!attached) {
          return json({
            ok: true,
            discarded: false,
            stale: !!requestedStagedPath,
            bookingRef,
            stagedReceiptPath: null,
            receiptImageUrl: null,
            receiptImageHash: null,
            receiptStatus: String(targetRow.receipt_status || "none"),
            receiptVerifiedAt: null,
            verified: false,
            bookingStatus: String(targetRow.status || "") || null,
            paymentStatus: String(targetRow.payment_status || "") || null,
          });
        }
        if (attached.path !== requestedStagedPath) {
          return json({
            ok: true,
            discarded: false,
            stale: true,
            bookingRef,
            stagedReceiptPath: null,
            receiptImageUrl: null,
            receiptImageHash: null,
            receiptStatus: String(targetRow.receipt_status || "none"),
            receiptVerifiedAt: targetRow.receipt_verified_at || null,
            verified: false,
            bookingStatus: String(targetRow.status || "") || null,
            paymentStatus: String(targetRow.payment_status || "") || null,
          });
        }
        let clearQuery = bookingUpdateQuery(
          db,
          booking,
          clearedReceiptMetadata(),
          bookingMutationScope,
        )
          .is("receipt_verified_at", null)
          .in("receipt_status", ["none", "manual_review"]);
        clearQuery = attached
          ? clearQuery.eq("receipt_image_url", attached.path).eq(
            "receipt_image_hash",
            attached.hash,
          )
          : clearQuery.is("receipt_image_url", null).is(
            "receipt_image_hash",
            null,
          );
        const { data: clearedRows, error: clearError } = await clearQuery
          .select(
            "ref",
          );
        if (clearError || clearedRows?.length !== groupRows.length) {
          console.error(
            "receipt discard metadata clear failed:",
            clearError
              ? errMsg(clearError)
              : "not every scoped row was cleared",
          );
          return json({
            error: "Receipt evidence could not be discarded safely",
            code: "RECEIPT_DISCARD_FAILED",
          }, 500);
        }

        if (attached) {
          const { error: removeError } = await db.storage.from("receipts")
            .remove([attached.path]);
          if (removeError) {
            const clearedRefs = (clearedRows || []).map((
              row: { ref: string },
            ) => row.ref);
            const { data: restoredRows, error: restoreError } =
              await bookingUpdateQuery(
                db,
                booking,
                previousMetadata,
                bookingMutationScope,
              )
                .in("ref", clearedRefs)
                .is("receipt_image_url", null)
                .is("receipt_image_hash", null)
                .is("receipt_verified_at", null)
                .eq("receipt_status", "none")
                .select("ref");
            console.error("receipt discard object removal failed:", {
              removeError: errMsg(removeError),
              restoreError: restoreError ? errMsg(restoreError) : null,
              restoredRows: restoredRows?.length || 0,
            });
            return json({
              error:
                "Receipt evidence could not be removed safely. Please try again.",
              code: "RECEIPT_DISCARD_STORAGE_FAILED",
            }, 500);
          }
        }
        return json({
          ok: true,
          discarded: !!attached,
          stale: false,
          bookingRef,
          stagedReceiptPath: null,
          receiptImageUrl: null,
          receiptImageHash: null,
          receiptStatus: "none",
          receiptVerifiedAt: null,
          verified: false,
          bookingStatus: String(targetRow.status || "") || null,
          paymentStatus: String(targetRow.payment_status || "") || null,
        });
      }

      let bytes: Uint8Array;
      try {
        bytes = uploadedImage
          ? new Uint8Array(await uploadedImage.arrayBuffer())
          : base64ToBytes(imageBase64);
      } catch {
        return json({ error: "Receipt image encoding is invalid" }, 400);
      }
      if (bytes.length === 0) return json({ error: "Empty image" }, 400);
      if (bytes.length > MAX_BYTES) {
        return json({ error: "Image too large (max 5 MB)" }, 400);
      }
      const contentType = detectReceiptImageContentType(bytes);
      if (!contentType) {
        return json({
          error: "Receipt must be a valid JPG, PNG, or WebP image",
        }, 415);
      }
      if (!receiptImageSafeToDecode(bytes, contentType)) {
        return json({ error: "Receipt image dimensions are too large" }, 400);
      }

      const imageHash = await sha256Hex(bytes);
      const ext = contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
        ? "webp"
        : "jpg";
      const stagedReceiptPath = `${bookingRef}/${imageHash}.${ext}`;
      const { error: uploadError } = await db.storage.from("receipts").upload(
        stagedReceiptPath,
        bytes,
        { contentType, upsert: true },
      );
      if (uploadError) {
        console.error("receipt staging failed:", errMsg(uploadError));
        return json({
          error: "Receipt image could not be stored. Please upload it again.",
        }, 500);
      }

      const stagedMetadata: Record<string, unknown> = {
        // Public court holds use GCash as a temporary insert-time placeholder.
        // The enabled method selected for this exact receipt becomes
        // authoritative atomically with the durable evidence checkpoint.
        payment_method: provider,
        payment_flow: provider,
        receipt_image_url: stagedReceiptPath,
        receipt_image_hash: imageHash,
        receipt_phash: null,
        receipt_status: "manual_review",
        receipt_flags: [],
        receipt_extracted: null,
        receipt_confidence: null,
        receipt_verified_at: null,
      };
      let attachQuery = bookingUpdateQuery(
        db,
        booking,
        stagedMetadata,
        bookingMutationScope,
      )
        .in("status", ACTIVE_RECEIPT_BOOKING_STATUSES)
        .in("payment_status", ACTIVE_RECEIPT_PAYMENT_STATUSES)
        .is("receipt_verified_at", null)
        .in("receipt_status", ["none", "manual_review"]);
      attachQuery = attached
        ? attachQuery.eq("receipt_image_url", attached.path).eq(
          "receipt_image_hash",
          attached.hash,
        )
        : attachQuery.is("receipt_image_url", null).is(
          "receipt_image_hash",
          null,
        );
      const { data: attachedRows, error: attachError } = await attachQuery
        .select("ref");
      const attachedCount = attachedRows?.length || 0;
      if (attachError || attachedCount !== groupRows.length) {
        let restored = !!attachError || attachedCount === 0;
        if (!restored) {
          const partiallyAttachedRefs = attachedRows!.map(
            (row: { ref: string }) => row.ref,
          );
          const { data: restoredRows, error: restoreError } =
            await bookingUpdateQuery(
              db,
              booking,
              previousMetadata,
              bookingMutationScope,
            )
              .in("ref", partiallyAttachedRefs)
              .eq("receipt_image_url", stagedReceiptPath)
              .eq("receipt_image_hash", imageHash)
              .is("receipt_verified_at", null)
              .eq("receipt_status", "manual_review")
              .select("ref");
          restored = !restoreError &&
            restoredRows?.length === attachedCount;
          if (restoreError || !restored) {
            console.error(
              "receipt staging rollback failed:",
              restoreError
                ? errMsg(restoreError)
                : "not every partially attached row was restored",
            );
          }
        }
        if (restored && attached?.path !== stagedReceiptPath) {
          const { error: cleanupError } = await db.storage.from("receipts")
            .remove([stagedReceiptPath]);
          if (cleanupError) {
            console.error(
              "receipt staging failed-upload cleanup failed:",
              errMsg(cleanupError),
            );
          }
        }
        console.error(
          "receipt staging metadata attach failed:",
          attachError
            ? errMsg(attachError)
            : "not every scoped row was attached",
        );
        return json({
          error:
            "Receipt was uploaded but could not be attached safely. Please try again.",
          code: "RECEIPT_STAGE_ATTACH_FAILED",
        }, 500);
      }

      let cleanupWarning: string | null = null;
      if (attached && attached.path !== stagedReceiptPath) {
        const { error: priorRemoveError } = await db.storage.from("receipts")
          .remove([attached.path]);
        if (priorRemoveError) {
          cleanupWarning = "The previous private checkpoint needs cleanup.";
          console.error(
            "receipt staging prior-object cleanup failed:",
            errMsg(priorRemoveError),
          );
        }
      }
      console.log("receipt checkpoint: durably staged", {
        bookingRef,
        rows: attachedCount,
        bytes: bytes.length,
        contentType,
        stagedReceiptPath,
        replaced: !!attached && attached.path !== stagedReceiptPath,
      });
      return json({
        ok: true,
        found: true,
        stagedReceiptPath,
        receiptImageHash: imageHash,
        contentType,
        size: bytes.length,
        receiptStatus: "manual_review",
        receiptVerifiedAt: null,
        verified: false,
        replaced: !!attached && attached.path !== stagedReceiptPath,
        ...(cleanupWarning ? { warning: cleanupWarning } : {}),
      });
    } catch (error) {
      console.error(`receipt ${action} error:`, errMsg(error));
      return json({ error: errMsg(error) }, 500);
    } finally {
      if (actionLeaseKey && actionLeaseToken) {
        const { error: releaseError } = await db.rpc(
          "release_receipt_verification_lease",
          {
            p_booking_key: actionLeaseKey,
            p_claim_token: actionLeaseToken,
          },
        );
        if (releaseError) {
          console.error(
            `receipt ${action} lease release failed:`,
            errMsg(releaseError),
          );
        }
      }
    }
  }

  // ── admin-only: mint a signed URL to view a stored receipt ────────────────
  if (action === "sign") {
    const bookingRef = String(body.bookingRef || "");
    const openPlayRegistrationId = String(body.openPlayRegistrationId || "");
    const hostSessionRegistrationId = String(
      body.hostSessionRegistrationId || "",
    );
    const targetCount = [
      bookingRef,
      openPlayRegistrationId,
      hostSessionRegistrationId,
    ].filter(Boolean).length;
    if (targetCount !== 1) {
      return json({
        error: "Exactly one receipt target is required",
      }, 400);
    }

    let caller: ReceiptCaller | null;
    try {
      caller = await loadReceiptCaller(req, db);
    } catch (error) {
      console.error("receipt caller lookup failed:", errMsg(error));
      return json({ error: "Receipt authorization could not be checked" }, 500);
    }
    if (!caller) return json({ error: "Unauthorized" }, 401);
    if (!activeReceiptRole(caller.account)) {
      return json(
        { error: "This account is not authorized to view receipts" },
        403,
      );
    }

    let path: string | null = null;
    if (hostSessionRegistrationId) {
      const { data: reg, error: regError } = await db
        .from("open_play_host_session_registrations")
        .select("receipt_image_url,session_id")
        .eq("id", hostSessionRegistrationId)
        .maybeSingle();
      if (regError) return json({ error: "Receipt could not be loaded" }, 500);
      if (!reg) return json({ error: "No receipt on file" }, 404);
      if (!canViewDashboardReceipt(caller.account)) {
        const { data: session, error: sessionError } = await db
          .from("open_play_host_sessions")
          .select("host_user_id")
          .eq("id", reg.session_id)
          .maybeSingle();
        if (sessionError) {
          return json(
            { error: "Receipt authorization could not be checked" },
            500,
          );
        }
        if (
          !canViewHostSessionReceipt(caller.account, caller.userId, session)
        ) {
          return json({ error: "Forbidden" }, 403);
        }
      }
      path = reg?.receipt_image_url || null;
    } else if (openPlayRegistrationId) {
      if (!canViewDashboardReceipt(caller.account)) {
        return json({ error: "Forbidden" }, 403);
      }
      const { data: reg, error: regError } = await db
        .from("open_play_registrations")
        .select("receipt_image_url")
        .eq("id", openPlayRegistrationId)
        .maybeSingle();
      if (regError) return json({ error: "Receipt could not be loaded" }, 500);
      path = reg?.receipt_image_url || null;
    } else {
      const { data: bk, error: bookingError } = await db.from("bookings")
        .select(
          "receipt_image_url,host_booking,host_user_id,created_by_user_id",
        )
        .eq("ref", bookingRef).maybeSingle();
      if (bookingError) {
        return json({ error: "Receipt could not be loaded" }, 500);
      }
      if (!bk) return json({ error: "No receipt on file" }, 404);
      if (!canViewBookingReceipt(caller.account, caller.userId, bk)) {
        return json({ error: "Forbidden" }, 403);
      }
      path = bk?.receipt_image_url || null;
    }
    if (!path) return json({ error: "No receipt on file" }, 404);
    const { data: signed, error: signErr } = await db.storage.from("receipts")
      .createSignedUrl(path, 300);
    if (signErr || !signed) {
      return json({ error: errMsg(signErr || "sign failed") }, 500);
    }
    return json({ ok: true, url: signed.signedUrl });
  }
  if (action !== "verify") return json({ error: "Unsupported action" }, 400);

  let receiptLeaseKey = "";
  let receiptLeaseToken = "";

  // ── verify a freshly-uploaded receipt ─────────────────────────────────────
  try {
    const bookingRef = String(body.bookingRef || "");
    const bookingAccessToken = String(body.bookingAccessToken || "");
    let provider = normalizedProvider(String(body.provider || "gcash"));
    if (!provider) {
      return json({
        error: "Unsupported payment provider.",
        code: "UNSUPPORTED_PAYMENT_PROVIDER",
      }, 400);
    }
    let imageBase64 = String(body.imageBase64 || "");
    const stagedReceiptPath = String(body.stagedReceiptPath || "").trim();
    // Optional inline data supports pre-save Open Play registration receipts.
    // A matching saved booking still takes precedence over every inline field.
    const inlineBookingData =
      (body.bookingData && typeof body.bookingData === "object")
        ? body.bookingData as Record<string, unknown>
        : null;
    if (!bookingRef) return json({ error: "bookingRef required" }, 400);
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/i.test(bookingRef)) {
      return json({ error: "Invalid bookingRef" }, 400);
    }
    if (!imageBase64 && !uploadedImage && !stagedReceiptPath) {
      return json({
        error: "receipt file, staged receipt, or imageBase64 required",
      }, 400);
    }

    let bytes: Uint8Array | null = null;
    let contentType: ReceiptImageContentType | null = null;
    if (!stagedReceiptPath) {
      try {
        bytes = uploadedImage
          ? new Uint8Array(await uploadedImage.arrayBuffer())
          : base64ToBytes(imageBase64);
      } catch {
        return json({ error: "Receipt image encoding is invalid" }, 400);
      }
      if (bytes.length === 0) return json({ error: "Empty image" }, 400);
      if (bytes.length > MAX_BYTES) {
        return json({ error: "Image too large (max 5 MB)" }, 400);
      }
      // Never trust a browser-supplied MIME label. Detect the actual file type
      // before storing the upload or sending it to the billable OCR API.
      contentType = detectReceiptImageContentType(bytes);
      if (!contentType) {
        return json({
          error: "Receipt must be a valid JPG, PNG, or WebP image",
        }, 415);
      }
    }
    // A saved court booking is always authoritative. Inline data exists for
    // pre-save Open Play registrations; it must never override a persisted
    // booking's price, host flag, payment method, or customer identity.
    const { data: persistedRow, error: bookingErr } = await db
      .from("bookings")
      .select(
        "ref, booking_group_ref, court_id, court_name, slots, total, booking_fee_amount_snapshot, downpayment, host_booking, host_user_id, created_by_user_id, customer_access_token_hash, gcash_ref, payment_method, date, start_time, end_time, email, payment_status, status, full_name, created_at, receipt_image_url, receipt_image_hash, receipt_phash, receipt_status, receipt_flags, receipt_extracted, receipt_confidence, receipt_verified_at",
      )
      .eq("ref", bookingRef)
      .maybeSingle();
    if (bookingErr) return json({ error: "Booking could not be loaded" }, 500);

    // Authentication is loaded once so a staff member or the owning host can
    // authorize a persisted receipt mutation without the customer access token.
    // An anonymous Supabase key is not a user session and produces no caller.
    let caller: ReceiptCaller | null;
    try {
      caller = await loadReceiptCaller(req, db);
    } catch (error) {
      console.error("receipt caller lookup failed:", errMsg(error));
      return json({ error: "Receipt authorization could not be checked" }, 500);
    }

    let booking: Record<string, unknown>;
    let bookingMutationScope: BookingMutationScope = {};
    let inlinePricingKind:
      | "open_play"
      | "host_session"
      | "host_booking_balance"
      | null = null;
    let hostBalancePayment: Record<string, unknown> | null = null;
    const isHostBalanceReference = /^HBAL-[A-F0-9]{32}$/.test(bookingRef);
    let authorizedReceiptCaller = false;
    const hasPersistedBooking = !!persistedRow;
    if (persistedRow) {
      booking = { ...(persistedRow as Record<string, unknown>) };
      const storedAccessTokenHash = String(
        booking.customer_access_token_hash || "",
      );
      const customerTokenAuthorized = await bookingAccessTokenMatches(
        bookingAccessToken,
        storedAccessTokenHash,
      );
      authorizedReceiptCaller = !!caller &&
        canViewBookingReceipt(caller.account, caller.userId, booking);
      if (customerTokenAuthorized) {
        bookingMutationScope = {
          customerAccessTokenHash: storedAccessTokenHash,
        };
      } else {
        if (!authorizedReceiptCaller) {
          return json({
            error: "Receipt verification is not authorized for this booking",
          }, 403);
        }
        // Even a trusted operator should update only the target reservation's
        // ownership boundary when a group reference is present. This makes an
        // accidental/colliding group id harmless.
        if (/^[0-9a-f]{64}$/.test(storedAccessTokenHash)) {
          bookingMutationScope = {
            customerAccessTokenHash: storedAccessTokenHash,
          };
        } else if (booking.host_booking === true && booking.host_user_id) {
          bookingMutationScope = {
            hostUserId: String(booking.host_user_id),
          };
        }
      }
      delete booking.customer_access_token_hash;
      const persistedStatus = String(booking.status || "");
      const persistedPaymentStatus = String(booking.payment_status || "");
      const terminal =
        ["confirmed", "cancelled", "completed", "forfeited"].includes(
          persistedStatus,
        ) ||
        ["paid", "downpayment_paid", "deposit_retained", "rejected"].includes(
          persistedPaymentStatus,
        );
      if (terminal) {
        const storedReceiptStatus = String(booking.receipt_status || "");
        const finalStatus = storedReceiptStatus === "rejected" ||
            persistedStatus === "cancelled" ||
            persistedPaymentStatus === "rejected"
          ? "rejected"
          : storedReceiptStatus === "manual_review"
          ? "manual_review"
          : "auto_approved";
        return json({
          ok: true,
          status: finalStatus,
          flags: [],
          publicReason: finalStatus === "rejected"
            ? "This booking was already rejected."
            : finalStatus === "manual_review"
            ? "This booking is already awaiting owner review."
            : "Payment was already verified.",
          extracted: booking.receipt_extracted || null,
          confidence: booking.receipt_confidence ?? null,
          receiptImageUrl: booking.receipt_image_url || null,
          receiptImageHash: booking.receipt_image_hash || null,
          receiptPhash: booking.receipt_phash || null,
          receiptVerifiedAt: booking.receipt_verified_at || null,
          paymentStatus: persistedPaymentStatus || null,
          bookingStatus: persistedStatus || null,
          message: "This booking has already been processed.",
        });
      }
      // Timing is the only field an inline payload may supplement for a saved
      // booking, and only when the persisted value is absent.
      if (!booking.created_at && inlineBookingData?.created_at) {
        booking.created_at = inlineBookingData.created_at;
      }
      if (!booking.date && inlineBookingData?.date) {
        booking.date = inlineBookingData.date;
      }
    } else if (isHostBalanceReference) {
      if (
        !caller || caller.account?.role !== "host" ||
        caller.account?.status !== "active"
      ) {
        return json({
          error:
            "Only the active host who owns this balance payment can verify its receipt",
        }, 403);
      }
      const nowIso = new Date().toISOString();
      const { data: balanceRow, error: balanceError } = await db
        .from("host_booking_balance_payments")
        .select(
          "id,verification_ref,booking_key,booking_ref,booking_group_ref,booking_refs,host_user_id,status,expected_amount,total_amount,original_paid_amount,balance_due_at,expires_at,payment_provider,payment_reference,customer_name,customer_email,booking_date,court_label,schedule_label,created_at",
        )
        .eq("verification_ref", bookingRef)
        .eq("host_user_id", caller.userId)
        .eq("status", "created")
        .gt("expires_at", nowIso)
        .gt("balance_due_at", nowIso)
        .maybeSingle();
      if (balanceError) {
        console.error(
          "host balance verification lookup failed:",
          errMsg(balanceError),
        );
        return json({ error: "Balance payment could not be loaded" }, 500);
      }
      if (!balanceRow) {
        return json({
          error:
            "This balance payment request expired or is no longer available. Please start again from My Bookings.",
        }, 410);
      }
      const balanceAmount = Math.round(
        Number(balanceRow.expected_amount ?? -1) * 100,
      ) / 100;
      if (!Number.isFinite(balanceAmount) || balanceAmount <= 0) {
        return json({ error: "Balance payment amount is invalid" }, 400);
      }
      hostBalancePayment = balanceRow as Record<string, unknown>;
      booking = {
        ref: bookingRef,
        total: balanceAmount,
        downpayment: balanceAmount,
        payment_method: balanceRow.payment_provider,
        gcash_ref: balanceRow.payment_reference,
        date: balanceRow.booking_date,
        full_name: balanceRow.customer_name,
        email: balanceRow.customer_email,
        created_at: balanceRow.created_at,
      };
      inlinePricingKind = "host_booking_balance";
    } else {
      if (!inlineBookingData) return json({ error: "Booking not found" }, 404);
      const hasCourtShape = !!(
        inlineBookingData.court_id ||
        inlineBookingData.courtId ||
        inlineBookingData.booking_group_ref ||
        inlineBookingData.groupRef ||
        (Array.isArray(inlineBookingData.slots) &&
          inlineBookingData.slots.length > 0) ||
        inlineBookingData.host_booking === true ||
        inlineBookingData.hostBooking === true
      );
      if (hasCourtShape) {
        return json({
          error: "Court booking must be saved before receipt verification",
        }, 400);
      }
      booking = inlineBookingData;
      inlinePricingKind = booking.host_session_id
        ? "host_session"
        : "open_play";
    }
    const authoritativeProvider = paymentMethodProvider(
      booking.payment_method ?? booking.paymentMethod,
    );
    if (!authoritativeProvider) {
      return json({
        error:
          "Receipt OCR is available only for a saved digital payment method.",
        code: "DIGITAL_PAYMENT_METHOD_REQUIRED",
      }, 400);
    }
    // The saved payment method is authoritative; a caller cannot relabel a
    // cash/unknown booking or select weaker provider rules in the request.
    provider = authoritativeProvider;

    // A disabled or unconfigured payment method must fail before Storage is
    // written or a short-lived hold can be promoted to a permanent
    // manual-review state by the service role.
    const { data: methodReady, error: methodReadyError } = await db.rpc(
      "public_payment_method_ready",
      { p_method: provider },
    );
    if (methodReadyError) {
      return json({
        error: "Payment method availability could not be checked.",
        code: "PAYMENT_METHOD_CHECK_UNAVAILABLE",
      }, 503);
    }
    if (methodReady !== true) {
      return json({
        error: "This payment method is not currently enabled.",
        code: "PAYMENT_METHOD_DISABLED",
      }, 409);
    }

    let persistedAttachedHash = "";
    if (hasPersistedBooking) {
      receiptLeaseKey = String(booking.booking_group_ref || bookingRef).trim();
      const { data: leaseRows, error: leaseError } = await db.rpc(
        "claim_receipt_verification_lease",
        { p_booking_key: receiptLeaseKey, p_lease_seconds: 600 },
      );
      const lease = Array.isArray(leaseRows) ? leaseRows[0] : leaseRows;
      if (leaseError) {
        console.error("receipt verification lease failed:", errMsg(leaseError));
        return json({
          error:
            "Receipt verification could not start safely. Please try again shortly.",
          code: "RECEIPT_LEASE_UNAVAILABLE",
        }, 503);
      }
      if (!lease?.claimed || !lease?.claim_token) {
        return json({
          error:
            "This receipt is already being verified. Please wait for the result and do not upload or pay again.",
          code: "RECEIPT_VERIFICATION_IN_PROGRESS",
          retryAfterSeconds: 15,
        }, 409);
      }
      receiptLeaseToken = String(lease.claim_token);

      // The initial row can become stale while a prior verifier owns the
      // lease. Re-read after claiming before trusting or downloading evidence.
      const { data: currentReceiptRow, error: currentReceiptError } = await db
        .from("bookings")
        .select(
          "status,payment_status,receipt_image_url,receipt_image_hash,receipt_phash,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_verified_at",
        )
        .eq("ref", bookingRef)
        .maybeSingle();
      if (currentReceiptError) {
        return json(
          { error: "Current receipt state could not be loaded" },
          500,
        );
      }
      if (!currentReceiptRow) return json({ error: "Booking not found" }, 404);
      booking = {
        ...booking,
        ...(currentReceiptRow as Record<string, unknown>),
      };

      const currentStatus = String(booking.status || "");
      const currentPaymentStatus = String(booking.payment_status || "");
      const terminalAfterLease =
        ["confirmed", "cancelled", "completed", "forfeited"].includes(
          currentStatus,
        ) ||
        ["paid", "downpayment_paid", "deposit_retained", "rejected"].includes(
          currentPaymentStatus,
        );
      if (terminalAfterLease || receiptEvidenceWasVerified(booking)) {
        const storedReceiptStatus = String(booking.receipt_status || "");
        const finalStatus = storedReceiptStatus === "rejected" ||
            currentStatus === "cancelled" || currentPaymentStatus === "rejected"
          ? "rejected"
          : storedReceiptStatus === "manual_review"
          ? "manual_review"
          : "auto_approved";
        const storedFlags = Array.isArray(booking.receipt_flags)
          ? booking.receipt_flags as string[]
          : [];
        return json({
          ok: true,
          status: finalStatus,
          flags: storedFlags,
          publicReason: publicReceiptMessage(finalStatus, storedFlags),
          extracted: booking.receipt_extracted || null,
          confidence: booking.receipt_confidence ?? null,
          receiptImageUrl: booking.receipt_image_url || null,
          receiptImageHash: booking.receipt_image_hash || null,
          receiptPhash: booking.receipt_phash || null,
          receiptVerifiedAt: booking.receipt_verified_at || null,
          paymentStatus: currentPaymentStatus || null,
          bookingStatus: currentStatus || null,
          message: "This booking receipt has already been processed.",
        });
      }

      const persistedAttachedPath = String(
        booking.receipt_image_url || "",
      ).trim();
      persistedAttachedHash = String(
        booking.receipt_image_hash || "",
      ).trim().toLowerCase();
      if (stagedReceiptPath) {
        if (stagedReceiptPath !== persistedAttachedPath) {
          return json({
            error:
              "The staged receipt is not the current checkpoint for this booking.",
            code: "STAGED_RECEIPT_NOT_CURRENT",
          }, 409);
        }
      } else if (persistedAttachedPath || persistedAttachedHash) {
        return json({
          error:
            "Use the current staged receipt checkpoint to verify this booking.",
          code: "STAGED_RECEIPT_REQUIRED",
        }, 409);
      }
    }

    if (stagedReceiptPath) {
      if (!hasPersistedBooking) {
        return json(
          { error: "A staged receipt requires a saved booking" },
          400,
        );
      }
      const expectedPrefix = `${bookingRef}/`;
      const stagedName = stagedReceiptPath.startsWith(expectedPrefix)
        ? stagedReceiptPath.slice(expectedPrefix.length)
        : "";
      if (!/^[0-9a-f]{64}\.(?:jpg|png|webp)$/.test(stagedName)) {
        return json({ error: "Invalid staged receipt checkpoint" }, 400);
      }
      const stagedHash = stagedName.slice(0, 64);
      if (persistedAttachedHash !== stagedHash) {
        return json({
          error: "The staged receipt hash is not attached to this booking.",
          code: "STAGED_RECEIPT_HASH_MISMATCH",
        }, 409);
      }
      const { data: stagedObject, error: stagedDownloadError } = await db
        .storage
        .from("receipts")
        .download(stagedReceiptPath);
      if (stagedDownloadError || !stagedObject) {
        return json({
          error: "The uploaded receipt checkpoint is no longer available.",
        }, 409);
      }
      try {
        bytes = new Uint8Array(await stagedObject.arrayBuffer());
      } catch {
        return json({ error: "Stored receipt image is invalid" }, 400);
      }
      if (bytes.length === 0) return json({ error: "Empty image" }, 400);
      if (bytes.length > MAX_BYTES) {
        return json({ error: "Image too large (max 5 MB)" }, 400);
      }
      contentType = detectReceiptImageContentType(bytes);
      if (!contentType) {
        return json({
          error: "Receipt must be a valid JPG, PNG, or WebP image",
        }, 415);
      }
    }
    if (!bytes || !contentType) {
      return json({ error: "Receipt image could not be prepared" }, 500);
    }

    // Save the evidence before pricing, perceptual hashing, or OCR. Large
    // mobile screenshots can make those later steps slow or memory-heavy; a
    // disconnect there must never leave the owner without the paid receipt.
    const imageHash = await sha256Hex(bytes);
    const ext = contentType === "image/png"
      ? "png"
      : contentType === "image/webp"
      ? "webp"
      : "jpg";
    const objectPath = `${bookingRef}/${imageHash}.${ext}`;
    if (stagedReceiptPath && stagedReceiptPath !== objectPath) {
      return json({
        error: "Staged receipt checkpoint did not match its contents",
      }, 400);
    }
    console.log("receipt checkpoint: storing", {
      bookingRef,
      bytes: bytes.length,
      contentType,
    });
    const upErr = stagedReceiptPath
      ? null
      : (await db.storage.from("receipts").upload(
        objectPath,
        bytes,
        {
          contentType,
          // The hash-derived path makes a customer retry idempotent.
          upsert: true,
        },
      )).error;
    if (upErr) {
      console.error("receipt upload failed:", errMsg(upErr));
      return json({
        error:
          "Receipt image could not be stored. Please upload the receipt again.",
      }, 500);
    }

    if (hasPersistedBooking) {
      let safeStateQuery = bookingUpdateQuery(
        db,
        booking,
        {
          status: "pending",
          payment_status: "for_verification",
          receipt_image_url: objectPath,
          receipt_image_hash: imageHash,
          receipt_status: "manual_review",
          receipt_flags: [],
          receipt_verified_at: null,
        },
        bookingMutationScope,
      )
        .in("status", ACTIVE_RECEIPT_BOOKING_STATUSES)
        .in("payment_status", ACTIVE_RECEIPT_PAYMENT_STATUSES)
        .is("receipt_verified_at", null);
      safeStateQuery = stagedReceiptPath
        ? safeStateQuery.eq("receipt_image_url", stagedReceiptPath).eq(
          "receipt_image_hash",
          imageHash,
        )
        : safeStateQuery.is("receipt_image_url", null).is(
          "receipt_image_hash",
          null,
        );
      const { data: safeRows, error: safeStateErr } = await safeStateQuery
        .select("ref");
      if (safeStateErr || !safeRows?.length) {
        console.error(
          "receipt safe-state update failed:",
          safeStateErr
            ? errMsg(safeStateErr)
            : "no active booking rows updated",
        );
        return json({
          error:
            "Receipt was stored but could not be attached to the booking. Please contact the owner with your booking reference.",
        }, 500);
      }
      booking = {
        ...booking,
        status: "pending",
        payment_status: "for_verification",
        receipt_image_url: objectPath,
        receipt_image_hash: imageHash,
        receipt_status: "manual_review",
      };
      console.log("receipt checkpoint: attached", {
        bookingRef,
        rows: safeRows.length,
        objectPath,
      });
    }

    const settingsRows = await db.from("settings").select("key,value");
    const settingsError = settingsRows.error ? errMsg(settingsRows.error) : "";
    const settings: Record<string, string> = {};
    (settingsRows.data || []).forEach((r: { key: string; value: string }) => {
      settings[r.key] = r.value;
    });
    const expectedMerchant = expectedMerchantForProvider(settings, provider);
    const expectedNumber = expectedMerchant.number;
    const expectedName = expectedMerchant.name;
    let pricingError = "";
    let expectedAmount = 0;
    let expectedTotal = 0;
    let autoPaymentStatus: "paid" | "downpayment_paid" | null = null;
    let bookingGroup: Array<Record<string, unknown>> = [booking];
    try {
      if (inlinePricingKind === "host_booking_balance") {
        expectedTotal = Math.round(
          Number(hostBalancePayment?.expected_amount ?? -1) * 100,
        ) / 100;
        expectedAmount = expectedTotal;
        if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
          throw new Error("Balance payment amount is invalid");
        }
      } else if (inlinePricingKind === "host_session") {
        const amounts = await expectedHostSessionAmounts(db, booking);
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      } else if (inlinePricingKind === "open_play") {
        const amounts = expectedOpenPlayAmounts(booking, settings);
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      } else {
        bookingGroup = await loadBookingGroup(
          db,
          booking,
          bookingMutationScope,
        );
        const amounts = await expectedBookingGroupAmounts(
          db,
          bookingGroup,
          settings,
        );
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      }
      if (hasPersistedBooking) {
        autoPaymentStatus = classifyStoredSessionPayment(
          expectedAmount,
          uniqueBookingRows(bookingGroup).map((row) => ({
            total: row.total,
            downpayment: row.downpayment,
            hostBooking: row.host_booking === true,
          })),
        );
      }
    } catch (err) {
      pricingError = errMsg(err);
    }
    const bookingGroupRefs = new Set(
      bookingGroup.map((row) => String(row.ref || "")).filter(Boolean),
    );
    const bookingGroupRef = String(
      booking.booking_group_ref ||
        bookingGroup.find((row) => row.booking_group_ref)?.booking_group_ref ||
        "",
    ).trim();
    const ledgerClaimScope = bookingGroupRef ? "booking_group" : "booking";
    const ledgerClaimOwnerId = bookingGroupRef || bookingRef;
    const ledgerClaimBelongsToBooking = (
      row: Record<string, unknown> | null,
    ): boolean => {
      if (!row) return false;
      const scope = String(row.claim_scope || "");
      const ownerId = String(row.claim_owner_id || "");
      if (scope && ownerId) {
        return scope === ledgerClaimScope && ownerId === ledgerClaimOwnerId;
      }
      // Rolling-deploy compatibility for a ledger row written before the
      // explicit ownership columns existed.
      return bookingGroupRefs.has(String(row.booking_ref || ""));
    };

    // Hashes are stored for audit only. GCash validity is based on receipt details.
    const phash = await dHash(bytes, contentType);

    // Google Vision still expects base64. Delay this allocation until after
    // Storage and the manual-review checkpoint have safely completed.
    if (!imageBase64) imageBase64 = bytesToBase64(bytes);

    const flags: string[] = [];

    if (settingsError) flags.push("SETTINGS_UNAVAILABLE");
    if (!expectedNumber && !expectedName) {
      // Missing merchant identity is configuration uncertainty, never grounds
      // for approval or cancellation. Keep the receipt for an owner review.
      flags.push("MERCHANT_CONFIG_MISSING");
    }
    if (
      (provider === "gcash" || provider === "maya") && !expectedNumber &&
      !flags.includes("MERCHANT_CONFIG_MISSING")
    ) {
      // A QR image alone cannot prove which recipient the screenshot paid.
      // GCash and Maya auto-approval require a configured full mobile number.
      flags.push("MERCHANT_CONFIG_MISSING");
    }
    if (!isDedicatedReceiptProvider(provider)) {
      // Legacy providers remain owner-review-only until each has a pure,
      // provider-specific parser/verifier with the same evidence contract.
      flags.push("PROVIDER_REVIEW_REQUIRED");
    }

    // Do not flag duplicate-looking images. GCash/BDO Pay/Maya receipt screens
    // share the same layout, so perceptual image matching creates false flags.
    // Reuse protection is handled by exact payment refs/invoices below.

    // ── OCR ─────────────────────────────────────────────────────────────────
    const visionKey = Deno.env.get("GOOGLE_VISION_API_KEY") || "";
    const typedRef = normalizeReferenceForProvider(
      String(booking.gcash_ref || ""),
      provider,
    );
    let ocrText = "";
    let ocrConfidence = 0;
    let ocrConfidenceSource: OcrResult["confidenceSource"] = "none";
    let ocrProvider: OcrResult["provider"] = "none";
    let ocrPrimaryProvider: OcrResult["primaryProvider"] = "none";
    let ocrFallbackProvider: OcrResult["fallbackProvider"] | null = null;
    let ocrFallbackReason: string | null = null;
    let ocrError: string | null = null;
    try {
      const ocr = await runOCR(visionKey, imageBase64, provider, typedRef);
      ocrText = ocr.text;
      ocrConfidence = ocr.confidence;
      ocrConfidenceSource = ocr.confidenceSource;
      ocrProvider = ocr.provider;
      ocrPrimaryProvider = ocr.primaryProvider || ocr.provider;
      ocrFallbackProvider = ocr.fallbackProvider || null;
      ocrFallbackReason = ocr.fallbackReason || null;
      ocrError = ocr.error || null;
    } catch (e) {
      console.error("Google Vision OCR failed:", errMsg(e));
    }
    if (!visionKey) {
      // No OCR provider configured at all — cannot verify content, manual review.
      flags.push("OCR_UNAVAILABLE");
    } else if (ocrError) {
      // Provider/network failures are uncertain and must go to manual review;
      // they are not evidence that the customer uploaded a fake receipt.
      flags.push("OCR_UNAVAILABLE");
    } else if (!ocrText) {
      // Google Vision ran but found no text. A blank upload and a genuine but
      // blurry receipt are indistinguishable here, so preserve the booking and
      // send it to manual review rather than auto-cancelling a paid customer.
      flags.push("IMAGE_UNREADABLE");
    }

    // ── field extraction ────────────────────────────────────────────────────
    const providerParse: ProviderReceiptParse | null =
      isDedicatedReceiptProvider(provider)
        ? parseProviderReceipt(provider, ocrText, {
          typedReference: typedRef,
        })
        : null;
    const gcashParse: GcashReceiptParse | null =
      providerParse?.provider === "gcash" ? providerParse.receipt : null;
    const bankParse = providerParse && providerParse.provider !== "gcash"
      ? providerParse.receipt
      : null;
    const extractedRef = providerParse
      ? providerParse.receipt.reference.value || null
      : extractReference(ocrText, provider, typedRef);
    const extractedInvoice = providerParse?.provider === "bdopay"
      ? providerParse.receipt.invoice.value || null
      : provider === "bdopay"
      ? extractBdoInvoiceNumber(ocrText)
      : null;
    const extractedInstapayRefNo = providerParse?.provider === "maya"
      ? providerParse.receipt.railReference.value || null
      : provider === "maya"
      ? extractMayaInstapayRefNo(ocrText)
      : null;
    const extractedBpiTransactionRefNo = providerParse?.provider === "bpi"
      ? providerParse.receipt.transactionReference.value || null
      : provider === "bpi"
      ? extractBpiTransactionRefNo(ocrText)
      : null;
    const amountExtraction = providerParse
      ? providerParse.receipt.amount
      : provider === "maya"
      ? extractReceiptAmount(ocrText, { provider })
      : null;
    // A weak or ambiguous Maya read is never evidence of underpayment. It is
    // stored for diagnostics but routed to manual review as unreadable.
    const extractedAmount = amountExtraction
      ? (amountExtraction.reliable ? amountExtraction.amount : null)
      : extractAmount(ocrText);
    const genericReceiptTimestamp = parseReceiptDateTime(ocrText);
    const receiptDate = providerParse
      ? providerParse.receipt.timestamp.date || null
      : genericReceiptTimestamp.date;
    const receiptDateTime = providerParse
      ? (providerParse.receipt.timestamp.instant
        ? new Date(providerParse.receipt.timestamp.instant)
        : null)
      : genericReceiptTimestamp.shifted;
    const bookingStartedWallClock = toPhWallClockDate(
      booking.created_at || booking.createdAt,
    );
    const bookingStartedInstant = (() => {
      const parsed = new Date(
        String(booking.created_at || booking.createdAt || ""),
      );
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })();
    const bookingStartedAt = providerParse
      ? bookingStartedInstant
      : bookingStartedWallClock;
    const bookingStartedDate = bookingStartedWallClock
      ? bookingStartedWallClock.toISOString().slice(0, 10)
      : null;
    const receiptAgeMinutes = bookingStartedAt && receiptDateTime
      ? (receiptDateTime.getTime() - bookingStartedAt.getTime()) / 60000
      : null;
    const providerVerification: ProviderReceiptVerificationEvidence | null =
      providerParse
        ? verifyProviderReceipt(providerParse, {
          typedReference: typedRef,
          expectedAmount: pricingError ? null : expectedAmount,
          pricingAvailable: !pricingError,
          amountTolerance: 0.01,
          expectedRecipientNumber: expectedNumber,
          expectedRecipientName: expectedName,
          expectedRecipientLabel: provider === "bpi"
            ? settings.gcash_qr_receipt_recipient_name ||
              settings.bpi_receipt_recipient_name || ""
            : "",
          expectedRecipientAccount: provider === "bdopay" || provider === "bpi"
            ? settings.gcash_qr_receipt_destination_token ||
              settings.bdopay_receipt_destination_token || ""
            : "",
          bookingStartedAt: bookingStartedInstant?.toISOString() || null,
          bookingStartedDate,
          paymentWindowMinutes: PAYMENT_WINDOW_MINUTES,
          earlyToleranceMinutes: PAYMENT_EARLY_TOLERANCE_MINUTES,
        })
        : null;
    const gcashRecipient: GcashRecipientComparison | null =
      providerVerification?.provider === "gcash"
        ? providerVerification.recipientComparison
        : null;
    for (const flag of providerVerification?.flags || []) {
      if (!flags.includes(flag)) flags.push(flag);
    }
    if (provider === "bdopay" && !isBdoPayReference(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "maya" && !isMayaReference(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "bpi" && !isBpiConfirmationNo(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }

    // ── content checks (only when OCR text exists) ──────────────────────────
    if (ocrText) {
      if (selectedMethodMismatch(provider, ocrText)) {
        flags.push("METHOD_MISMATCH");
      }

      if (providerVerification) {
        // Dedicated provider parsers keep OCR observations independent from
        // the customer-typed reference. The typed value is comparison input
        // only and never becomes extracted receipt evidence.
        const groupPaymentConsistent = bookingGroup.length > 0 &&
          bookingGroup.every((row) =>
            paymentMethodProvider(row.payment_method) === provider &&
            normalizeReferenceForProvider(
                String(row.gcash_ref || ""),
                provider,
              ) === typedRef &&
            ["verifying", "pending"].includes(String(row.status || "")) &&
            ["pending", "for_verification", "unpaid"].includes(
              String(row.payment_status || ""),
            )
          );
        if (
          hasPersistedBooking &&
          (!groupPaymentConsistent || !autoPaymentStatus)
        ) {
          flags.push("BOOKING_GROUP_PAYMENT_MISMATCH");
        }
      } else if (provider === "maya") {
        // Maya focused path: do not require GCash/GXI/BDO Pay evidence here.
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("PRICING_UNAVAILABLE");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          // Maya's flattened OCR can still turn a damaged/split thousands
          // value into a plausible smaller number. Keep the booking pending
          // for an owner to compare with the stored image; never auto-approve
          // the short amount and never auto-cancel from this heuristic alone.
          flags.push("AMOUNT_REVIEW");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if (
          (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
        ) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
          flags.push("TIME_EXPIRED");
        }

        if (!hasMayaIndicator(ocrText)) flags.push("MAYA_UNREADABLE");
        if (!hasInstapayQrphIndicator(ocrText)) {
          flags.push("INSTAPAY_QRPH_UNREADABLE");
        }
        if (!hasExpectedReceiverName(ocrText, expectedName)) {
          flags.push("RECEIVER_NAME_UNREADABLE");
        }
      } else if (provider === "bpi") {
        // BPI focused path: direct transfers bind the full configured GCash
        // identity; QR transfers bind the separate QR alias/token and rail.
        // Do not run the GCash-to-GCash verifier for either layout.
        if (!extractedRef) flags.push("BPI_CONFIRMATION_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("PRICING_UNAVAILABLE");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          flags.push("AMOUNT_MISMATCH");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if (
          (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
        ) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
          flags.push("TIME_EXPIRED");
        }

        if (!hasBpiIndicator(ocrText)) flags.push("BPI_UNREADABLE");
        const bpiQrReceipt = providerParse?.provider === "bpi" &&
          providerParse.receipt.indicators.qrCodeRecipient;
        if (bpiQrReceipt && !hasInstapayQrphIndicator(ocrText)) {
          flags.push("INSTAPAY_QRPH_UNREADABLE");
        }
        if (!hasGcashGxiDestination(ocrText)) {
          flags.push("GXI_DESTINATION_UNREADABLE");
        }
        const bpiExpectedName = bpiQrReceipt
          ? settings.gcash_qr_receipt_recipient_name ||
            settings.bpi_receipt_recipient_name || ""
          : expectedName;
        if (!hasExpectedReceiverName(ocrText, bpiExpectedName)) {
          flags.push("RECEIVER_NAME_UNREADABLE");
        }
      } else {
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("PRICING_UNAVAILABLE");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          flags.push("AMOUNT_MISMATCH");
        }
      }

      // This heuristic is not proof of fraud. OCR can miss labels on a real
      // screenshot, so flag it for an owner instead of auto-cancelling.
      if (provider !== "gcash" && !looksLikeGcashReceipt(ocrText)) {
        flags.push("SUSPECTED_FAKE");
      }
    }
    // A host balance is server-locked. Overpayment is no more eligible for
    // automatic approval than underpayment; retain the evidence for review.
    if (
      hostBalancePayment && extractedAmount != null &&
      !closeMoney(extractedAmount, expectedAmount) &&
      !flags.includes("AMOUNT_MISMATCH")
    ) {
      flags.push("AMOUNT_MISMATCH");
    }
    if (editedBySoftware(bytes)) flags.push("EDITED_METADATA");

    // Every provider-specific auto-approval requires a high-quality native OCR
    // read. Generic/legacy parsers remain review-only.
    const minimumOcrConfidence = isDedicatedReceiptProvider(provider)
      ? 0.9
      : 0.55;
    if (
      ocrText &&
      (
        ocrConfidence < minimumOcrConfidence ||
        (isDedicatedReceiptProvider(provider) &&
          ocrConfidenceSource !== "native")
      )
    ) {
      flags.push("LOW_OCR_CONFIDENCE");
    }

    // ── reference reuse / replay guard ──────────────────────────────────────
    // Dedicated parsers produce provider-namespaced transaction keys plus a
    // shared InstaPay rail key. This catches cross-bank replay without making
    // unrelated provider references collide. Customer-typed values are never
    // promoted into dedupe evidence.
    const dedupeKeys: Array<
      { key: string; providerKey: string; duplicateFlag: string }
    > = providerVerification?.dedupeKeys.map((item) => ({ ...item })) || [];
    if (!providerVerification && extractedRef) {
      dedupeKeys.push({
        key: `${provider}:${extractedRef}`,
        providerKey: provider,
        duplicateFlag: "DUPLICATE_REF",
      });
    }
    if (provider === "bdopay" && extractedInvoice && !providerVerification) {
      dedupeKeys.push({
        key: `bdopay_invoice:${extractedInvoice}`,
        providerKey: "bdopay_invoice",
        duplicateFlag: "DUPLICATE_INVOICE",
      });
    }
    if (
      provider === "maya" && extractedInstapayRefNo && !providerVerification
    ) {
      dedupeKeys.push({
        key: `maya_instapay:${extractedInstapayRefNo}`,
        providerKey: "maya_instapay",
        duplicateFlag: "DUPLICATE_INSTAPAY_REF",
      });
    }
    if (
      provider === "bpi" && extractedBpiTransactionRefNo &&
      !providerVerification
    ) {
      dedupeKeys.push({
        key: `bpi_transaction:${extractedBpiTransactionRefNo}`,
        providerKey: "bpi_transaction",
        duplicateFlag: "DUPLICATE_BPI_TRANSACTION_REF",
      });
    }

    let duplicateClear = true;
    for (const item of dedupeKeys) {
      const { data: existingRef } = await db
        .from("used_gcash_refs")
        .select("booking_ref,claim_scope,claim_owner_id")
        .eq("gcash_ref", item.key)
        .maybeSingle();
      if (existingRef && !ledgerClaimBelongsToBooking(existingRef)) {
        duplicateClear = false;
        flags.push(item.duplicateFlag);
      }
    }

    // ── decision routing ────────────────────────────────────────────────────
    const sourceProviderMatch = providerParse?.provider === "gcash"
      ? providerParse.receipt.indicators.classification === "gcash"
      : providerParse
      ? providerParse.receipt.indicators.providerBrand &&
        !providerParse.receipt.indicators.competingProviderBrand
      : false;
    const referenceMatch =
      providerParse?.receipt.reference.typedMatch === "match";
    const amountMatch = extractedAmount != null && expectedAmount > 0 &&
      closeMoney(extractedAmount, expectedAmount) &&
      amountExtraction?.reliable === true &&
      amountExtraction.ambiguous !== true;
    const timestampValid =
      providerParse?.receipt.timestamp.completeness === "date_time" &&
      !flags.some((flag) =>
        [
          "DATE_UNREADABLE",
          "DATE_NOT_TODAY",
          "TIME_UNREADABLE",
          "TIME_FUTURE",
          "TIME_EXPIRED",
        ].includes(flag)
      );
    const recipientMatch = providerVerification?.provider === "gcash"
      ? providerVerification.recipientComparison.phone === "exact" &&
        providerVerification.recipientComparison.name !== "mismatch"
      : providerVerification?.provider === "maya"
      ? providerVerification.recipientComparison.phone === "exact" &&
        ["exact", "masked_compatible"].includes(
          providerVerification.recipientComparison.name,
        )
      : providerVerification?.provider === "bdopay"
      ? providerVerification.recipientComparison.name === "exact" &&
        providerVerification.recipientComparison.account === "exact"
      : providerVerification?.provider === "bpi"
      ? providerVerification.recipientComparison === "exact" &&
        providerVerification.recipientAccountComparison === "exact"
      : providerVerification
      ? ["exact", "last4_only"].includes(
        providerVerification.recipientComparison.phone,
      ) &&
        ["exact", "masked_compatible"].includes(
          providerVerification.recipientComparison.name,
        )
      : false;
    const cleanEvidence = !!providerVerification &&
      sourceProviderMatch &&
      referenceMatch &&
      amountMatch &&
      timestampValid &&
      recipientMatch &&
      duplicateClear &&
      flags.length === 0;
    const bookingCanAutoApprove = cleanEvidence &&
      hasPersistedBooking &&
      autoPaymentStatus !== null;
    const hostBalanceCanAutoApprove = cleanEvidence &&
      inlinePricingKind === "host_booking_balance";
    const inlineRegistrationCanAutoApprove = cleanEvidence &&
      (inlinePricingKind === "host_session" ||
        inlinePricingKind === "open_play");
    let result: "auto_approved" | "manual_review" =
      bookingCanAutoApprove || hostBalanceCanAutoApprove ||
        inlineRegistrationCanAutoApprove
        ? "auto_approved"
        : "manual_review";
    let confidence = result === "auto_approved" ? ocrConfidence : 0.5;
    const route = provider === "gcash"
      ? "gcash"
      : provider === "bdopay" || provider === "maya" || provider === "bpi" ||
          provider === "gotyme" ||
          provider === "maribank"
      ? `${provider}_to_gcash`
      : provider;
    const verification = {
      decision: cleanEvidence ? "valid" : "review",
      sourceProviderMatch,
      referenceMatch,
      amountMatch,
      timestampValid,
      recipientMatch,
      duplicateClear,
      destinationProvider: providerParse?.destinationProvider || null,
    };

    const extracted = {
      ref: extractedRef,
      invoice: extractedInvoice,
      bdopayReferenceDate: providerParse?.provider === "bdopay"
        ? providerParse.receipt.reference.receiptDate
        : null,
      instapayRefNo: extractedInstapayRefNo,
      bpiConfirmationNo: provider === "bpi" ? extractedRef : null,
      bpiTransactionRefNo: extractedBpiTransactionRefNo,
      amount: extractedAmount,
      amountReliable: amountExtraction?.reliable ?? (extractedAmount != null),
      amountAmbiguous: amountExtraction?.ambiguous ?? false,
      amountReason: amountExtraction?.reason || "legacy_parser",
      amountEvidence: amountExtraction?.evidence || [],
      amountCandidates: amountExtraction?.candidates.map((candidate) => ({
        amount: candidate.amount,
        score: candidate.score,
        evidence: candidate.evidence,
        excluded: candidate.excluded,
        exclusionReasons: candidate.exclusionReasons,
      })) || [],
      date: receiptDate,
      time: receiptDateTime ? receiptDateTime.toISOString() : null,
      timePh12: providerParse
        ? formatPhInstantDateTime12(receiptDateTime)
        : formatPhDateTime12(receiptDateTime),
      bookingStartedAt: bookingStartedAt
        ? bookingStartedAt.toISOString()
        : null,
      bookingStartedAtPh12: providerParse
        ? formatPhInstantDateTime12(bookingStartedAt)
        : formatPhDateTime12(bookingStartedAt),
      bookingStartedDate,
      receiptAgeMinutes,
      allowedPaymentWindowMinutes: PAYMENT_WINDOW_MINUTES,
      allowedPaymentEarlyToleranceMinutes: PAYMENT_EARLY_TOLERANCE_MINUTES,
      expectedAmount,
      expectedTotal,
      autoPaymentStatus,
      provider,
      route,
      parserVersion: providerParse?.parserVersion || "legacy",
      verifierVersion: "receipt_evidence_v1",
      verification,
      gcash: gcashParse
        ? {
          reference: gcashParse.reference,
          amount: {
            value: gcashParse.amount.amount,
            reliable: gcashParse.amount.reliable,
            ambiguous: gcashParse.amount.ambiguous,
            reason: gcashParse.amount.reason,
            conflictingPrimaryAmounts:
              gcashParse.amount.conflictingPrimaryAmounts,
            matchingPrimaryAmountDisplays:
              gcashParse.amount.matchingPrimaryAmountDisplays,
          },
          timestamp: gcashParse.timestamp,
          receiver: gcashParse.receiver,
          recipientComparison: gcashRecipient,
          indicators: gcashParse.indicators,
          issues: gcashParse.issues,
        }
        : null,
      bankTransfer: bankParse
        ? {
          reference: bankParse.reference,
          invoice: "invoice" in bankParse ? bankParse.invoice : null,
          transferFee: "transferFee" in bankParse
            ? bankParse.transferFee
            : null,
          railReference: "railReference" in bankParse
            ? bankParse.railReference
            : null,
          transactionReference: "transactionReference" in bankParse
            ? bankParse.transactionReference
            : null,
          amount: {
            value: bankParse.amount.amount,
            reliable: bankParse.amount.reliable,
            ambiguous: bankParse.amount.ambiguous,
            reason: bankParse.amount.reason,
          },
          timestamp: bankParse.timestamp,
          recipient: bankParse.recipient,
          indicators: bankParse.indicators,
          recipientComparison: providerVerification?.provider === "bpi" ||
              providerVerification?.provider === "maya" ||
              providerVerification?.provider === "bdopay" ||
              providerVerification?.provider === "gotyme" ||
              providerVerification?.provider === "maribank"
            ? providerVerification.recipientComparison
            : null,
          recipientAccountComparison: providerVerification?.provider === "bpi"
            ? providerVerification.recipientAccountComparison
            : null,
          issues: bankParse.issues,
        }
        : null,
      ocrProvider,
      ocrPrimaryProvider,
      ocrFallbackProvider,
      ocrFallbackReason,
      ocrConfidence,
      ocrConfidenceSource,
      ocrTextLength: ocrText.length,
      expectedReceiverNumber: provider === "bdopay" || provider === "maya"
        ? null
        : expectedNumber || null,
      expectedReceiverName: expectedName || null,
      expectedQrReceiverName: provider === "bpi"
        ? settings.gcash_qr_receipt_recipient_name ||
          settings.bpi_receipt_recipient_name || null
        : null,
      expectedReceiverAccount: provider === "bdopay" || provider === "bpi"
        ? settings.gcash_qr_receipt_destination_token ||
          settings.bdopay_receipt_destination_token || null
        : null,
      verificationContext: hasPersistedBooking
        ? "court_booking"
        : inlinePricingKind === "host_session"
        ? "host_session"
        : inlinePricingKind === "host_booking_balance"
        ? "host_booking_balance"
        : "open_play",
      subject: {
        fullName: String(
          booking.full_name || booking.fullName || "",
        ).trim(),
        bookingDate: String(booking.date || "").slice(0, 10),
        courtId: String(booking.court_id || booking.courtId || "").trim() ||
          null,
        hour: Number.isInteger(Number(booking.hour))
          ? Number(booking.hour)
          : null,
        sessionId: String(
          booking.host_session_id || booking.hostSessionId || "",
        ).trim() || null,
      },
      ...(inlinePricingKind === "host_booking_balance"
        ? { balancePaymentId: String(hostBalancePayment?.id || "") }
        : {}),
      submittedReference: typedRef,
      dedupeKeys: dedupeKeys.map(({ key, providerKey }) => ({
        key,
        providerKey,
      })),
    };

    // ── persist outcome on the booking ──────────────────────────────────────
    const receiptVerifiedAt = new Date().toISOString();
    const statusUpdate: Record<string, unknown> = {};
    const metadataUpdate: Record<string, unknown> = {
      receipt_image_url: objectPath,
      receipt_image_hash: imageHash,
      receipt_phash: phash,
      receipt_extracted: extracted,
      receipt_verified_at: receiptVerifiedAt,
    };
    const refreshOutcomeUpdates = () => {
      delete statusUpdate.status;
      delete statusUpdate.payment_status;
      delete statusUpdate.paid_at;
      if (result === "auto_approved") {
        statusUpdate.status = "confirmed";
        statusUpdate.payment_status = autoPaymentStatus;
        statusUpdate.paid_at = receiptVerifiedAt;
      } else {
        statusUpdate.status = "pending";
        statusUpdate.payment_status = "for_verification";
      }
      metadataUpdate.receipt_status = result;
      metadataUpdate.receipt_flags = flags;
      metadataUpdate.receipt_confidence = confidence;
    };
    refreshOutcomeUpdates();

    let finalUpdateError: string | null = null;
    let auditPersisted = false;
    let finalPaymentStatus = String(statusUpdate.payment_status || "");
    let finalBookingStatus = String(statusUpdate.status || "");

    // Skip DB update when booking hasn't been saved yet (pre-save verification flow).
    if (hasPersistedBooking) {
      if (result === "auto_approved") {
        const { data: finalizedRows, error: finalizeError } = await db.rpc(
          "finalize_digital_receipt_auto_approval",
          {
            p_booking_ref: bookingRef,
            p_booking_refs: [...bookingGroupRefs].sort(),
            p_lease_key: receiptLeaseKey,
            p_lease_token: receiptLeaseToken,
            p_provider: provider,
            p_payment_reference: typedRef,
            p_payment_status: autoPaymentStatus,
            p_receipt_image_url: objectPath,
            p_receipt_image_hash: imageHash,
            p_receipt_phash: phash,
            p_receipt_flags: flags,
            p_receipt_extracted: extracted,
            p_receipt_confidence: confidence,
            p_receipt_verified_at: receiptVerifiedAt,
            p_raw_ocr_text: ocrText || null,
          },
        );
        if (finalizeError) {
          const finalizeMessage = errMsg(finalizeError);
          // Any failed precondition, ledger race, or database error is
          // uncertainty. Hold the slot for an owner; never auto-reject.
          if (/already been used for another payment/i.test(finalizeMessage)) {
            if (!flags.includes("DUPLICATE_REF")) flags.push("DUPLICATE_REF");
            duplicateClear = false;
            verification.duplicateClear = false;
          }
          if (!flags.includes("AUTO_APPROVAL_FAILED")) {
            flags.push("AUTO_APPROVAL_FAILED");
          }
          verification.decision = "review";
          result = "manual_review";
          confidence = 0.5;
          refreshOutcomeUpdates();
          finalPaymentStatus = String(statusUpdate.payment_status || "");
          finalBookingStatus = String(statusUpdate.status || "");
          console.error(
            "Digital receipt auto-approval finalization failed:",
            finalizeMessage,
          );
        } else {
          auditPersisted = true;
          const finalized = Array.isArray(finalizedRows)
            ? finalizedRows.find((row) =>
              String(row.booking_ref) === bookingRef
            ) ||
              finalizedRows[0]
            : finalizedRows;
          finalPaymentStatus = String(
            finalized?.booking_payment_status || autoPaymentStatus || "",
          );
          finalBookingStatus = String(
            finalized?.booking_status || "confirmed",
          );
        }
      }

      if (isDedicatedReceiptProvider(provider) && result === "manual_review") {
        const finalizeReview = async () =>
          await db.rpc("finalize_digital_receipt_review", {
            p_booking_ref: bookingRef,
            p_booking_refs: [...bookingGroupRefs].sort(),
            p_lease_key: receiptLeaseKey,
            p_lease_token: receiptLeaseToken,
            p_provider: provider,
            p_payment_reference: typedRef,
            p_receipt_image_url: objectPath,
            p_receipt_image_hash: imageHash,
            p_receipt_phash: phash,
            p_receipt_flags: flags,
            p_receipt_extracted: extracted,
            p_receipt_confidence: confidence,
            p_receipt_verified_at: receiptVerifiedAt,
            p_raw_ocr_text: ocrText || null,
          });

        const reviewResponse = await finalizeReview();

        if (reviewResponse.error) {
          finalUpdateError = errMsg(reviewResponse.error);
          console.error(
            "Digital receipt review finalization failed:",
            finalUpdateError,
          );

          // A stale lease commonly means a newer verifier or administrator
          // already completed the booking. Return that canonical terminal
          // state so the browser never downgrades it to pending.
          const { data: currentRow } = await db.from("bookings")
            .select(
              "status,payment_status,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_image_url,receipt_image_hash,receipt_phash,receipt_verified_at",
            )
            .eq("ref", bookingRef)
            .maybeSingle();
          const currentStatus = String(currentRow?.status || "");
          const currentPayment = String(currentRow?.payment_status || "");
          const terminalRejected = currentStatus === "cancelled" ||
            currentPayment === "rejected";
          const terminalApproved =
            ["confirmed", "completed", "forfeited"].includes(currentStatus) ||
            ["paid", "downpayment_paid", "deposit_retained"].includes(
              currentPayment,
            );
          if (terminalRejected || terminalApproved) {
            const persistedResult = terminalRejected
              ? "rejected"
              : "auto_approved";
            return json({
              ok: true,
              status: persistedResult,
              flags: [],
              publicReason: publicReceiptMessage(
                persistedResult,
                Array.isArray(currentRow?.receipt_flags)
                  ? currentRow.receipt_flags
                  : [],
              ),
              extracted: currentRow?.receipt_extracted || null,
              confidence: currentRow?.receipt_confidence ?? null,
              receiptImageUrl: currentRow?.receipt_image_url || null,
              receiptImageHash: currentRow?.receipt_image_hash || null,
              receiptPhash: currentRow?.receipt_phash || null,
              receiptVerifiedAt: currentRow?.receipt_verified_at || null,
              paymentStatus: currentPayment || null,
              bookingStatus: currentStatus || null,
              message:
                "This booking was already processed by another verification request.",
            });
          }
        } else {
          auditPersisted = true;
          const reviewRows = reviewResponse.data;
          const finalized = Array.isArray(reviewRows)
            ? reviewRows.find((row) =>
              String(row.booking_ref) === bookingRef
            ) || reviewRows[0]
            : reviewRows;
          finalPaymentStatus = String(
            finalized?.booking_payment_status ||
              statusUpdate.payment_status ||
              "",
          );
          finalBookingStatus = String(
            finalized?.booking_status || statusUpdate.status || "",
          );
        }
      }

      if (!isDedicatedReceiptProvider(provider) && result === "manual_review") {
        // Metadata and final status must be one conditional update. This acts as
        // a compare-and-set: one concurrent verifier can finalize a row, while a
        // later verifier cannot overwrite that terminal outcome or its evidence.
        const finalUpdate = { ...metadataUpdate, ...statusUpdate };
        const { data: updatedRows, error: updateErr } =
          await bookingUpdateQuery(
            db,
            booking,
            finalUpdate,
            bookingMutationScope,
          )
            .in("status", ["verifying", "pending"])
            .in("payment_status", ["unpaid", "pending", "for_verification"])
            .eq("receipt_image_hash", imageHash)
            .select("ref, status, payment_status");
        if (updateErr) {
          finalUpdateError = errMsg(updateErr);
          console.error("booking FINAL update failed:", finalUpdateError);
        } else if (!updatedRows || updatedRows.length === 0) {
          // A zero-row CAS commonly means a concurrent request already finalized
          // the booking. Confirm that before reporting a persistence failure.
          const { data: currentRow } = await db.from("bookings")
            .select(
              "status,payment_status,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_image_url,receipt_image_hash,receipt_phash,receipt_verified_at",
            )
            .eq("ref", bookingRef)
            .maybeSingle();
          const currentStatus = String(currentRow?.status || "");
          const currentPayment = String(currentRow?.payment_status || "");
          const concurrentlyFinalized =
            ["confirmed", "cancelled", "completed", "forfeited"].includes(
              currentStatus,
            ) ||
            ["paid", "downpayment_paid", "deposit_retained", "rejected"]
              .includes(
                currentPayment,
              );
          if (concurrentlyFinalized) {
            const persistedReceiptStatus = String(
              currentRow?.receipt_status || "",
            );
            const persistedResult = persistedReceiptStatus === "rejected" ||
                currentStatus === "cancelled" || currentPayment === "rejected"
              ? "rejected"
              : persistedReceiptStatus === "manual_review"
              ? "manual_review"
              : "auto_approved";
            return json({
              ok: true,
              status: persistedResult,
              flags: [],
              publicReason: publicReceiptMessage(
                persistedResult,
                Array.isArray(currentRow?.receipt_flags)
                  ? currentRow.receipt_flags
                  : [],
              ),
              extracted: currentRow?.receipt_extracted || null,
              confidence: currentRow?.receipt_confidence ?? null,
              receiptImageUrl: currentRow?.receipt_image_url || null,
              receiptImageHash: currentRow?.receipt_image_hash || null,
              receiptPhash: currentRow?.receipt_phash || null,
              receiptVerifiedAt: currentRow?.receipt_verified_at || null,
              paymentStatus: currentPayment || null,
              bookingStatus: currentStatus || null,
              message:
                "This booking was already processed by another verification request.",
            });
          } else {
            finalUpdateError = `No non-terminal row matched ref=${bookingRef}`;
            console.error(finalUpdateError);
          }
        } else {
          const updated = updatedRows.find((row: Record<string, unknown>) =>
            String(row.ref || "") === bookingRef
          ) || updatedRows[0];
          finalPaymentStatus = String(
            updated?.payment_status || statusUpdate.payment_status || "",
          );
          finalBookingStatus = String(
            updated?.status || statusUpdate.status || "",
          );
        }
      }
    }

    // ── audit trail (immutable) ─────────────────────────────────────────────
    let receiptVerificationId: number | null = null;
    if (!auditPersisted) {
      const { data: auditRow, error: auditError } = await db.from(
        "receipt_verifications",
      )
        .insert({
          booking_ref: bookingRef,
          result,
          flags,
          extracted,
          confidence,
          image_hash: imageHash,
          phash,
          raw_ocr_text: ocrText || null,
        })
        .select("id")
        .single();
      if (auditError) {
        console.error(
          "receipt verification audit insert failed:",
          errMsg(auditError),
        );
        if (
          result === "auto_approved" &&
          (!hasPersistedBooking ||
            inlinePricingKind === "host_booking_balance")
        ) {
          throw new Error(
            "Receipt verification could not be recorded. Please upload the receipt again.",
          );
        }
      } else {
        receiptVerificationId = Number(auditRow?.id) || null;
      }
    }

    // ── alert admin on anything needing a human ─────────────────────────────
    if (result === "manual_review" && hasPersistedBooking) {
      const paymentLabel = String(booking.payment_method || "digital")
        .toUpperCase();
      const displayRef = String(
        booking.booking_group_ref || bookingRef,
      );
      const alertCourts = uniqueBookingRows(bookingGroup).sort((a, b) =>
        String(a.court_name || "").localeCompare(
          String(b.court_name || ""),
          "en",
          { numeric: true },
        )
      );
      const totalHours = alertCourts.reduce(
        (sum, row) => sum + telegramCourtHours(row),
        0,
      );
      const dates = [
        ...new Set(alertCourts.map((row) => String(row.date || ""))),
      ].filter(Boolean);
      const sharedDate = dates.length === 1 ? dates[0] : "";
      const courtLines = alertCourts.map((row, index) => {
        const courtName = String(row.court_name || `Court ${index + 1}`);
        const datePrefix = sharedDate ? "" : `${telegramDate(row.date)} · `;
        return `🎾 ${escapeTelegramHtml(courtName)} · ${
          escapeTelegramHtml(datePrefix)
        }${escapeTelegramHtml(row.start_time || "")}–${
          escapeTelegramHtml(row.end_time || "")
        } · ${telegramPeso(row.total)}`;
      }).join("\n");
      const courtCountLabel = `${alertCourts.length} ${
        alertCourts.length === 1 ? "court" : "courts"
      } · ${telegramHours(totalHours)} ${
        alertCourts.length === 1 ? "hours" : "court-hours"
      }`;
      const totalPayment = expectedTotal || expectedAmount;
      await sendTelegram(
        `⚠️ <b>PAYMENT REVIEW</b>\n` +
          `👤 Player: ${escapeTelegramHtml(booking.full_name || "Player")}\n` +
          `📋 Ref: <code>${escapeTelegramHtml(displayRef)}</code>\n` +
          `💳 Payment: ${escapeTelegramHtml(paymentLabel)}\n` +
          `🕒 Submitted: ${
            escapeTelegramHtml(telegramDateTime(booking.created_at))
          }\n` +
          `🚩 Issue: ${escapeTelegramHtml(shortTelegramFlags(flags))}\n\n` +
          `🏟️ <b>COURT SCHEDULE</b>\n` +
          `${courtCountLabel}\n` +
          (sharedDate ? `📅 ${telegramDate(sharedDate)}\n` : "") +
          `${courtLines}\n` +
          `💰 <b>TOTAL PAYMENT: ${telegramPeso(totalPayment)}</b>\n\n` +
          `🔗 <a href="${telegramAdminUrl()}">Open the Paddle Rage dashboard</a>`,
      );
    }

    return json({
      ok: true,
      status: result,
      flags: [],
      publicReason: publicReceiptMessage(result, flags),
      extracted,
      confidence,
      receiptImageUrl: objectPath,
      receiptImageHash: imageHash,
      receiptPhash: phash,
      receiptVerifiedAt: metadataUpdate.receipt_verified_at,
      ...(receiptVerificationId ? { receiptVerificationId } : {}),
      paymentStatus: hasPersistedBooking ? finalPaymentStatus || null : null,
      bookingStatus: hasPersistedBooking ? finalBookingStatus || null : null,
      ...(finalUpdateError
        ? { warning: `booking update failed: ${finalUpdateError}` }
        : {}),
      message: result === "auto_approved"
        ? hasPersistedBooking
          ? "Payment verified. Your booking is confirmed."
          : "Payment verified. Complete the registration to save it."
        : "Received — the owner will verify your payment shortly.",
    });
  } catch (err) {
    console.error("verify-gcash-receipt error:", errMsg(err));
    return json({ error: errMsg(err) }, 500);
  } finally {
    if (receiptLeaseKey && receiptLeaseToken) {
      const { error: releaseError } = await db.rpc(
        "release_receipt_verification_lease",
        {
          p_booking_key: receiptLeaseKey,
          p_claim_token: receiptLeaseToken,
        },
      );
      if (releaseError) {
        console.error(
          "receipt verification lease release failed:",
          errMsg(releaseError),
        );
      }
    }
  }
});
