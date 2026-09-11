import { createClient } from "@supabase/supabase-js";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  readJsonObject,
  RequestError,
} from "../_shared/http.ts";
import {
  deriveOpenPlayAccessToken,
  openPlayAccessTokenHash,
  parseOpenPlayAccessToken,
  parseOpenPlayReference,
  parseOpenPlayRequestId,
  parseOpenPlayUuid,
  withOpenPlayServerTime,
} from "../_shared/open-play.ts";
import { resolveTenantForRequest } from "../_shared/tenant.ts";

type JsonObject = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function createDatabaseClient() {
  return createClient(
    requiredEnvironment("SUPABASE_URL"),
    requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { "X-Client-Info": "pickleball-open-play-public/2.0" },
      },
    },
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function assertKeys(
  body: JsonObject,
  allowed: readonly string[],
  code = "OPEN_PLAY_REQUEST_INVALID",
): void {
  const allow = new Set(allowed);
  if (Object.keys(body).some((key) => !allow.has(key))) {
    throw new RequestError(
      400,
      code,
      "The Open Play request contains unsupported fields.",
    );
  }
}

function action(value: unknown): "list" | "reserve" | "status" | "cancel" {
  if (
    value === "list" || value === "reserve" || value === "status" ||
    value === "cancel"
  ) return value;
  throw new RequestError(
    400,
    "OPEN_PLAY_ACTION_INVALID",
    "Choose a supported Open Play action.",
  );
}

function quantity(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < 1 || value > 4
  ) {
    throw new RequestError(
      422,
      "OPEN_PLAY_QUANTITY_INVALID",
      "Choose from one through four player spots.",
    );
  }
  return value;
}

function customer(value: unknown): {
  name: string;
  email: string | null;
  phone: string;
} {
  const input = objectValue(value);
  assertKeys(input, ["name", "email", "phone"]);
  const name = text(input.name);
  const email = text(input.email).toLowerCase();
  const phone = text(input.phone);
  if (
    name.length < 2 || name.length > 120 ||
    phone.length < 7 || phone.length > 40 ||
    (
      email &&
      (
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        email.includes("..")
      )
    )
  ) {
    throw new RequestError(
      422,
      "OPEN_PLAY_CUSTOMER_INVALID",
      "Enter valid player contact details.",
    );
  }
  return { name, email: email || null, phone };
}

function databaseFailure(
  error: { code?: string; message?: string } | null,
): RequestError {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("open_play_not_enabled")) {
    return new RequestError(
      503,
      "OPEN_PLAY_NOT_ENABLED",
      "Open Play is not available for this venue yet.",
    );
  }
  if (message.includes("open_play_capacity_exceeded")) {
    return new RequestError(
      409,
      "OPEN_PLAY_FULL",
      "Those player spots were just taken. Choose a smaller group or another session.",
    );
  }
  if (
    message.includes("open_play_session_unavailable") ||
    message.includes("open_play_reservation_closed")
  ) {
    return new RequestError(
      409,
      "OPEN_PLAY_SESSION_UNAVAILABLE",
      "This Open Play session is no longer accepting reservations.",
    );
  }
  if (
    message.includes("open_play_access_denied") ||
    code === "42501"
  ) {
    return new RequestError(
      401,
      "OPEN_PLAY_ACCESS_DENIED",
      "The Open Play reference or access token is invalid.",
    );
  }
  if (message.includes("open_play_hold_expired")) {
    return new RequestError(
      409,
      "OPEN_PLAY_HOLD_EXPIRED",
      "This Open Play payment hold has expired.",
    );
  }
  if (message.includes("open_play_cancellation_not_allowed")) {
    return new RequestError(
      409,
      "OPEN_PLAY_CANCELLATION_NOT_ALLOWED",
      "This Open Play registration can no longer be cancelled online.",
    );
  }
  if (
    message.includes("open_play_idempotency_conflict") ||
    code === "23505"
  ) {
    return new RequestError(
      409,
      "OPEN_PLAY_REQUEST_CONFLICT",
      "That request identifier was already used for different reservation details.",
    );
  }
  if (code === "40P01" || code === "40001") {
    return new RequestError(
      409,
      "OPEN_PLAY_RETRY",
      "Open Play changed at the same time. Refresh and try again.",
    );
  }
  if (code === "22023") {
    return new RequestError(
      422,
      "OPEN_PLAY_REQUEST_REJECTED",
      "The Open Play request is no longer valid. Refresh and try again.",
    );
  }
  return new RequestError(
    503,
    "OPEN_PLAY_UNAVAILABLE",
    "Open Play is temporarily unavailable. Please try again.",
  );
}

Deno.serve(async (request: Request): Promise<Response> => {
  let allowedOrigin: string | undefined;
  try {
    if (request.method !== "POST" && request.method !== "OPTIONS") {
      return errorResponse(
        405,
        "METHOD_NOT_ALLOWED",
        "Only POST requests are accepted.",
      );
    }

    const url = new URL(request.url);
    const queryTenantSlug = url.searchParams.get("tenantSlug") ??
      request.headers.get("x-tenant-slug");
    if (request.method === "OPTIONS") {
      const context = await resolveTenantForRequest(
        createDatabaseClient(),
        queryTenantSlug,
        request.headers.get("origin"),
      );
      return noContentResponse(context.origin);
    }

    const body = await readJsonObject(request, 16_384);
    const requestedAction = action(body.action);
    const bodyTenantSlug = text(body.tenantSlug).toLowerCase();
    const querySlug = text(queryTenantSlug).toLowerCase();
    if (bodyTenantSlug && querySlug && bodyTenantSlug !== querySlug) {
      throw new RequestError(
        400,
        "TENANT_SLUG_MISMATCH",
        "The tenant slug does not match the request URL.",
      );
    }
    const tenantSlug = bodyTenantSlug || querySlug;

    if (requestedAction === "reserve") {
      assertKeys(body, [
        "action",
        "tenantSlug",
        "sessionId",
        "quantity",
        "customer",
        "clientRequestId",
      ]);
    }

    const db = createDatabaseClient();
    const context = await resolveTenantForRequest(
      db,
      tenantSlug,
      request.headers.get("origin"),
    );
    allowedOrigin = context.origin;

    if (requestedAction === "list") {
      assertKeys(body, ["action", "tenantSlug"]);
      const result = await db.rpc("list_public_open_play_sessions", {
        p_tenant_slug: context.tenantSlug,
        p_hostname: context.hostname,
      });
      if (result.error) throw databaseFailure(result.error);
      return jsonResponse(
        withOpenPlayServerTime({
          ok: true,
          sessions: Array.isArray(result.data) ? result.data : [],
        }),
        200,
        context.origin,
      );
    }

    if (requestedAction === "reserve") {
      const sessionId = parseOpenPlayUuid(
        body.sessionId,
        "OPEN_PLAY_SESSION_INVALID",
        "Choose a valid Open Play session.",
      );
      const requestedQuantity = quantity(body.quantity);
      const player = customer(body.customer);
      const clientRequestId = parseOpenPlayRequestId(body.clientRequestId);
      const accessToken = await deriveOpenPlayAccessToken({
        secret: requiredEnvironment("BOOKING_ACCESS_TOKEN_SECRET"),
        tenantId: context.tenantId,
        clientRequestId,
      });
      const accessTokenHash = await openPlayAccessTokenHash(accessToken);
      const result = await db.rpc("reserve_public_open_play_spots", {
        p_tenant_slug: context.tenantSlug,
        p_hostname: context.hostname,
        p_session_id: sessionId,
        p_quantity: requestedQuantity,
        p_customer_name: player.name,
        p_customer_email: player.email,
        p_customer_phone: player.phone,
        p_client_request_id: clientRequestId,
        p_access_token_hash: accessTokenHash,
      });
      if (result.error) throw databaseFailure(result.error);
      const payload = objectValue(result.data);
      const registration = objectValue(payload.registration);
      if (!registration.id || !registration.reference) {
        throw new Error("Reservation RPC returned an invalid registration.");
      }
      return jsonResponse(
        withOpenPlayServerTime({
          ok: true,
          registration: { ...registration, accessToken },
          paymentMethods: Array.isArray(payload.paymentMethods)
            ? payload.paymentMethods
            : [],
        }),
        payload.idempotent === true ? 200 : 201,
        context.origin,
      );
    }

    if (requestedAction === "status") {
      assertKeys(body, [
        "action",
        "tenantSlug",
        "reference",
        "accessToken",
      ]);
      const reference = parseOpenPlayReference(body.reference);
      const accessToken = parseOpenPlayAccessToken(body.accessToken);
      const result = await db.rpc("get_public_open_play_registration", {
        p_tenant_slug: context.tenantSlug,
        p_hostname: context.hostname,
        p_reference: reference,
        p_access_token_hash: await openPlayAccessTokenHash(accessToken),
      });
      if (result.error || !result.data) throw databaseFailure(result.error);
      const payload = objectValue(result.data);
      const registration = objectValue(payload.registration);
      if (!registration.id || !registration.reference) {
        throw new Error("Status RPC returned an invalid registration.");
      }
      return jsonResponse(
        withOpenPlayServerTime({
          ok: true,
          registration,
          paymentMethods: Array.isArray(payload.paymentMethods)
            ? payload.paymentMethods
            : [],
        }),
        200,
        context.origin,
      );
    }

    assertKeys(body, [
      "action",
      "tenantSlug",
      "reference",
      "accessToken",
      "clientRequestId",
    ]);
    const reference = parseOpenPlayReference(body.reference);
    const accessToken = parseOpenPlayAccessToken(body.accessToken);
    const result = await db.rpc("cancel_public_open_play_registration", {
      p_tenant_slug: context.tenantSlug,
      p_hostname: context.hostname,
      p_reference: reference,
      p_access_token_hash: await openPlayAccessTokenHash(accessToken),
      p_client_request_id: parseOpenPlayRequestId(body.clientRequestId),
    });
    if (result.error || !result.data) throw databaseFailure(result.error);
    const payload = objectValue(result.data);
    return jsonResponse(
      withOpenPlayServerTime({
        ok: true,
        registration: payload.registration,
      }),
      200,
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
    console.error("Unhandled open-play-public error", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(
      500,
      "OPEN_PLAY_UNAVAILABLE",
      "Open Play is temporarily unavailable.",
      allowedOrigin,
    );
  }
});
