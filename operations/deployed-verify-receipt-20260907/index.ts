import { createClient } from "@supabase/supabase-js";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  readJsonObject,
  RequestError,
} from "../_shared/http.ts";
import {
  buildSafeReceiptExtraction,
  detectReceiptText,
  inspectReceiptImage,
  parseReceiptObjectPath,
  parseReceiptVerificationRequest,
  RECEIPT_BUCKET,
  sha256Hex,
  validateReceiptObjectMetadata,
} from "../_shared/receipt-verification.ts";
import type { ReceiptPaymentContext } from "../_shared/receipt-verification.ts";
import { requireHighEntropySecret, secretsMatch } from "../_shared/security.ts";
import {
  normalizeTenantSlug,
  resolveTenantForRequest,
} from "../_shared/tenant.ts";

type JsonObject = Record<string, unknown>;

type BookingRow = {
  id: string;
  tenant_id: string;
  reference: string;
  status: string;
  payment_status: string;
  total_amount: number | string;
  currency: string;
  expires_at: string | null;
  created_at: string;
};

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
        headers: {
          "X-Client-Info": "pickleball-platform-verify-receipt/1.0",
        },
      },
    },
  );
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function bearerToken(value: string | null): string {
  const match = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(value ?? "");
  if (!match) {
    throw new RequestError(
      401,
      "AUTHENTICATION_REQUIRED",
      "A valid staff session is required.",
    );
  }
  return match[1];
}

async function requireTenantOperator(
  db: ReturnType<typeof createDatabaseClient>,
  authorization: string | null,
  tenantId: string,
): Promise<void> {
  const token = bearerToken(authorization);
  const { data: userData, error: userError } = await db.auth.getUser(token);
  const userId = userData.user?.id ?? "";
  if (userError || !userId) {
    throw new RequestError(
      401,
      "AUTHENTICATION_REQUIRED",
      "A valid staff session is required.",
    );
  }

  const [membership, platformProfile] = await Promise.all([
    db.from("tenant_memberships")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .eq("status", "active")
      .in("role", ["owner", "admin", "staff"])
      .maybeSingle(),
    db.from("platform_profiles")
      .select("user_id")
      .eq("user_id", userId)
      .eq("is_platform_owner", true)
      .maybeSingle(),
  ]);
  if (membership.error || platformProfile.error) {
    throw new RequestError(
      503,
      "AUTHORIZATION_UNAVAILABLE",
      "Staff authorization could not be verified.",
    );
  }
  if (!membership.data && !platformProfile.data) {
    throw new RequestError(
      403,
      "TENANT_ACCESS_DENIED",
      "This staff account cannot manage receipts for the tenant.",
    );
  }
}

async function resolveInternalTenant(
  db: ReturnType<typeof createDatabaseClient>,
  tenantSlugValue: unknown,
): Promise<{ tenantId: string; tenantSlug: string }> {
  const tenantSlug = normalizeTenantSlug(tenantSlugValue);
  const { data, error } = await db.from("tenants")
    .select("id,slug")
    .eq("slug", tenantSlug)
    .eq("status", "active")
    .single();
  if (error || !data?.id) {
    throw new RequestError(
      404,
      "BOOKING_NOT_FOUND",
      "The booking was not found.",
    );
  }
  return { tenantId: String(data.id), tenantSlug: String(data.slug) };
}

function assertBookingAcceptsReceipt(booking: BookingRow): void {
  if (!["pending_payment", "payment_review"].includes(booking.status)) {
    throw new RequestError(
      409,
      "RECEIPT_NOT_ALLOWED",
      "A receipt cannot be submitted for this booking status.",
    );
  }
  if (["paid", "refunded"].includes(booking.payment_status)) {
    throw new RequestError(
      409,
      "RECEIPT_NOT_ALLOWED",
      "This booking does not accept another payment receipt.",
    );
  }
  if (
    booking.expires_at &&
    new Date(booking.expires_at).getTime() <= Date.now()
  ) {
    throw new RequestError(
      409,
      "BOOKING_EXPIRED",
      "The booking payment window has expired.",
    );
  }
}

function verificationResponse(row: JsonObject): JsonObject {
  return {
    id: String(row.id ?? ""),
    status: String(row.status ?? "manual_review"),
    confidence: typeof row.confidence === "number"
      ? row.confidence
      : row.confidence === null || row.confidence === undefined
      ? null
      : Number(row.confidence),
    flags: Array.isArray(row.flags)
      ? row.flags.filter((flag) => typeof flag === "string")
      : [],
  };
}

function databaseFailure(error: { code?: string }): RequestError {
  if (String(error.code ?? "") === "23505") {
    return new RequestError(
      409,
      "RECEIPT_ALREADY_PROCESSED",
      "This receipt was already submitted.",
    );
  }
  return new RequestError(
    500,
    "RECEIPT_RECORD_FAILED",
    "The receipt verification could not be recorded.",
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

    const requestUrl = new URL(request.url);
    if (request.method === "OPTIONS") {
      const db = createDatabaseClient();
      const context = await resolveTenantForRequest(
        db,
        requestUrl.searchParams.get("tenantSlug") ??
          request.headers.get("x-tenant-slug"),
        request.headers.get("origin"),
      );
      return noContentResponse(context.origin);
    }

    const body = await readJsonObject(request, 4_096);
    const input = parseReceiptVerificationRequest(body);
    const db = createDatabaseClient();
    const origin = request.headers.get("origin");
    let tenantId: string;

    if (origin) {
      // Internal credentials must never be accepted from browser-originated
      // requests, even if a caller accidentally exposes one.
      if (request.headers.has("x-internal-secret")) {
        throw new RequestError(
          403,
          "INTERNAL_CREDENTIAL_DENIED",
          "Internal credentials are not accepted from a browser.",
        );
      }
      const context = await resolveTenantForRequest(
        db,
        input.tenantSlug,
        origin,
      );
      allowedOrigin = context.origin;
      tenantId = context.tenantId;
      await requireTenantOperator(
        db,
        request.headers.get("authorization"),
        tenantId,
      );
    } else {
      if (
        !await secretsMatch(
          request.headers.get("x-internal-secret"),
          requireHighEntropySecret(
            "EDGE_INTERNAL_SECRET",
            Deno.env.get("EDGE_INTERNAL_SECRET"),
          ),
        )
      ) {
        throw new RequestError(
          401,
          "UNAUTHORIZED",
          "Internal authentication failed.",
        );
      }
      const context = await resolveInternalTenant(db, input.tenantSlug);
      tenantId = context.tenantId;
    }

    // The tenant and booking are derived from existing records. A tenant_id is
    // never accepted from the request body.
    const bookingResult = await db.from("bookings")
      .select(
        "id,tenant_id,reference,status,payment_status,total_amount,currency,expires_at,created_at",
      )
      .eq("tenant_id", tenantId)
      .eq("reference", input.bookingReference)
      .single();
    if (bookingResult.error || !bookingResult.data) {
      throw new RequestError(
        404,
        "BOOKING_NOT_FOUND",
        "The booking was not found.",
      );
    }
    const booking = bookingResult.data as BookingRow;

    const tenantResult = await db.from("tenants")
      .select("timezone,public_config")
      .eq("id", booking.tenant_id)
      .single();
    const tenantTimezone = String(tenantResult.data?.timezone ?? "").trim();
    if (tenantResult.error || !tenantTimezone) {
      throw new RequestError(
        503,
        "TENANT_TIMEZONE_UNAVAILABLE",
        "Receipt timing verification is temporarily unavailable.",
      );
    }
    const tenantPublicConfig = objectValue(
      tenantResult.data?.public_config,
    );
    const configuredAutoApprovalMethods = Array.isArray(
        tenantPublicConfig.receiptAutoApprovalMethods,
      )
      ? tenantPublicConfig.receiptAutoApprovalMethods
        .filter((method): method is string => typeof method === "string")
        .map((method) => method.trim().toLowerCase())
      : [];

    const path = parseReceiptObjectPath(input.storagePath);
    if (path.tenantId !== booking.tenant_id || path.bookingId !== booking.id) {
      throw new RequestError(
        403,
        "RECEIPT_PATH_DENIED",
        "The receipt object does not belong to this booking.",
      );
    }

    let paymentContext: ReceiptPaymentContext | undefined;
    let expectedAmount = Number(booking.total_amount);
    let receiptStartedAt = booking.created_at;
    let rescheduleAdjustment = false;
    if (input.paymentSessionId) {
      const sessionResult = await db.from("payment_sessions")
        .select(
          "id,amount,currency,status,provider,provider_payload,created_at",
        )
        .eq("id", input.paymentSessionId)
        .eq("tenant_id", booking.tenant_id)
        .eq("booking_id", booking.id)
        .in("status", ["created", "pending"])
        .single();
      if (sessionResult.error || !sessionResult.data) {
        throw new RequestError(
          404,
          "PAYMENT_SESSION_NOT_FOUND",
          "The payment session was not found for this booking.",
        );
      }
      if (String(sessionResult.data.currency) !== booking.currency) {
        throw new RequestError(
          409,
          "PAYMENT_AMOUNT_CONFLICT",
          "The payment session currency does not match the booking.",
        );
      }

      const providerPayload = objectValue(sessionResult.data.provider_payload);
      const provider = String(sessionResult.data.provider ?? "");
      expectedAmount = Number(sessionResult.data.amount);
      if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
        throw new RequestError(
          409,
          "PAYMENT_AMOUNT_CONFLICT",
          "The payment session amount is invalid.",
        );
      }
      if (provider === "manual_receipt") {
        assertBookingAcceptsReceipt(booking);
        if (Math.abs(expectedAmount - Number(booking.total_amount)) > 0.01) {
          throw new RequestError(
            409,
            "PAYMENT_AMOUNT_CONFLICT",
            "The payment session does not match the booking total.",
          );
        }
      } else if (provider === "manual_balance_receipt") {
        const balanceRequestId = String(
          providerPayload.balanceRequestId ?? "",
        );
        const balanceResult = await db.from("booking_balance_requests")
          .select("id,remaining_amount,status,deadline_at,request_type")
          .eq("id", balanceRequestId)
          .eq("tenant_id", booking.tenant_id)
          .eq("booking_id", booking.id)
          .single();
        if (
          balanceResult.error || !balanceResult.data ||
          balanceResult.data.status !== "awaiting_payment" ||
          new Date(balanceResult.data.deadline_at).getTime() <= Date.now() ||
          Math.abs(
              Number(balanceResult.data.remaining_amount) - expectedAmount,
            ) > 0.01
        ) {
          throw new RequestError(
            409,
            "BALANCE_REQUEST_CONFLICT",
            "The remaining-balance request is no longer payable.",
          );
        }
        rescheduleAdjustment =
          balanceResult.data.request_type === "reschedule_adjustment";
        if (rescheduleAdjustment) {
          if (
            booking.status !== "confirmed" ||
            booking.payment_status !== "paid"
          ) {
            throw new RequestError(
              409,
              "BALANCE_REQUEST_CONFLICT",
              "The original booking is no longer confirmed.",
            );
          }
        } else {
          assertBookingAcceptsReceipt(booking);
        }
        receiptStartedAt = String(sessionResult.data.created_at);
      } else {
        throw new RequestError(
          409,
          "PAYMENT_SESSION_NOT_FOUND",
          "The payment session is not a receipt-upload session.",
        );
      }
      const paymentMethod = String(providerPayload.paymentMethod ?? "")
        .trim().toLowerCase();
      const submittedReference = String(
        providerPayload.submittedReference ?? "",
      ).trim();
      const methodResult = await db.from("tenant_payment_methods")
        .select("method_code,account_name,account_reference")
        .eq("tenant_id", booking.tenant_id)
        .eq("method_code", paymentMethod)
        .eq("is_active", true)
        .maybeSingle();
      if (methodResult.error || !methodResult.data) {
        throw new RequestError(
          409,
          "PAYMENT_METHOD_UNAVAILABLE",
          "The selected payment method is no longer available.",
        );
      }
      paymentContext = {
        paymentMethod,
        submittedReference,
        receiverName: String(methodResult.data.account_name ?? "").trim(),
        receiverReference: String(
          methodResult.data.account_reference ?? "",
        ).trim(),
        autoApprovalEnabled: paymentMethod === "gcash" ||
          configuredAutoApprovalMethods.includes(paymentMethod),
      };
    } else {
      assertBookingAcceptsReceipt(booking);
    }

    const existingPath = await db.from("receipt_verifications")
      .select("id,booking_id,status,confidence,flags")
      .eq("tenant_id", booking.tenant_id)
      .eq("storage_path", input.storagePath)
      .maybeSingle();
    if (existingPath.error) {
      throw new RequestError(
        500,
        "RECEIPT_LOOKUP_FAILED",
        "The receipt verification could not be checked.",
      );
    }
    if (existingPath.data) {
      if (String(existingPath.data.booking_id) !== booking.id) {
        throw new RequestError(
          409,
          "RECEIPT_ALREADY_PROCESSED",
          "This receipt was already submitted.",
        );
      }
      return jsonResponse(
        {
          ok: true,
          existing: true,
          verification: verificationResponse(existingPath.data),
        },
        200,
        allowedOrigin,
      );
    }

    const bucket = db.storage.from(RECEIPT_BUCKET);
    const listed = await bucket.list(path.folder, {
      limit: 10,
      search: path.filename,
      sortBy: { column: "name", order: "asc" },
    });
    const storedObject = listed.data?.find((candidate) =>
      candidate.name === path.filename && Boolean(candidate.id)
    );
    if (listed.error || !storedObject) {
      throw new RequestError(
        404,
        "RECEIPT_OBJECT_NOT_FOUND",
        "The private receipt image was not found.",
      );
    }
    const objectMetadata = objectValue(storedObject.metadata);
    const metadata = validateReceiptObjectMetadata(
      objectMetadata.size,
      objectMetadata.mimetype ?? objectMetadata.contentType,
    );

    const downloaded = await bucket.download(input.storagePath);
    if (downloaded.error || !downloaded.data) {
      throw new RequestError(
        404,
        "RECEIPT_OBJECT_NOT_FOUND",
        "The private receipt image was not found.",
      );
    }
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    if (bytes.byteLength !== metadata.sizeBytes) {
      throw new RequestError(
        422,
        "RECEIPT_FILE_CHANGED",
        "The receipt object changed while it was being verified.",
      );
    }
    const image = inspectReceiptImage(
      bytes,
      path,
      metadata.mimeType,
      downloaded.data.type,
    );
    const fileSha256 = await sha256Hex(bytes);

    const existingFile = await db.from("receipt_verifications")
      .select("id,booking_id,status,confidence,flags")
      .eq("tenant_id", booking.tenant_id)
      .eq("file_sha256", fileSha256)
      .maybeSingle();
    if (existingFile.error) {
      throw new RequestError(
        500,
        "RECEIPT_LOOKUP_FAILED",
        "The receipt verification could not be checked.",
      );
    }
    if (existingFile.data) {
      if (String(existingFile.data.booking_id) !== booking.id) {
        throw new RequestError(
          409,
          "DUPLICATE_RECEIPT_FILE",
          "This receipt image was already used for another booking.",
        );
      }
      return jsonResponse(
        {
          ok: true,
          existing: true,
          verification: verificationResponse(existingFile.data),
        },
        200,
        allowedOrigin,
      );
    }

    const vision = await detectReceiptText({
      bytes,
      apiKey: requiredEnvironment("GOOGLE_VISION_API_KEY"),
    });
    const safe = buildSafeReceiptExtraction({
      vision,
      image,
      expectedAmount,
      currency: booking.currency,
      payment: paymentContext,
      timing: {
        bookingStartedAt: receiptStartedAt,
        tenantTimezone,
      },
    });

    const recorded = await db.rpc(
      rescheduleAdjustment
        ? "record_reschedule_adjustment_receipt_v2"
        : "record_receipt_verification_v2",
      {
        p_booking_id: booking.id,
        p_payment_session_id: input.paymentSessionId,
        p_storage_path: input.storagePath,
        p_file_sha256: fileSha256,
        p_payment_reference: safe.paymentReference,
        p_confidence: safe.extractedData.confidence.effective,
        p_flags: safe.flags,
        p_extracted_data: safe.extractedData,
      },
    );
    if (recorded.error) {
      console.error("record_receipt_verification_v2 failed", {
        code: recorded.error.code,
      });
      throw databaseFailure(recorded.error);
    }
    let result = objectValue(
      Array.isArray(recorded.data) ? recorded.data[0] : recorded.data,
    );
    if (!result.id) throw new Error("Receipt RPC returned no identifier.");

    if (safe.autoApprove && !rescheduleAdjustment) {
      const approved = await db.rpc("auto_approve_receipt_verification", {
        p_verification_id: String(result.id),
      });
      if (approved.error || !approved.data) {
        console.error("auto_approve_receipt_verification failed", {
          code: approved.error?.code,
        });
      } else {
        result = objectValue(
          Array.isArray(approved.data) ? approved.data[0] : approved.data,
        );
      }
    }

    return jsonResponse(
      {
        ok: true,
        existing: false,
        verification: verificationResponse(result),
      },
      201,
      allowedOrigin,
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
    console.error("Unhandled verify-receipt error", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(
      500,
      "RECEIPT_VERIFICATION_FAILED",
      "The receipt could not be verified.",
      allowedOrigin,
    );
  }
});
