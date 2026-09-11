import { RequestError } from "./http.ts";
import { requireHighEntropySecret, secretsMatch } from "./security.ts";

const BOOKING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Produce a stable opaque token for an idempotent booking request. The input
 * contains no secret; the uncommitted Edge Function secret supplies all token
 * entropy. Repeating the same idempotency key therefore returns the same token.
 */
export async function deriveBookingAccessToken(options: {
  secret: string;
  tenantId: string;
  clientRequestId: string;
}): Promise<string> {
  const secret = requireHighEntropySecret(
    "BOOKING_ACCESS_TOKEN_SECRET",
    options.secret,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `booking-access:v1:${options.tenantId}:${options.clientRequestId}`,
    ),
  );
  const token = base64Url(new Uint8Array(signature));
  if (!BOOKING_TOKEN_PATTERN.test(token)) {
    throw new Error("Booking access token generation failed.");
  }
  return token;
}

/**
 * Derive a resendable but never-stored public credential for one balance
 * request. The UUID is public; the Edge Function secret supplies the entropy.
 */
export async function deriveBalancePaymentAccessToken(options: {
  secret: string;
  tenantId: string;
  balanceRequestId: string;
}): Promise<string> {
  const secret = requireHighEntropySecret(
    "BOOKING_ACCESS_TOKEN_SECRET",
    options.secret,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `booking-balance-access:v1:${options.tenantId}:${options.balanceRequestId}`,
    ),
  );
  const token = base64Url(new Uint8Array(signature));
  if (!BOOKING_TOKEN_PATTERN.test(token)) {
    throw new Error("Balance payment access token generation failed.");
  }
  return token;
}

export function parseBookingAccessToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!BOOKING_TOKEN_PATTERN.test(token)) {
    throw new RequestError(
      401,
      "BOOKING_ACCESS_DENIED",
      "The booking access token is invalid.",
    );
  }
  return token;
}

export async function bookingAccessTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return hex(new Uint8Array(digest));
}

export async function verifyBookingAccessToken(options: {
  token: string;
  expectedHash: unknown;
}): Promise<void> {
  const expectedHash = typeof options.expectedHash === "string"
    ? options.expectedHash.toLowerCase()
    : "";
  if (!SHA256_PATTERN.test(expectedHash)) {
    throw new RequestError(
      401,
      "BOOKING_ACCESS_DENIED",
      "The booking access token is invalid.",
    );
  }
  const actualHash = await bookingAccessTokenHash(options.token);
  if (!await secretsMatch(actualHash, expectedHash)) {
    throw new RequestError(
      401,
      "BOOKING_ACCESS_DENIED",
      "The booking access token is invalid.",
    );
  }
}
