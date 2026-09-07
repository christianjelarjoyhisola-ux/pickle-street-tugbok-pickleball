import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  readJsonObject,
  RequestError,
} from "./http.ts";
import { normalizeTenantSlug, type TenantRequestContext } from "./tenant.ts";

export type JsonObject = Record<string, unknown>;

export type WeatherRefundRuleVersion = "rain-v1" | "rain-v2" | "rain-v3";

export const CURRENT_WEATHER_REFUND_RULE_VERSION: WeatherRefundRuleVersion =
  "rain-v3";

export const CURRENT_WEATHER_REFUND_POLICY = Object.freeze({
  version: CURRENT_WEATHER_REFUND_RULE_VERSION,
  calculationBasis: "court-rental-v1",
  refundableComponent: "courtRentalAmount",
  excludedComponents: Object.freeze([
    "equipmentRentalAmount",
    "platformBookingFeeAmount",
  ]),
  boundaries: Object.freeze([
    Object.freeze({
      throughMinutes: 15,
      refundPercent: 75,
      retainedPercent: 25,
    }),
    Object.freeze({
      throughMinutes: 30,
      refundPercent: 50,
      retainedPercent: 50,
    }),
    Object.freeze({
      throughMinutes: 45,
      refundPercent: 25,
      retainedPercent: 75,
    }),
    Object.freeze({
      afterMinutes: 45,
      refundPercent: 0,
      retainedPercent: 100,
    }),
  ]),
});

export function weatherRefundPercentForElapsedSeconds(
  elapsedSeconds: number,
  ruleVersion: WeatherRefundRuleVersion = CURRENT_WEATHER_REFUND_RULE_VERSION,
): number {
  if (
    !Number.isInteger(elapsedSeconds) ||
    elapsedSeconds < 0 ||
    (ruleVersion !== "rain-v1" && elapsedSeconds === 0)
  ) {
    throw new TypeError(
      ruleVersion !== "rain-v1"
        ? "Current rain-policy elapsed seconds must be a positive integer."
        : "Weather refund elapsed seconds must be a non-negative integer.",
    );
  }
  if (ruleVersion === "rain-v1") {
    if (elapsedSeconds <= 15 * 60) return 100;
    if (elapsedSeconds <= 40 * 60) return 50;
    return 0;
  }
  if (elapsedSeconds <= 15 * 60) return 75;
  if (elapsedSeconds <= 30 * 60) return 50;
  if (elapsedSeconds <= 45 * 60) return 25;
  return 0;
}

function amountInCents(value: unknown): number | null {
  if (
    value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 0.000001 ? cents : null;
}

function validateCurrentPolicyPreview(preview: JsonObject): void {
  const ruleVersion = text(preview.ruleVersion);
  const elapsedSeconds = Number(preview.elapsedSeconds);
  const refundPercent = Number(preview.refundPercent);
  const paidAmount = amountInCents(preview.paidAmount);
  const grossPaidAmount = amountInCents(preview.grossPaidAmount);
  const courtRentalAmount = amountInCents(preview.courtRentalAmount);
  const equipmentRentalAmount = amountInCents(preview.equipmentRentalAmount);
  const platformBookingFeeAmount = amountInCents(
    preview.platformBookingFeeAmount,
  );
  const refundableBasisAmount = amountInCents(preview.refundableBasisAmount);
  const refundAmount = amountInCents(preview.refundAmount);
  if (
    ruleVersion !== CURRENT_WEATHER_REFUND_RULE_VERSION ||
    text(preview.calculationBasis) !== "court-rental-v1" ||
    !Number.isInteger(elapsedSeconds) ||
    !Number.isInteger(refundPercent) ||
    refundPercent !== weatherRefundPercentForElapsedSeconds(elapsedSeconds) ||
    paidAmount === null ||
    grossPaidAmount === null ||
    paidAmount !== grossPaidAmount ||
    courtRentalAmount === null ||
    equipmentRentalAmount === null ||
    platformBookingFeeAmount === null ||
    refundableBasisAmount === null ||
    refundableBasisAmount !== courtRentalAmount ||
    grossPaidAmount !==
      courtRentalAmount + equipmentRentalAmount + platformBookingFeeAmount ||
    refundAmount === null ||
    refundAmount !== Math.round(refundableBasisAmount * refundPercent / 100)
  ) {
    throw new Error("Weather refund preview policy mismatch.");
  }
}

export type WeatherRefundActorAccess = {
  membershipRole: "owner" | "admin" | "staff" | null;
  isSystemOwner: boolean;
};

export interface WeatherRefundStore {
  resolveTenant(
    tenantSlug: unknown,
    originHeader: string | null,
  ): Promise<TenantRequestContext>;
  authenticate(accessToken: string): Promise<string | null>;
  authorize(
    tenantId: string,
    userId: string,
  ): Promise<WeatherRefundActorAccess>;
  findBookingId(
    tenantId: string,
    bookingReference: string,
    includeArchived: boolean,
  ): Promise<string | null>;
  preview(options: {
    accessToken: string;
    origin: string;
    bookingId: string;
    actualPlayStartedAt: string;
    rainStoppedPlayAt: string;
  }): Promise<JsonObject>;
  report(options: {
    accessToken: string;
    origin: string;
    bookingId: string;
    actualPlayStartedAt: string;
    rainStoppedPlayAt: string;
    reportNote: string | null;
    idempotencyKey: string;
  }): Promise<JsonObject>;
  get(options: {
    accessToken: string;
    origin: string;
    bookingId: string;
  }): Promise<JsonObject | null>;
  list(options: {
    accessToken: string;
    origin: string;
    status: string | null;
    bookingDate: string | null;
    limit: number;
    payoutStatus: string | null;
    beforeReportedAt: string | null;
    beforeIncidentId: string | null;
  }): Promise<JsonObject>;
  decide(options: {
    accessToken: string;
    origin: string;
    incidentId: string;
    decision: "approve" | "reject";
    decisionNote: string | null;
    idempotencyKey: string;
  }): Promise<JsonObject>;
  markPayoutSent(options: {
    accessToken: string;
    origin: string;
    incidentId: string;
    payoutReference: string;
    payoutMethod: string | null;
    payoutNote: string | null;
    idempotencyKey: string;
  }): Promise<JsonObject>;
  listPlayerClaims(options: {
    accessToken: string;
    origin: string;
    status: string | null;
    bookingDate: string | null;
    limit: number;
    beforeReportedAt: string | null;
    beforeClaimId: string | null;
  }): Promise<JsonObject>;
  getPlayerClaim(options: {
    accessToken: string;
    origin: string;
    claimId: string;
  }): Promise<JsonObject>;
  getPlayerProofUrl(options: {
    tenantId: string;
    claimId: string;
  }): Promise<{ signedUrl: string; expiresIn: number }>;
  decidePlayerClaim(options: {
    accessToken: string;
    origin: string;
    claimId: string;
    decision: "approve" | "reject";
    decisionNote: string | null;
    actualPlayStartedAtOverride: string | null;
    playStartOverrideReason: string | null;
    idempotencyKey: string;
  }): Promise<JsonObject>;
}

type WeatherRefundAction =
  | "preview"
  | "report"
  | "get"
  | "list"
  | "approve"
  | "reject"
  | "mark-payout-sent"
  | "list-player-claims"
  | "get-player-claim"
  | "get-player-proof"
  | "approve-player-claim"
  | "reject-player-claim";

const COMMON_KEYS = new Set(["action", "tenantSlug"]);
const BOOKING_KEYS = new Set([...COMMON_KEYS, "bookingReference"]);
const PREVIEW_KEYS = new Set([
  ...BOOKING_KEYS,
  "actualPlayStartedAt",
  "rainStoppedPlayAt",
]);
const REPORT_KEYS = new Set([
  ...PREVIEW_KEYS,
  "reportNote",
  "idempotencyKey",
]);
const LIST_KEYS = new Set([...COMMON_KEYS, "filters"]);
const PLAYER_CLAIM_LIST_KEYS = new Set([...COMMON_KEYS, "filters"]);
const PLAYER_CLAIM_GET_KEYS = new Set([
  ...COMMON_KEYS,
  "claimId",
]);
const PLAYER_CLAIM_DECISION_KEYS = new Set([
  ...PLAYER_CLAIM_GET_KEYS,
  "decisionNote",
  "actualPlayStartedAtOverride",
  "playStartOverrideReason",
  "idempotencyKey",
]);
const DECISION_KEYS = new Set([
  ...COMMON_KEYS,
  "incidentId",
  "decisionNote",
  "idempotencyKey",
]);
const PAYOUT_KEYS = new Set([
  ...COMMON_KEYS,
  "incidentId",
  "payoutReference",
  "payoutMethod",
  "payoutNote",
  "idempotencyKey",
]);
const LIST_FILTER_KEYS = new Set([
  "status",
  "bookingDate",
  "limit",
  "payoutStatus",
  "beforeReportedAt",
  "beforeIncidentId",
]);
const PLAYER_CLAIM_FILTER_KEYS = new Set([
  "status",
  "bookingDate",
  "limit",
  "beforeReportedAt",
  "beforeClaimId",
]);
const STATUS_VALUES = new Set(["reported", "approved", "rejected"]);
const PLAYER_CLAIM_STATUS_VALUES = new Set([
  "awaiting_proof",
  "submitted",
  "approved",
  "rejected",
  "expired",
]);
const PAYOUT_STATUS_VALUES = new Set(["pending", "sent", "not_required"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function assertOnlyKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
  code = "WEATHER_REFUND_FIELDS_INVALID",
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RequestError(
      400,
      code,
      "The weather refund request contains an unsupported field.",
    );
  }
}

function parseAction(value: unknown): WeatherRefundAction {
  if (
    value === "preview" || value === "report" || value === "get" ||
    value === "list" || value === "approve" || value === "reject" ||
    value === "mark-payout-sent" || value === "list-player-claims" ||
    value === "get-player-claim" || value === "get-player-proof" ||
    value === "approve-player-claim" || value === "reject-player-claim"
  ) {
    return value;
  }
  throw new RequestError(
    400,
    "WEATHER_REFUND_ACTION_INVALID",
    "Choose a supported weather refund or player rain claim action.",
  );
}

function parseBookingReference(value: unknown): string {
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

function parseUuid(value: unknown, code: string, message: string): string {
  const id = text(value).toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(id)
  ) {
    throw new RequestError(400, code, message);
  }
  return id;
}

function parseInstant(value: unknown, label: string): string {
  const instant = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/
      .test(instant)
  ) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_TIME_INVALID",
      `${label} must be an ISO date and time with a timezone.`,
    );
  }
  const parsed = new Date(instant);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_TIME_INVALID",
      `${label} must be a valid date and time.`,
    );
  }
  return parsed.toISOString();
}

function parseDate(value: unknown): string {
  const date = text(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_DATE_INVALID",
      "Booking date must use YYYY-MM-DD.",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_DATE_INVALID",
      "Booking date must be a real calendar date.",
    );
  }
  return date;
}

function parseBoundedText(
  value: unknown,
  options: {
    code: string;
    label: string;
    minimum: number;
    maximum: number;
    optional?: boolean;
  },
): string | null {
  const normalized = text(value);
  if (!normalized && options.optional) return null;
  if (
    normalized.length < options.minimum ||
    normalized.length > options.maximum
  ) {
    throw new RequestError(
      400,
      options.code,
      `${options.label} must contain ${options.minimum} to ${options.maximum} characters.`,
    );
  }
  return normalized;
}

function parseListFilters(value: unknown): {
  status: string | null;
  bookingDate: string | null;
  limit: number;
  payoutStatus: string | null;
  beforeReportedAt: string | null;
  beforeIncidentId: string | null;
} {
  if (value === undefined || value === null) {
    return {
      status: null,
      bookingDate: null,
      limit: 100,
      payoutStatus: null,
      beforeReportedAt: null,
      beforeIncidentId: null,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_FILTERS_INVALID",
      "List filters must be an object.",
    );
  }
  const filters = objectValue(value);
  assertOnlyKeys(
    filters,
    LIST_FILTER_KEYS,
    "WEATHER_REFUND_FILTERS_INVALID",
  );
  const status = text(filters.status).toLowerCase() || null;
  if (status && !STATUS_VALUES.has(status)) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_STATUS_INVALID",
      "Choose reported, approved, or rejected.",
    );
  }
  const bookingDate = filters.bookingDate === undefined ||
      filters.bookingDate === null || text(filters.bookingDate) === ""
    ? null
    : parseDate(filters.bookingDate);
  const limitValue = filters.limit ?? 100;
  const limit = Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_LIMIT_INVALID",
      "List limit must be a whole number from 1 to 250.",
    );
  }
  const payoutStatus = text(filters.payoutStatus).toLowerCase() || null;
  if (payoutStatus && !PAYOUT_STATUS_VALUES.has(payoutStatus)) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_PAYOUT_STATUS_INVALID",
      "Choose pending, sent, or not_required.",
    );
  }
  const hasBeforeTime = filters.beforeReportedAt !== undefined &&
    filters.beforeReportedAt !== null &&
    text(filters.beforeReportedAt) !== "";
  const hasBeforeId = filters.beforeIncidentId !== undefined &&
    filters.beforeIncidentId !== null &&
    text(filters.beforeIncidentId) !== "";
  if (hasBeforeTime !== hasBeforeId) {
    throw new RequestError(
      400,
      "WEATHER_REFUND_CURSOR_INVALID",
      "Both weather refund cursor fields are required.",
    );
  }
  const beforeReportedAt = hasBeforeTime
    ? parseInstant(filters.beforeReportedAt, "Cursor report time")
    : null;
  const beforeIncidentId = hasBeforeId
    ? parseUuid(
      filters.beforeIncidentId,
      "WEATHER_REFUND_CURSOR_INVALID",
      "A valid weather refund cursor incident is required.",
    )
    : null;
  return {
    status,
    bookingDate,
    limit,
    payoutStatus,
    beforeReportedAt,
    beforeIncidentId,
  };
}

function parsePlayerClaimFilters(value: unknown): {
  status: string | null;
  bookingDate: string | null;
  limit: number;
  beforeReportedAt: string | null;
  beforeClaimId: string | null;
} {
  if (value === undefined || value === null) {
    return {
      status: null,
      bookingDate: null,
      limit: 100,
      beforeReportedAt: null,
      beforeClaimId: null,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(
      400,
      "PLAYER_RAIN_CLAIM_FILTERS_INVALID",
      "Player rain claim filters must be an object.",
    );
  }
  const filters = objectValue(value);
  assertOnlyKeys(
    filters,
    PLAYER_CLAIM_FILTER_KEYS,
    "PLAYER_RAIN_CLAIM_FILTERS_INVALID",
  );
  const status = text(filters.status).toLowerCase() || null;
  if (status && !PLAYER_CLAIM_STATUS_VALUES.has(status)) {
    throw new RequestError(
      400,
      "PLAYER_RAIN_CLAIM_STATUS_INVALID",
      "Choose a valid player rain claim status.",
    );
  }
  const bookingDate = filters.bookingDate === undefined ||
      filters.bookingDate === null || text(filters.bookingDate) === ""
    ? null
    : parseDate(filters.bookingDate);
  const limit = Number(filters.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new RequestError(
      400,
      "PLAYER_RAIN_CLAIM_LIMIT_INVALID",
      "Player rain claim limit must be a whole number from 1 to 250.",
    );
  }
  const hasBeforeTime = filters.beforeReportedAt !== undefined &&
    filters.beforeReportedAt !== null &&
    text(filters.beforeReportedAt) !== "";
  const hasBeforeId = filters.beforeClaimId !== undefined &&
    filters.beforeClaimId !== null &&
    text(filters.beforeClaimId) !== "";
  if (hasBeforeTime !== hasBeforeId) {
    throw new RequestError(
      400,
      "PLAYER_RAIN_CLAIM_CURSOR_INVALID",
      "Both player rain claim cursor fields are required.",
    );
  }
  return {
    status,
    bookingDate,
    limit,
    beforeReportedAt: hasBeforeTime
      ? parseInstant(filters.beforeReportedAt, "Cursor report time")
      : null,
    beforeClaimId: hasBeforeId
      ? parseUuid(
        filters.beforeClaimId,
        "PLAYER_RAIN_CLAIM_CURSOR_INVALID",
        "A valid player rain claim cursor is required.",
      )
      : null,
  };
}

function bearerToken(value: string | null): string {
  const match = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(value ?? "");
  if (!match) {
    throw new RequestError(
      401,
      "AUTHENTICATION_REQUIRED",
      "A valid operator session is required.",
    );
  }
  return match[1];
}

function tenantSlugForRequest(
  bodySlug: unknown,
  querySlug: string | null,
): unknown {
  if (bodySlug !== undefined && querySlug) {
    if (normalizeTenantSlug(bodySlug) !== normalizeTenantSlug(querySlug)) {
      throw new RequestError(
        400,
        "TENANT_SLUG_MISMATCH",
        "The tenant slug does not match the request URL.",
      );
    }
  }
  return bodySlug ?? querySlug;
}

function hasOperatorAccess(access: WeatherRefundActorAccess): boolean {
  return access.isSystemOwner || access.membershipRole === "owner" ||
    access.membershipRole === "admin" ||
    access.membershipRole === "staff";
}

function hasFinancialAccess(access: WeatherRefundActorAccess): boolean {
  return access.isSystemOwner || access.membershipRole === "owner" ||
    access.membershipRole === "admin";
}

function permissions(access: WeatherRefundActorAccess): JsonObject {
  const financial = hasFinancialAccess(access);
  return {
    canReport: hasOperatorAccess(access),
    canApprove: financial,
    canReject: financial,
    canMarkPayoutSent: financial,
  };
}

export function createWeatherRefundHandler(
  store: WeatherRefundStore,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let allowedOrigin: string | undefined;
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

      const body = await readJsonObject(request, 12_288);
      const context = await store.resolveTenant(
        tenantSlugForRequest(body.tenantSlug, queryTenantSlug),
        request.headers.get("origin"),
      );
      allowedOrigin = context.origin;
      const action = parseAction(body.action);
      const allowedKeys = action === "preview"
        ? PREVIEW_KEYS
        : action === "report"
        ? REPORT_KEYS
        : action === "get"
        ? BOOKING_KEYS
        : action === "list"
        ? LIST_KEYS
        : action === "list-player-claims"
        ? PLAYER_CLAIM_LIST_KEYS
        : action === "get-player-claim" || action === "get-player-proof"
        ? PLAYER_CLAIM_GET_KEYS
        : action === "approve-player-claim" ||
            action === "reject-player-claim"
        ? PLAYER_CLAIM_DECISION_KEYS
        : action === "mark-payout-sent"
        ? PAYOUT_KEYS
        : DECISION_KEYS;
      assertOnlyKeys(body, allowedKeys);

      const accessToken = bearerToken(
        request.headers.get("authorization"),
      );
      const userId = await store.authenticate(accessToken);
      if (!userId) {
        throw new RequestError(
          401,
          "AUTHENTICATION_REQUIRED",
          "A valid operator session is required.",
        );
      }
      const access = await store.authorize(context.tenantId, userId);
      if (!hasOperatorAccess(access)) {
        throw new RequestError(
          403,
          "WEATHER_REFUND_ACCESS_DENIED",
          "An active tenant operator account is required.",
        );
      }
      const actorPermissions = permissions(access);

      if (
        action === "list-player-claims" ||
        action === "get-player-claim" ||
        action === "get-player-proof" ||
        action === "approve-player-claim" ||
        action === "reject-player-claim"
      ) {
        if (!hasFinancialAccess(access)) {
          throw new RequestError(
            403,
            "WEATHER_REFUND_ACCESS_DENIED",
            "Only a tenant owner, admin, or System Owner may review player rain claims.",
          );
        }
        if (action === "list-player-claims") {
          const filters = parsePlayerClaimFilters(body.filters);
          const result = await store.listPlayerClaims({
            accessToken,
            origin: context.origin,
            ...filters,
          });
          return jsonResponse(
            {
              ok: true,
              permissions: actorPermissions,
              claims: Array.isArray(result.claims) ? result.claims : [],
              page: objectValue(result.page),
            },
            200,
            context.origin,
          );
        }

        const claimId = parseUuid(
          body.claimId,
          "PLAYER_RAIN_CLAIM_INVALID",
          "A valid player rain claim is required.",
        );
        if (action === "get-player-claim") {
          const claim = await store.getPlayerClaim({
            accessToken,
            origin: context.origin,
            claimId,
          });
          return jsonResponse(
            { ok: true, permissions: actorPermissions, claim },
            200,
            context.origin,
          );
        }
        if (action === "get-player-proof") {
          const proof = await store.getPlayerProofUrl({
            tenantId: context.tenantId,
            claimId,
          });
          return jsonResponse(
            {
              ok: true,
              claimId,
              signedUrl: proof.signedUrl,
              expiresIn: proof.expiresIn,
            },
            200,
            context.origin,
          );
        }

        const approve = action === "approve-player-claim";
        const decisionNote = parseBoundedText(body.decisionNote, {
          code: "PLAYER_RAIN_CLAIM_DECISION_NOTE_INVALID",
          label: approve ? "Decision note" : "Rejection reason",
          minimum: 3,
          maximum: 1000,
          optional: approve,
        });
        const actualPlayStartedAtOverride =
          body.actualPlayStartedAtOverride === undefined ||
            body.actualPlayStartedAtOverride === null ||
            text(body.actualPlayStartedAtOverride) === ""
            ? null
            : parseInstant(
              body.actualPlayStartedAtOverride,
              "Verified play start",
            );
        const playStartOverrideReason = parseBoundedText(
          body.playStartOverrideReason,
          {
            code: "PLAYER_RAIN_CLAIM_OVERRIDE_REASON_INVALID",
            label: "Play-start override reason",
            minimum: 3,
            maximum: 1000,
            optional: true,
          },
        );
        if (
          !approve && (
            actualPlayStartedAtOverride || playStartOverrideReason
          )
        ) {
          throw new RequestError(
            400,
            "PLAYER_RAIN_CLAIM_OVERRIDE_INVALID",
            "A rejected claim cannot override play start.",
          );
        }
        if (
          approve &&
          Boolean(actualPlayStartedAtOverride) !==
            Boolean(playStartOverrideReason)
        ) {
          throw new RequestError(
            400,
            "PLAYER_RAIN_CLAIM_OVERRIDE_INVALID",
            "A verified play-start override requires both a time and a reason.",
          );
        }
        const result = await store.decidePlayerClaim({
          accessToken,
          origin: context.origin,
          claimId,
          decision: approve ? "approve" : "reject",
          decisionNote,
          actualPlayStartedAtOverride,
          playStartOverrideReason,
          idempotencyKey: parseUuid(
            body.idempotencyKey,
            "IDEMPOTENCY_KEY_INVALID",
            "A valid player rain claim idempotency key is required.",
          ),
        });
        return jsonResponse(
          {
            ok: true,
            permissions: actorPermissions,
            claim: objectValue(result.claim),
            incident: result.incident ? objectValue(result.incident) : null,
            idempotent: result.idempotent === true,
          },
          200,
          context.origin,
        );
      }

      if (action === "list") {
        const filters = parseListFilters(body.filters);
        const result = await store.list({
          accessToken,
          origin: context.origin,
          ...filters,
        });
        return jsonResponse(
          {
            ok: true,
            permissions: actorPermissions,
            incidents: Array.isArray(result.incidents) ? result.incidents : [],
            page: objectValue(result.page),
          },
          200,
          context.origin,
        );
      }

      if (
        action === "approve" || action === "reject" ||
        action === "mark-payout-sent"
      ) {
        if (!hasFinancialAccess(access)) {
          throw new RequestError(
            403,
            "WEATHER_REFUND_ACCESS_DENIED",
            "Only a tenant owner, admin, or System Owner may approve or pay a refund.",
          );
        }
        const incidentId = parseUuid(
          body.incidentId,
          "WEATHER_REFUND_INCIDENT_INVALID",
          "A valid weather refund incident is required.",
        );
        const idempotencyKey = parseUuid(
          body.idempotencyKey,
          "IDEMPOTENCY_KEY_INVALID",
          "A valid weather refund idempotency key is required.",
        );
        if (action === "mark-payout-sent") {
          const result = await store.markPayoutSent({
            accessToken,
            origin: context.origin,
            incidentId,
            payoutReference: parseBoundedText(body.payoutReference, {
              code: "WEATHER_REFUND_PAYOUT_REFERENCE_INVALID",
              label: "Payout reference",
              minimum: 2,
              maximum: 160,
            }) as string,
            payoutMethod: parseBoundedText(body.payoutMethod, {
              code: "WEATHER_REFUND_PAYOUT_METHOD_INVALID",
              label: "Payout method",
              minimum: 2,
              maximum: 80,
              optional: true,
            }),
            payoutNote: parseBoundedText(body.payoutNote, {
              code: "WEATHER_REFUND_PAYOUT_NOTE_INVALID",
              label: "Payout note",
              minimum: 3,
              maximum: 1000,
              optional: true,
            }),
            idempotencyKey,
          });
          return jsonResponse(
            {
              ok: true,
              permissions: actorPermissions,
              incident: objectValue(result.incident),
              idempotent: result.idempotent === true,
            },
            200,
            context.origin,
          );
        }

        const decisionNote = parseBoundedText(body.decisionNote, {
          code: "WEATHER_REFUND_DECISION_NOTE_INVALID",
          label: action === "reject" ? "Rejection reason" : "Decision note",
          minimum: 3,
          maximum: 1000,
          optional: action === "approve",
        });
        const result = await store.decide({
          accessToken,
          origin: context.origin,
          incidentId,
          decision: action,
          decisionNote,
          idempotencyKey,
        });
        return jsonResponse(
          {
            ok: true,
            permissions: actorPermissions,
            incident: objectValue(result.incident),
            idempotent: result.idempotent === true,
          },
          200,
          context.origin,
        );
      }

      const bookingReference = parseBookingReference(body.bookingReference);
      const bookingId = await store.findBookingId(
        context.tenantId,
        bookingReference,
        (action === "get" || action === "report") &&
          hasFinancialAccess(access),
      );
      if (!bookingId) {
        throw new RequestError(
          404,
          "WEATHER_REFUND_NOT_FOUND",
          "Booking not found.",
        );
      }

      if (action === "get") {
        const incident = await store.get({
          accessToken,
          origin: context.origin,
          bookingId,
        });
        return jsonResponse(
          {
            ok: true,
            permissions: actorPermissions,
            incident,
          },
          200,
          context.origin,
        );
      }

      const actualPlayStartedAt = parseInstant(
        body.actualPlayStartedAt,
        "Actual play start",
      );
      const rainStoppedPlayAt = parseInstant(
        body.rainStoppedPlayAt,
        "Rain-stop time",
      );
      if (
        Date.parse(rainStoppedPlayAt) <= Date.parse(actualPlayStartedAt)
      ) {
        throw new RequestError(
          400,
          "WEATHER_REFUND_TIME_INVALID",
          "Rain-stop time must be after actual play start.",
        );
      }

      if (action === "preview") {
        const preview = await store.preview({
          accessToken,
          origin: context.origin,
          bookingId,
          actualPlayStartedAt,
          rainStoppedPlayAt,
        });
        validateCurrentPolicyPreview(preview);
        return jsonResponse(
          {
            ok: true,
            permissions: actorPermissions,
            preview,
            policy: CURRENT_WEATHER_REFUND_POLICY,
          },
          200,
          context.origin,
        );
      }

      const result = await store.report({
        accessToken,
        origin: context.origin,
        bookingId,
        actualPlayStartedAt,
        rainStoppedPlayAt,
        reportNote: parseBoundedText(body.reportNote, {
          code: "WEATHER_REFUND_REPORT_NOTE_INVALID",
          label: "Report note",
          minimum: 3,
          maximum: 1000,
          optional: true,
        }),
        idempotencyKey: parseUuid(
          body.idempotencyKey,
          "IDEMPOTENCY_KEY_INVALID",
          "A valid weather refund idempotency key is required.",
        ),
      });
      return jsonResponse(
        {
          ok: true,
          permissions: actorPermissions,
          incident: objectValue(result.incident),
          idempotent: result.idempotent === true,
        },
        result.idempotent === true ? 200 : 201,
        context.origin,
      );
    } catch (error) {
      if (error instanceof RequestError) {
        return errorResponse(
          error.status,
          error.code,
          error.message,
          allowedOrigin,
        );
      }
      console.error("Unhandled manage-weather-refund error", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return errorResponse(
        500,
        "WEATHER_REFUND_UNAVAILABLE",
        "Weather refunds are temporarily unavailable.",
        allowedOrigin,
      );
    }
  };
}
