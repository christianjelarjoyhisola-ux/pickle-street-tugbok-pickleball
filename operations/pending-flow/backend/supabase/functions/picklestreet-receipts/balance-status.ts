import { createClient } from "@supabase/supabase-js";
import {
  parseBookingAccessToken,
  verifyBookingAccessToken,
} from "../_shared/booking-access.ts";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  readJsonObject,
  RequestError,
} from "../_shared/http.ts";
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
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uuid(value: unknown): string {
  const id = text(value).toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(id)
  ) {
    throw new RequestError(
      401,
      "BALANCE_ACCESS_DENIED",
      "The remaining-balance link is invalid.",
    );
  }
  return id;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export async function originalBalanceStatus(request: Request): Promise<Response> {
  let allowedOrigin: string | undefined;
  try {
    if (request.method !== "POST" && request.method !== "OPTIONS") {
      return errorResponse(
        405,
        "METHOD_NOT_ALLOWED",
        "Only POST requests are accepted.",
      );
    }
    const db = createDatabaseClient();
    const url = new URL(request.url);
    const queryTenantSlug = url.searchParams.get("tenantSlug") ??
      request.headers.get("x-tenant-slug");
    if (request.method === "OPTIONS") {
      const context = await resolveTenantForRequest(
        db,
        queryTenantSlug,
        request.headers.get("origin"),
      );
      return noContentResponse(context.origin);
    }

    const body = await readJsonObject(request, 4_096);
    if (
      Object.keys(body).some((key) =>
        !["tenantSlug", "balanceRequestId", "balanceToken"].includes(key)
      )
    ) {
      throw new RequestError(
        400,
        "BALANCE_REQUEST_INVALID",
        "The balance-status request contains unsupported fields.",
      );
    }
    const context = await resolveTenantForRequest(
      db,
      body.tenantSlug ?? queryTenantSlug,
      request.headers.get("origin"),
    );
    allowedOrigin = context.origin;
    const requestId = uuid(body.balanceRequestId);
    const token = parseBookingAccessToken(body.balanceToken);

    const balanceResult = await db.from("booking_balance_requests")
      .select(
        "id,booking_id,token_hash,accepted_amount,remaining_amount,currency,status,deadline_at,settled_at,request_type,request_details",
      )
      .eq("id", requestId)
      .eq("tenant_id", context.tenantId)
      .single();
    if (balanceResult.error || !balanceResult.data) {
      throw new RequestError(
        401,
        "BALANCE_ACCESS_DENIED",
        "The remaining-balance link is invalid.",
      );
    }
    const balance = balanceResult.data;
    await verifyBookingAccessToken({
      token,
      expectedHash: balance.token_hash,
    });
    const reconciliation = await db.rpc("expire_stale_tenant_holds", {
      p_tenant_id: context.tenantId,
    });
    if (reconciliation.error) {
      throw new RequestError(
        503,
        "BALANCE_STATUS_UNAVAILABLE",
        "The remaining-balance status is temporarily unavailable.",
      );
    }
    const adjustmentReconciliation = await db.rpc(
      "expire_stale_reschedule_adjustments",
      { p_tenant_id: context.tenantId },
    );
    if (adjustmentReconciliation.error) {
      throw new RequestError(
        503,
        "BALANCE_STATUS_UNAVAILABLE",
        "The remaining-balance status is temporarily unavailable.",
      );
    }

    const [bookingResult, methodsResult, receiptResult] = await Promise.all([
      db.from("bookings")
        .select(
          "id,reference,status,payment_status,total_amount,currency,starts_at,ends_at,court_id,courts(name)",
        )
        .eq("tenant_id", context.tenantId)
        .eq("id", balance.booking_id)
        .single(),
      db.from("tenant_payment_methods")
        .select(
          "method_code,display_name,account_name,account_reference,qr_image_url,instructions,sort_order",
        )
        .eq("tenant_id", context.tenantId)
        .eq("is_active", true)
        .order("sort_order"),
      db.from("receipt_verifications")
        .select("status,flags,created_at,reviewed_at")
        .eq("tenant_id", context.tenantId)
        .eq("balance_request_id", requestId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (bookingResult.error || !bookingResult.data || methodsResult.error) {
      throw new RequestError(
        503,
        "BALANCE_STATUS_UNAVAILABLE",
        "The remaining-balance status is temporarily unavailable.",
      );
    }

    const booking = bookingResult.data;
    const requestType = String(balance.request_type || "short_payment");
    const requestDetails = objectValue(balance.request_details);
    const courtJoin = Array.isArray(booking.courts)
      ? objectValue(booking.courts[0])
      : objectValue(booking.courts);
    const expired = new Date(balance.deadline_at).getTime() <= Date.now() &&
      !["settled", "cancelled"].includes(String(balance.status));
    const effectiveStatus = balance.status === "settled"
      ? "settled"
      : requestType !== "reschedule_adjustment" &&
          (booking.status === "confirmed" || booking.payment_status === "paid")
      ? "settled"
      : expired || booking.status === "expired"
      ? "expired"
      : booking.status === "cancelled" || balance.status === "cancelled"
      ? "cancelled"
      : balance.status;

    return jsonResponse(
      {
        ok: true,
        balance: {
          requestId,
          requestType,
          bookingReference: booking.reference,
          courtName: text(courtJoin.name) || "Court",
          startsAt: requestType === "reschedule_adjustment"
            ? requestDetails.newStartsAt
            : booking.starts_at,
          endsAt: requestType === "reschedule_adjustment"
            ? requestDetails.newEndsAt
            : booking.ends_at,
          originalStartsAt: requestType === "reschedule_adjustment"
            ? requestDetails.oldStartsAt
            : null,
          originalEndsAt: requestType === "reschedule_adjustment"
            ? requestDetails.oldEndsAt
            : null,
          totalAmount: requestType === "reschedule_adjustment"
            ? Number(requestDetails.newTotalAmount)
            : Number(booking.total_amount),
          acceptedAmount: Number(balance.accepted_amount),
          remainingAmount: Number(balance.remaining_amount),
          currency: balance.currency,
          status: effectiveStatus,
          deadlineAt: balance.deadline_at,
          receipt: receiptResult.data
            ? {
              status: receiptResult.data.status,
              flags: Array.isArray(receiptResult.data.flags)
                ? receiptResult.data.flags
                : [],
              submittedAt: receiptResult.data.created_at,
              reviewedAt: receiptResult.data.reviewed_at,
            }
            : null,
          paymentMethods: (methodsResult.data ?? []).map((method) => ({
            code: method.method_code,
            displayName: method.display_name,
            accountName: method.account_name,
            accountReference: method.account_reference,
            qrImageUrl: method.qr_image_url,
            instructions: method.instructions,
          })),
        },
      },
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
    console.error("Unhandled balance-payment-status error", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(
      500,
      "BALANCE_STATUS_UNAVAILABLE",
      "The remaining-balance status is temporarily unavailable.",
      allowedOrigin,
    );
  }
}