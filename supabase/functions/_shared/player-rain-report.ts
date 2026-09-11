import {
  bookingAccessTokenHash,
  parseBookingAccessToken,
} from "./booking-access.ts";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  readJsonObject,
  RequestError,
} from "./http.ts";
import { requireHighEntropySecret, secretsMatch } from "./security.ts";
import { normalizeTenantSlug, type TenantRequestContext } from "./tenant.ts";

export type JsonObject = Record<string, unknown>;

export const RAIN_PROOF_BUCKET = "tenant-private";
export const MAX_RAIN_PROOF_BYTES = 8 * 1024 * 1024;
export const MAX_RAIN_PROOF_MULTIPART_BYTES = MAX_RAIN_PROOF_BYTES + 96 * 1024;

const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START_KEYS = new Set([
  "action",
  "tenantSlug",
  "bookingReference",
  "clientRequestId",
  "bookingToken",
  "bookingContact",
]);
const STATUS_KEYS = new Set([
  "action",
  "tenantSlug",
  "claimId",
  "claimToken",
]);
const PUBLIC_CLAIM_KEYS = new Set([
  "id",
  "status",
  "bookingReference",
  "courtId",
  "courtName",
  "bookingDate",
  "bookingStartsAt",
  "bookingEndsAt",
  "rainReportedAt",
  "proofDueAt",
  "elapsedSeconds",
  "elapsedMinutes",
  "ruleVersion",
  "refundPercent",
  "paidAmount",
  "grossPaidAmount",
  "courtRentalAmount",
  "equipmentRentalAmount",
  "platformBookingFeeAmount",
  "refundableBasisAmount",
  "calculationBasis",
  "estimatedRefundAmount",
  "refundAmount",
  "currency",
  "proofAvailable",
  "reportNote",
  "submittedAt",
  "decidedAt",
  "decisionStatus",
  "actualPlayStartedAt",
  "actualPlayStartOverridden",
  "incidentId",
  "payoutStatus",
  "payoutSentAt",
]);

export type PlayerRainBooking = {
  id: string;
  reference: string;
  customerEmail: string | null;
  customerPhone: string;
  accessTokenHash: string | null;
  accessTokenExpiresAt: string | null;
};

export interface PlayerRainReportStore {
  resolveTenant(
    tenantSlug: unknown,
    originHeader: string | null,
  ): Promise<TenantRequestContext>;
  findBooking(
    tenantId: string,
    bookingReference: string,
  ): Promise<PlayerRainBooking | null>;
  startClaim(options: {
    tenantId: string;
    bookingId: string;
    bookingReference: string;
    clientRequestId: string;
    claimTokenHash: string;
    accessMethod: "booking_token" | "booking_contact_turnstile";
    turnstileHostname: string | null;
    turnstileChallengeAt: string | null;
  }): Promise<{ claim: JsonObject; idempotent: boolean }>;
  getClaim(options: {
    tenantId: string;
    claimId: string;
    claimTokenHash: string;
  }): Promise<JsonObject>;
  uploadProof(options: {
    tenantId: string;
    claimId: string;
    bytes: Uint8Array;
    contentType: string;
    extension: string;
  }): Promise<string>;
  removeProof(storagePath: string): Promise<void>;
  submitProof(options: {
    tenantId: string;
    claimId: string;
    claimTokenHash: string;
    storagePath: string;
    contentType: string;
    sizeBytes: number;
    fileSha256: string;
    reportNote: string | null;
    payoutAccountName: string;
    payoutMobileNumber: string;
  }): Promise<{ claim: JsonObject; idempotent: boolean }>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export type PlayerRainPayoutDestination = {
  method: "gcash";
  accountName: string;
  mobileNumber: string;
};

/**
 * Defense-in-depth allowlist for every player-facing claim response. The
 * database public formatter uses the same boundary, but keeping it here means
 * a future SQL/store regression still cannot expose payout or evidence data.
 */
export function playerRainPublicClaimPayload(value: unknown): JsonObject {
  const claim = objectValue(value);
  const result: JsonObject = {};
  for (const key of PUBLIC_CLAIM_KEYS) {
    if (Object.hasOwn(claim, key)) result[key] = claim[key];
  }
  return result;
}

export function parsePlayerRainPayoutDestination(
  value: unknown,
): PlayerRainPayoutDestination {
  if (typeof value !== "string" || value.length < 2 || value.length > 512) {
    throw new RequestError(
      400,
      "RAIN_PAYOUT_DESTINATION_INVALID",
      "Enter the GCash account name and Philippine mobile number.",
    );
  }
  let parsed: JsonObject;
  try {
    parsed = objectValue(JSON.parse(value));
  } catch {
    throw new RequestError(
      400,
      "RAIN_PAYOUT_DESTINATION_INVALID",
      "Enter the GCash account name and Philippine mobile number.",
    );
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== 3 ||
    keys.some((key) =>
      key !== "method" && key !== "accountName" && key !== "mobileNumber"
    ) ||
    text(parsed.method).toLowerCase() !== "gcash"
  ) {
    throw new RequestError(
      400,
      "RAIN_PAYOUT_DESTINATION_INVALID",
      "GCash is the supported rain-refund destination.",
    );
  }

  const rawName = typeof parsed.accountName === "string"
    ? parsed.accountName
    : "";
  const accountName = rawName.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    [...accountName].length < 2 || [...accountName].length > 100 ||
    /[\p{Cc}\p{Cf}]/u.test(accountName)
  ) {
    throw new RequestError(
      400,
      "GCASH_ACCOUNT_NAME_INVALID",
      "Enter the complete name registered to the GCash account.",
    );
  }

  const rawMobile = typeof parsed.mobileNumber === "string"
    ? parsed.mobileNumber.trim()
    : "";
  if (
    rawMobile.length < 11 || rawMobile.length > 24 ||
    !/^[0-9+() -]+$/.test(rawMobile)
  ) {
    throw new RequestError(
      400,
      "GCASH_MOBILE_INVALID",
      "Enter a valid Philippine GCash mobile number.",
    );
  }
  const compactMobile = rawMobile.replace(/[ ()-]/g, "");
  const mobileNumber = /^09[0-9]{9}$/.test(compactMobile)
    ? `+63${compactMobile.slice(1)}`
    : /^639[0-9]{9}$/.test(compactMobile)
    ? `+${compactMobile}`
    : /^\+639[0-9]{9}$/.test(compactMobile)
    ? compactMobile
    : "";
  if (!mobileNumber) {
    throw new RequestError(
      400,
      "GCASH_MOBILE_INVALID",
      "Enter a valid Philippine GCash mobile number.",
    );
  }
  return { method: "gcash", accountName, mobileNumber };
}

function assertOnlyKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RequestError(
      400,
      "RAIN_REPORT_FIELDS_INVALID",
      "The rain report contains an unsupported field.",
    );
  }
}

export function parsePlayerRainBookingReference(value: unknown): string {
  const reference = text(value).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(reference)) {
    throw new RequestError(
      400,
      "BOOKING_REFERENCE_INVALID",
      "A valid booking reference is required.",
    );
  }
  return reference;
}

export function parsePlayerRainUuid(
  value: unknown,
  code: string,
  message: string,
): string {
  const id = text(value).toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new RequestError(400, code, message);
  return id;
}

export function parsePlayerRainClaimToken(value: unknown): string {
  const token = text(value);
  if (!OPAQUE_TOKEN_PATTERN.test(token)) {
    throw new RequestError(
      401,
      "RAIN_REPORT_ACCESS_DENIED",
      "The rain report could not be verified.",
    );
  }
  return token;
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

export async function playerRainTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const value = hex(new Uint8Array(digest));
  if (!SHA256_PATTERN.test(value)) throw new Error("Token hashing failed.");
  return value;
}

export async function derivePlayerRainClaimToken(options: {
  secret: string;
  tenantId: string;
  bookingId: string;
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
      `player-rain-claim:v1:${options.tenantId}:${options.bookingId}:${options.clientRequestId}`,
    ),
  );
  const token = base64Url(new Uint8Array(signature));
  if (!OPAQUE_TOKEN_PATTERN.test(token)) {
    throw new Error("Player rain claim token generation failed.");
  }
  return token;
}

function parseBookingContact(value: unknown): string {
  const contact = text(value);
  const hasControl = [...contact].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (contact.length < 5 || contact.length > 254 || hasControl) {
    throw new RequestError(
      400,
      "BOOKING_CONTACT_INVALID",
      "Enter the exact email address or phone number used for the booking.",
    );
  }
  return contact;
}

export async function playerRainContactMatches(
  submitted: string,
  booking: Pick<PlayerRainBooking, "customerEmail" | "customerPhone">,
): Promise<boolean> {
  const emailCandidate = submitted.includes("@")
    ? submitted.trim().toLowerCase()
    : "";
  const savedEmail = String(booking.customerEmail ?? "").trim().toLowerCase();
  const phoneCandidate = submitted.includes("@") ? "" : submitted.trim();
  const savedPhone = String(booking.customerPhone ?? "").trim();
  const [emailMatch, phoneMatch] = await Promise.all([
    secretsMatch(emailCandidate, savedEmail),
    secretsMatch(phoneCandidate, savedPhone),
  ]);
  return emailMatch || phoneMatch;
}

export type RainProofImage = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
};

export function inspectRainProofImage(
  bytes: Uint8Array,
  claimedType: string,
): RainProofImage {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RAIN_PROOF_BYTES) {
    throw new RequestError(
      413,
      "RAIN_PROOF_SIZE_INVALID",
      "The court photo must be 8 MB or smaller.",
    );
  }
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff &&
    bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
  const isWebp = bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  const detected: RainProofImage | null = isJpeg
    ? { contentType: "image/jpeg", extension: "jpg" }
    : isPng
    ? { contentType: "image/png", extension: "png" }
    : isWebp
    ? { contentType: "image/webp", extension: "webp" }
    : null;
  if (
    !detected ||
    detected.contentType !== String(claimedType ?? "").trim().toLowerCase()
  ) {
    throw new RequestError(
      415,
      "RAIN_PROOF_TYPE_INVALID",
      "Use a valid JPEG, PNG, or WebP court photo.",
    );
  }
  return detected;
}

function parseReportNote(value: unknown): string | null {
  const note = text(value);
  if (!note) return null;
  if (note.length < 3 || note.length > 1000) {
    throw new RequestError(
      400,
      "RAIN_REPORT_NOTE_INVALID",
      "The report note must contain 3 to 1000 characters.",
    );
  }
  return note;
}

function tenantSlugForRequest(
  bodySlug: unknown,
  querySlug: string | null,
): unknown {
  if (
    bodySlug !== undefined && querySlug &&
    normalizeTenantSlug(bodySlug) !== normalizeTenantSlug(querySlug)
  ) {
    throw new RequestError(
      400,
      "TENANT_SLUG_MISMATCH",
      "The tenant slug does not match the request URL.",
    );
  }
  return bodySlug ?? querySlug;
}

function accessDenied(): RequestError {
  return new RequestError(
    401,
    "RAIN_REPORT_ACCESS_DENIED",
    "The booking reference or contact details could not be verified.",
  );
}

function mapClaimError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String(objectValue(error).message ?? "").toLowerCase();
  if (message.includes("player_rain_claim_access_denied")) {
    return accessDenied();
  }
  if (message.includes("player_rain_claim_expired")) {
    return new RequestError(
      410,
      "RAIN_REPORT_PROOF_EXPIRED",
      "The 10-minute photo window expired. Start a new rain report.",
    );
  }
  if (message.includes("player_rain_claim_idempotency_conflict")) {
    return new RequestError(
      409,
      "RAIN_REPORT_IDEMPOTENCY_CONFLICT",
      "This rain report request was already used differently.",
    );
  }
  if (message.includes("player_rain_claim_payout_invalid")) {
    return new RequestError(
      400,
      "RAIN_PAYOUT_DESTINATION_INVALID",
      "Enter the GCash account name and Philippine mobile number.",
    );
  }
  if (
    message.includes("player_rain_claim_unavailable") ||
    message.includes("player_rain_claim_invalid") ||
    message.includes("player_rain_claim_proof_invalid")
  ) {
    return new RequestError(
      409,
      "RAIN_REPORT_UNAVAILABLE",
      "This booking cannot accept this rain report.",
    );
  }
  return new RequestError(
    503,
    "RAIN_REPORT_UNAVAILABLE",
    "Rain reporting is temporarily unavailable. Please try again.",
  );
}

export function createPlayerRainReportHandler(
  store: PlayerRainReportStore,
  options: {
    bookingAccessTokenSecret: string;
  },
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let allowedOrigin: string | undefined;
    let uploadedPath: string | null = null;
    let proofReconciliation: {
      tenantId: string;
      claimId: string;
      claimTokenHash: string;
      origin: string;
    } | null = null;
    try {
      if (request.method !== "POST" && request.method !== "OPTIONS") {
        return errorResponse(
          405,
          "METHOD_NOT_ALLOWED",
          "Only POST requests are accepted.",
        );
      }
      const requestUrl = new URL(request.url);
      const queryTenantSlug = requestUrl.searchParams.get("tenantSlug") ??
        request.headers.get("x-tenant-slug");
      if (request.method === "OPTIONS") {
        const context = await store.resolveTenant(
          queryTenantSlug,
          request.headers.get("origin"),
        );
        return noContentResponse(context.origin);
      }

      if (
        text(request.headers.get("x-rain-action")).toLowerCase() === "submit"
      ) {
        const context = await store.resolveTenant(
          queryTenantSlug,
          request.headers.get("origin"),
        );
        allowedOrigin = context.origin;
        const claimId = parsePlayerRainUuid(
          request.headers.get("x-claim-id"),
          "RAIN_REPORT_CLAIM_INVALID",
          "A valid rain report is required.",
        );
        const claimToken = parsePlayerRainClaimToken(
          request.headers.get("x-claim-token"),
        );
        const claimTokenHash = await playerRainTokenHash(claimToken);
        const current = await store.getClaim({
          tenantId: context.tenantId,
          claimId,
          claimTokenHash,
        }).catch((error) => {
          throw mapClaimError(error);
        });
        const currentStatus = text(current.status);
        if (currentStatus !== "awaiting_proof") {
          if (
            currentStatus === "submitted" || currentStatus === "approved" ||
            currentStatus === "rejected"
          ) {
            return jsonResponse(
              {
                ok: true,
                claim: playerRainPublicClaimPayload(current),
                idempotent: true,
              },
              200,
              context.origin,
            );
          }
          throw new RequestError(
            410,
            "RAIN_REPORT_PROOF_EXPIRED",
            "The 10-minute photo window expired. Start a new rain report.",
          );
        }
        const proofDueAt = Date.parse(text(current.proofDueAt));
        if (!Number.isFinite(proofDueAt) || proofDueAt < Date.now()) {
          throw new RequestError(
            410,
            "RAIN_REPORT_PROOF_EXPIRED",
            "The 10-minute photo window expired. Start a new rain report.",
          );
        }

        const contentType =
          request.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.startsWith("multipart/form-data;")) {
          throw new RequestError(
            415,
            "CONTENT_TYPE_REQUIRED",
            "Upload the court photo as form data.",
          );
        }
        const declaredLength = Number(
          request.headers.get("content-length") ?? "0",
        );
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_RAIN_PROOF_MULTIPART_BYTES
        ) {
          throw new RequestError(
            413,
            "RAIN_PROOF_SIZE_INVALID",
            "The court photo must be 8 MB or smaller.",
          );
        }
        const form = await request.formData();
        const keys = Array.from(form.keys());
        if (
          keys.some((key) =>
            key !== "proofFile" && key !== "reportNote" &&
            key !== "payoutDestination"
          ) ||
          form.getAll("proofFile").length !== 1 ||
          form.getAll("reportNote").length > 1 ||
          form.getAll("payoutDestination").length !== 1
        ) {
          throw new RequestError(
            400,
            "RAIN_PROOF_REQUEST_INVALID",
            "The upload must contain one court photo, the GCash refund destination, and an optional note.",
          );
        }
        const proofFile = form.get("proofFile");
        if (!(proofFile instanceof File)) {
          throw new RequestError(
            400,
            "RAIN_PROOF_REQUIRED",
            "Take or choose a photo of the rainy court.",
          );
        }
        const reportNoteValue = form.get("reportNote");
        if (
          reportNoteValue !== null && typeof reportNoteValue !== "string"
        ) {
          throw new RequestError(
            400,
            "RAIN_REPORT_NOTE_INVALID",
            "The report note must be plain text.",
          );
        }
        const reportNote = parseReportNote(reportNoteValue);
        const payoutDestination = parsePlayerRainPayoutDestination(
          form.get("payoutDestination"),
        );
        const bytes = new Uint8Array(await proofFile.arrayBuffer());
        const image = inspectRainProofImage(bytes, proofFile.type);
        uploadedPath = await store.uploadProof({
          tenantId: context.tenantId,
          claimId,
          bytes,
          contentType: image.contentType,
          extension: image.extension,
        });
        proofReconciliation = {
          tenantId: context.tenantId,
          claimId,
          claimTokenHash,
          origin: context.origin,
        };
        const fileSha256 = hex(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        );
        const result = await store.submitProof({
          tenantId: context.tenantId,
          claimId,
          claimTokenHash,
          storagePath: uploadedPath,
          contentType: image.contentType,
          sizeBytes: bytes.byteLength,
          fileSha256,
          reportNote,
          payoutAccountName: payoutDestination.accountName,
          payoutMobileNumber: payoutDestination.mobileNumber,
        }).catch((error) => {
          throw mapClaimError(error);
        });
        uploadedPath = null;
        proofReconciliation = null;
        return jsonResponse(
          {
            ok: true,
            claim: playerRainPublicClaimPayload(result.claim),
            idempotent: result.idempotent,
          },
          result.idempotent ? 200 : 202,
          context.origin,
        );
      }

      const body = await readJsonObject(request, 8_192);
      const context = await store.resolveTenant(
        tenantSlugForRequest(body.tenantSlug, queryTenantSlug),
        request.headers.get("origin"),
      );
      allowedOrigin = context.origin;
      const action = text(body.action).toLowerCase();
      if (action !== "start" && action !== "status") {
        throw new RequestError(
          400,
          "RAIN_REPORT_ACTION_INVALID",
          "Choose start or status.",
        );
      }

      if (action === "status") {
        assertOnlyKeys(body, STATUS_KEYS);
        const claimId = parsePlayerRainUuid(
          body.claimId,
          "RAIN_REPORT_CLAIM_INVALID",
          "A valid rain report is required.",
        );
        const claimTokenHash = await playerRainTokenHash(
          parsePlayerRainClaimToken(body.claimToken),
        );
        const claim = await store.getClaim({
          tenantId: context.tenantId,
          claimId,
          claimTokenHash,
        }).catch((error) => {
          throw mapClaimError(error);
        });
        return jsonResponse(
          { ok: true, claim: playerRainPublicClaimPayload(claim) },
          200,
          context.origin,
        );
      }

      assertOnlyKeys(body, START_KEYS);
      const bookingReference = parsePlayerRainBookingReference(
        body.bookingReference,
      );
      const clientRequestId = parsePlayerRainUuid(
        body.clientRequestId,
        "RAIN_REPORT_REQUEST_INVALID",
        "A valid rain report request ID is required.",
      );
      const hasBookingToken = text(body.bookingToken) !== "";
      const hasBookingContact = text(body.bookingContact) !== "";
      if (hasBookingToken === hasBookingContact) {
        throw new RequestError(
          400,
          "RAIN_REPORT_AUTH_INVALID",
          "Use either the saved booking link or the exact booked contact.",
        );
      }

      let bookingContact = "";
      if (hasBookingContact) {
        bookingContact = parseBookingContact(body.bookingContact);
      }

      const booking = await store.findBooking(
        context.tenantId,
        bookingReference,
      );
      if (!booking) throw accessDenied();
      let accessMethod:
        | "booking_token"
        | "booking_contact_turnstile";
      if (hasBookingToken) {
        const token = parseBookingAccessToken(body.bookingToken);
        const submittedHash = await bookingAccessTokenHash(token);
        const tokenIsCurrent = Boolean(
          booking.accessTokenHash &&
            booking.accessTokenExpiresAt &&
            Date.parse(booking.accessTokenExpiresAt) > Date.now(),
        );
        if (
          !tokenIsCurrent ||
          !await secretsMatch(submittedHash, booking.accessTokenHash ?? "")
        ) {
          throw accessDenied();
        }
        accessMethod = "booking_token";
      } else {
        if (!await playerRainContactMatches(bookingContact, booking)) {
          throw accessDenied();
        }
        accessMethod = "booking_contact_turnstile";
      }

      const claimToken = await derivePlayerRainClaimToken({
        secret: options.bookingAccessTokenSecret,
        tenantId: context.tenantId,
        bookingId: booking.id,
        clientRequestId,
      });
      const result = await store.startClaim({
        tenantId: context.tenantId,
        bookingId: booking.id,
        bookingReference,
        clientRequestId,
        claimTokenHash: await playerRainTokenHash(claimToken),
        accessMethod,
        turnstileHostname: null,
        turnstileChallengeAt: null,
      }).catch((error) => {
        throw mapClaimError(error);
      });
      return jsonResponse(
        {
          ok: true,
          claimToken,
          idempotent: result.idempotent,
          claim: playerRainPublicClaimPayload(result.claim),
        },
        result.idempotent ? 200 : 201,
        context.origin,
      );
    } catch (error) {
      if (uploadedPath && proofReconciliation) {
        try {
          const recorded = await store.getClaim({
            tenantId: proofReconciliation.tenantId,
            claimId: proofReconciliation.claimId,
            claimTokenHash: proofReconciliation.claimTokenHash,
          });
          if (
            recorded.proofAvailable === true &&
            ["submitted", "approved", "rejected"].includes(
              text(recorded.status),
            )
          ) {
            uploadedPath = null;
            return jsonResponse(
              {
                ok: true,
                claim: playerRainPublicClaimPayload(recorded),
                idempotent: true,
              },
              200,
              proofReconciliation.origin,
            );
          }
        } catch {
          // A downstream timeout may have committed the proof. Preserve the
          // private object until status can be reconciled instead of deleting
          // evidence that the database may already reference.
          uploadedPath = null;
          return errorResponse(
            503,
            "RAIN_REPORT_STATUS_UNKNOWN",
            "The court photo may have been received. Check the rain report status before retrying.",
            proofReconciliation.origin,
          );
        }
      }
      if (uploadedPath) {
        await store.removeProof(uploadedPath).catch(() => undefined);
      }
      if (error instanceof RequestError) {
        return errorResponse(
          error.status,
          error.code,
          error.message,
          allowedOrigin,
        );
      }
      console.error("Unhandled player-rain-report error", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return errorResponse(
        500,
        "RAIN_REPORT_UNAVAILABLE",
        "Rain reporting is temporarily unavailable. Please try again.",
        allowedOrigin,
      );
    }
  };
}
