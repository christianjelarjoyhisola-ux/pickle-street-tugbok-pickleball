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
import {
  customerPlayerRainClaimSummary,
  customerWeatherRefundSummary,
  playerRainClaimWithFinalIncident,
  readPlayerClaimThenWeatherRefund,
} from "../_shared/weather-refund-status.ts";

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

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function bookingReference(value: unknown): string {
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

export async function originalBookingStatus(request: Request): Promise<Response> {
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
    const db = createDatabaseClient();
    if (request.method === "OPTIONS") {
      const context = await resolveTenantForRequest(
        db,
        queryTenantSlug,
        request.headers.get("origin"),
      );
      return noContentResponse(context.origin);
    }

    const body = await readJsonObject(request, 4_096);
    const context = await resolveTenantForRequest(
      db,
      body.tenantSlug ?? queryTenantSlug,
      request.headers.get("origin"),
    );
    allowedOrigin = context.origin;
    const reference = bookingReference(body.bookingReference);
    const token = parseBookingAccessToken(body.bookingToken);

    const reconciliation = await db.rpc("expire_stale_tenant_holds", {
      p_tenant_id: context.tenantId,
    });
    if (reconciliation.error) {
      throw new RequestError(
        503,
        "BOOKING_STATUS_UNAVAILABLE",
        "Booking status is temporarily unavailable.",
      );
    }

    const bookingResult = await db.from("bookings")
      .select(
        "id,reference,booking_type,status,payment_status,starts_at,ends_at,subtotal_amount,service_fee_amount,total_amount,currency,expires_at,metadata,courts!inner(name)",
      )
      .eq("tenant_id", context.tenantId)
      .eq("reference", reference)
      .single();
    if (bookingResult.error || !bookingResult.data) {
      throw new RequestError(
        401,
        "BOOKING_ACCESS_DENIED",
        "The booking reference or access token is invalid.",
      );
    }
    const booking = bookingResult.data as JsonObject;
    const accessResult = await db.from("booking_access_tokens")
      .select("token_hash,expires_at")
      .eq("tenant_id", context.tenantId)
      .eq("booking_id", String(booking.id))
      .gt("expires_at", new Date().toISOString())
      .single();
    if (accessResult.error || !accessResult.data) {
      throw new RequestError(
        401,
        "BOOKING_ACCESS_DENIED",
        "The booking access token is invalid or expired.",
      );
    }
    await verifyBookingAccessToken({
      token,
      expectedHash: accessResult.data.token_hash,
    });

    const receiptResult = await db.from("receipt_verifications")
      .select("status,flags,created_at,reviewed_at")
      .eq("tenant_id", context.tenantId)
      .eq("booking_id", String(booking.id))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (receiptResult.error) {
      throw new RequestError(
        503,
        "BOOKING_STATUS_UNAVAILABLE",
        "Booking status is temporarily unavailable.",
      );
    }

    const { playerRainClaim, weatherRefund } =
      await readPlayerClaimThenWeatherRefund(
        async () => {
          const playerRainClaimResult = await db.from("player_rain_claims")
            .select(
              "id,incident_id,status,rain_reported_at,proof_due_at,proof_storage_path,elapsed_seconds,rule_version,refund_percent,paid_amount,court_rental_amount,equipment_rental_amount,platform_booking_fee_amount,refundable_basis_amount,calculation_basis,estimated_refund_amount,currency,submitted_at,decided_at",
            )
            .eq("tenant_id", context.tenantId)
            .eq("booking_id", String(booking.id))
            .order("rain_reported_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (playerRainClaimResult.error) {
            throw new RequestError(
              503,
              "BOOKING_STATUS_UNAVAILABLE",
              "Booking status is temporarily unavailable.",
            );
          }
          return playerRainClaimResult.data as JsonObject | null;
        },
        async (capturedPlayerRainClaim) => {
          const incidentId = text(
            objectValue(capturedPlayerRainClaim).incident_id,
          );
          const weatherRefundQuery = db.from("weather_refund_incidents")
            .select(
              "id,status,elapsed_seconds,rule_version,refund_percent,paid_amount,court_rental_amount,equipment_rental_amount,platform_booking_fee_amount,refundable_basis_amount,calculation_basis,refund_amount,currency,payout_status,payout_sent_at",
            )
            .eq("tenant_id", context.tenantId)
            .eq("booking_id", String(booking.id));
          const weatherRefundResult = incidentId
            ? await weatherRefundQuery.eq("id", incidentId).maybeSingle()
            : await weatherRefundQuery.maybeSingle();
          if (weatherRefundResult.error) {
            throw new RequestError(
              503,
              "BOOKING_STATUS_UNAVAILABLE",
              "Booking status is temporarily unavailable.",
            );
          }
          return weatherRefundResult.data as JsonObject | null;
        },
      );

    const expiresAt = text(booking.expires_at);
    const storedStatus = text(booking.status);
    const effectiveStatus = ["pending_payment", "payment_review"].includes(
        storedStatus,
      ) && expiresAt && new Date(expiresAt).getTime() <= Date.now()
      ? "expired"
      : storedStatus;
    const metadata = objectValue(booking.metadata);
    const equipmentRental = objectValue(metadata.equipmentRental);
    const equipmentRentalFeeAmount = Math.max(
      0,
      Number(metadata.equipmentRentalFeeAmount) || 0,
    );
    const storedSubtotalAmount = Number(booking.subtotal_amount);
    const courtSubtotalAmount = Math.max(
      0,
      Number(metadata.courtSubtotalAmount) ||
        (storedSubtotalAmount - equipmentRentalFeeAmount),
    );
    const joinedCourt = Array.isArray(booking.courts)
      ? objectValue(booking.courts[0])
      : objectValue(booking.courts);
    const receipt = receiptResult.data as JsonObject | null;
    const playerRainClaimForCustomer = playerRainClaimWithFinalIncident(
      playerRainClaim,
      weatherRefund,
    );

    return jsonResponse(
      {
        ok: true,
        booking: {
          reference: text(booking.reference),
          courtName: text(joinedCourt.name),
          bookingType: text(booking.booking_type),
          status: effectiveStatus,
          paymentStatus: text(booking.payment_status),
          startsAt: text(booking.starts_at),
          endsAt: text(booking.ends_at),
          subtotalAmount: storedSubtotalAmount,
          courtSubtotalAmount,
          equipmentRentalFeeAmount,
          equipmentRental: {
            extraPaddles: Math.max(
              0,
              Math.trunc(Number(equipmentRental.extraPaddles) || 0),
            ),
            balls: Math.max(
              0,
              Math.trunc(Number(equipmentRental.balls) || 0),
            ),
          },
          serviceFeeAmount: Number(booking.service_fee_amount),
          totalAmount: Number(booking.total_amount),
          currency: text(booking.currency),
          expiresAt: expiresAt || null,
          fullPaymentOnly: metadata.fullPaymentOnly === true,
          receipt: receipt
            ? {
              status: text(receipt.status),
              flags: Array.isArray(receipt.flags)
                ? receipt.flags.filter((flag) => typeof flag === "string")
                : [],
              submittedAt: text(receipt.created_at) || null,
              reviewedAt: text(receipt.reviewed_at) || null,
            }
            : null,
          weatherRefund: customerWeatherRefundSummary(
            weatherRefund,
          ),
          playerRainClaim: customerPlayerRainClaimSummary(
            playerRainClaimForCustomer,
          ),
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
    console.error("Unhandled booking-status error", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(
      500,
      "BOOKING_STATUS_UNAVAILABLE",
      "Booking status is temporarily unavailable.",
      allowedOrigin,
    );
  }
}
