import { Temporal } from "@js-temporal/polyfill";
import { RequestError } from "./http.ts";
import { requireHighEntropySecret, secretsMatch } from "./security.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function openPlayServerTime(now: Date = new Date()): string {
  return now.toISOString();
}

export function withOpenPlayServerTime<T extends Record<string, unknown>>(
  payload: T,
  now: Date = new Date(),
): T & { serverTime: string } {
  return { ...payload, serverTime: openPlayServerTime(now) };
}

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

export function parseOpenPlayUuid(
  value: unknown,
  code = "OPEN_PLAY_ID_INVALID",
  message = "A valid Open Play identifier is required.",
): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(id)) throw new RequestError(400, code, message);
  return id;
}

export function parseOpenPlayRequestId(value: unknown): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_V4_PATTERN.test(id)) {
    throw new RequestError(
      400,
      "CLIENT_REQUEST_ID_INVALID",
      "A valid client request identifier is required.",
    );
  }
  return id;
}

export function parseOpenPlayReference(value: unknown): string {
  const reference = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^OP-[A-Z0-9]{8,32}$/.test(reference)) {
    throw new RequestError(
      400,
      "OPEN_PLAY_REFERENCE_INVALID",
      "A valid Open Play reference is required.",
    );
  }
  return reference;
}

export async function deriveOpenPlayAccessToken(options: {
  secret: string;
  tenantId: string;
  clientRequestId: string;
}): Promise<string> {
  const secret = requireHighEntropySecret(
    "BOOKING_ACCESS_TOKEN_SECRET",
    options.secret,
  );
  const tenantId = parseOpenPlayUuid(
    options.tenantId,
    "TENANT_INVALID",
    "The tenant is invalid.",
  );
  const clientRequestId = parseOpenPlayRequestId(options.clientRequestId);
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
      `open-play-access:v2:${tenantId}:${clientRequestId}`,
    ),
  );
  const token = base64Url(new Uint8Array(signature));
  if (!ACCESS_TOKEN_PATTERN.test(token)) {
    throw new Error("Open Play access token generation failed.");
  }
  return token;
}

export function parseOpenPlayAccessToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!ACCESS_TOKEN_PATTERN.test(token)) {
    throw new RequestError(
      401,
      "OPEN_PLAY_ACCESS_DENIED",
      "The Open Play reference or access token is invalid.",
    );
  }
  return token;
}

export async function openPlayAccessTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return hex(new Uint8Array(digest));
}

export async function verifyOpenPlayAccessToken(options: {
  token: string;
  expectedHash: unknown;
}): Promise<void> {
  const expectedHash = typeof options.expectedHash === "string"
    ? options.expectedHash.trim().toLowerCase()
    : "";
  if (!SHA256_PATTERN.test(expectedHash)) {
    throw new RequestError(
      401,
      "OPEN_PLAY_ACCESS_DENIED",
      "The Open Play reference or access token is invalid.",
    );
  }
  const actualHash = await openPlayAccessTokenHash(options.token);
  if (!await secretsMatch(actualHash, expectedHash)) {
    throw new RequestError(
      401,
      "OPEN_PLAY_ACCESS_DENIED",
      "The Open Play reference or access token is invalid.",
    );
  }
}

export function buildOpenPlayRange(options: {
  date: string;
  startTime: string;
  endTime: string;
  timeZone: string;
}): { startsAt: string; endsAt: string } {
  const date = String(options.date ?? "").trim();
  const startTime = String(options.startTime ?? "").trim();
  const endTime = String(options.endTime ?? "").trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(startTime) ||
    !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(endTime) ||
    endTime <= startTime
  ) {
    throw new RequestError(
      422,
      "OPEN_PLAY_TIME_INVALID",
      "Choose a valid same-day Open Play time in 30-minute increments.",
    );
  }
  try {
    const start = Temporal.PlainDateTime.from(`${date}T${startTime}:00`)
      .toZonedDateTime(options.timeZone, { disambiguation: "reject" })
      .toInstant();
    const end = Temporal.PlainDateTime.from(`${date}T${endTime}:00`)
      .toZonedDateTime(options.timeZone, { disambiguation: "reject" })
      .toInstant();
    if (
      Temporal.Instant.compare(end, start) <= 0 ||
      end.since(start).total("hours") < 0.5 ||
      end.since(start).total("hours") > 12
    ) {
      throw new Error("range");
    }
    return { startsAt: start.toString(), endsAt: end.toString() };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(
      422,
      "OPEN_PLAY_TIME_INVALID",
      "Choose a valid same-day Open Play time in 30-minute increments.",
    );
  }
}
