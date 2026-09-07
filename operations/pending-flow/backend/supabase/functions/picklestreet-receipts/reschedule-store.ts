import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  bookingAccessTokenHash,
  deriveBalancePaymentAccessToken,
} from "../_shared/booking-access.ts";
import { RequestError } from "../_shared/http.ts";
import {
  type JsonObject,
  type RescheduleActorAccess,
  type RescheduleBookingStore,
} from "../_shared/reschedule-booking.ts";
import {
  resolveTenantForRequest,
  type TenantRequestContext,
} from "../_shared/tenant.ts";

type RpcError = {
  code?: string;
  message?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): JsonObject {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized && typeof normalized === "object" &&
      !Array.isArray(normalized)
    ? normalized as JsonObject
    : {};
}

function sameInstant(left: unknown, right: unknown): boolean {
  const leftTime = Date.parse(text(left));
  const rightTime = Date.parse(text(right));
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function managerDataUnavailable(): RequestError {
  return new RequestError(
    503,
    "RESCHEDULE_UNAVAILABLE",
    "The booking reschedule service is temporarily unavailable.",
  );
}

export function mapRpcError(
  error: RpcError | null,
  preview = false,
): RequestError {
  const message = text(error?.message).toLowerCase();
  if (error?.code === "42501" || message.includes("access denied")) {
    return new RequestError(
      403,
      "TENANT_ACCESS_DENIED",
      "This account cannot reschedule this booking.",
    );
  }
  if (error?.code === "P0002" || message.includes("was not found")) {
    return new RequestError(404, "BOOKING_NOT_FOUND", "Booking not found.");
  }
  if (message.includes("email_resend_rate_limited")) {
    return new RequestError(
      429,
      "EMAIL_RESEND_RATE_LIMITED",
      "Wait one minute before resending this notification.",
    );
  }
  if (message.includes("reschedule_event_superseded")) {
    return new RequestError(
      409,
      "RESCHEDULE_EVENT_SUPERSEDED",
      "This notification belongs to an older schedule and cannot be resent.",
    );
  }
  if (
    error?.code === "22023" &&
    (message.includes("receipt activity or payment review") ||
      message.includes("unresolved receipt evidence") ||
      message.includes("already has an active payment request"))
  ) {
    return new RequestError(
      409,
      "RESCHEDULE_ADJUSTMENT_PROTECTED",
      "Resolve the existing payment request before rescheduling this booking again.",
    );
  }
  if (
    error?.code === "23P01" || message.includes("no longer available") ||
    message.includes("blocked during")
  ) {
    return new RequestError(
      409,
      "RESCHEDULE_SLOT_UNAVAILABLE",
      "That schedule is no longer available. Choose another time.",
    );
  }
  if (
    error?.code === "22023" &&
    (message.includes("maximum advance") || message.includes("future") ||
      message.includes("minimum lead") ||
      message.includes("outside the court") ||
      message.includes("cannot be rescheduled") ||
      message.includes("not available for rescheduling") ||
      message.includes("hold has expired") ||
      message.includes("idempotency key was already used") ||
      message.includes("same booking duration") ||
      message.includes("different date"))
  ) {
    return new RequestError(
      preview ? 400 : 409,
      "RESCHEDULE_REJECTED",
      text(error?.message) || "The reschedule request was rejected.",
    );
  }
  return managerDataUnavailable();
}

async function assertCurrentEvent(
  db: SupabaseClient,
  tenantId: string,
  event: JsonObject,
): Promise<void> {
  const bookingId = text(event.booking_id);
  const bookingResult = await db.from("bookings")
    .select("id,starts_at,ends_at,status,expires_at,archived_at,metadata")
    .eq("tenant_id", tenantId)
    .eq("id", bookingId)
    .maybeSingle();
  if (bookingResult.error) {
    throw managerDataUnavailable();
  }
  const booking = bookingResult.data;
  const lastReschedule = objectValue(
    objectValue(booking?.metadata).lastReschedule,
  );
  const bookingEndsAt = Date.parse(text(booking?.ends_at));
  const holdExpiresAt = Date.parse(text(booking?.expires_at));
  const isExpiringHold = booking?.status === "pending_payment" ||
    booking?.status === "payment_review";
  if (
    !booking ||
    text(lastReschedule.eventId) !== text(event.id) ||
    booking.archived_at !== null ||
    !["pending_payment", "payment_review", "confirmed"].includes(
      text(booking.status),
    ) ||
    !Number.isFinite(bookingEndsAt) ||
    bookingEndsAt <= Date.now() ||
    (isExpiringHold && Number.isFinite(holdExpiresAt) &&
      holdExpiresAt <= Date.now()) ||
    !sameInstant(booking.starts_at, event.new_starts_at) ||
    !sameInstant(booking.ends_at, event.new_ends_at)
  ) {
    throw new RequestError(
      409,
      "RESCHEDULE_EVENT_SUPERSEDED",
      "This notification belongs to an older schedule and cannot be resent.",
    );
  }
}

function createUserClient(options: {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  origin: string;
}): SupabaseClient {
  return createClient(options.supabaseUrl, options.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Origin: options.origin,
      },
    },
  });
}

export function createSupabaseRescheduleBookingStore(options: {
  db: SupabaseClient;
  supabaseUrl: string;
  anonKey: string;
  bookingAccessTokenSecret: string;
}): RescheduleBookingStore {
  const { db, supabaseUrl, anonKey, bookingAccessTokenSecret } = options;
  return {
    async resolveTenant(
      tenantSlug: unknown,
      originHeader: string | null,
    ): Promise<TenantRequestContext> {
      return await resolveTenantForRequest(db, tenantSlug, originHeader);
    },

    async authenticate(accessToken: string): Promise<string | null> {
      const result = await db.auth.getUser(accessToken);
      if (result.error) return null;
      const userId = result.data.user?.id ?? "";
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(userId)
        ? userId
        : null;
    },

    async authorize(
      tenantId: string,
      userId: string,
    ): Promise<RescheduleActorAccess> {
      const [membershipResult, profileResult] = await Promise.all([
        db.from("tenant_memberships")
          .select("role")
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
      if (membershipResult.error || profileResult.error) {
        throw managerDataUnavailable();
      }
      const role = text(membershipResult.data?.role);
      return {
        membershipRole: role === "owner" || role === "admin" || role === "staff"
          ? role
          : null,
        isSystemOwner: Boolean(profileResult.data),
      };
    },

    async findBookingId(
      tenantId: string,
      bookingReference: string,
    ): Promise<string | null> {
      const result = await db.from("bookings")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("reference", bookingReference)
        .is("archived_at", null)
        .maybeSingle();
      if (result.error) throw managerDataUnavailable();
      return text(result.data?.id) || null;
    },

    async preview(previewOptions): Promise<JsonObject> {
      const userDb = createUserClient({
        supabaseUrl,
        anonKey,
        accessToken: previewOptions.accessToken,
        origin: previewOptions.origin,
      });
      const result = await userDb.rpc(
        "preview_tenant_booking_reschedule_priced",
        {
          p_booking_id: previewOptions.bookingId,
          p_local_date: previewOptions.bookingDate,
        },
      );
      if (result.error || !result.data) {
        throw mapRpcError(result.error, true);
      }
      return objectValue(result.data);
    },

    async reschedule(rescheduleOptions): Promise<JsonObject> {
      const userDb = createUserClient({
        supabaseUrl,
        anonKey,
        accessToken: rescheduleOptions.accessToken,
        origin: rescheduleOptions.origin,
      });
      const balanceRequestId = crypto.randomUUID();
      const balanceToken = await deriveBalancePaymentAccessToken({
        secret: bookingAccessTokenSecret,
        tenantId: rescheduleOptions.tenantId,
        balanceRequestId,
      });
      const result = await userDb.rpc(
        "prepare_owner_repeatable_booking_reschedule",
        {
          p_booking_id: rescheduleOptions.bookingId,
          p_local_date: rescheduleOptions.newDate,
          p_start_time: rescheduleOptions.newStartTime,
          p_reason_code: rescheduleOptions.reasonCode,
          p_public_reason: rescheduleOptions.publicReason,
          p_internal_note: rescheduleOptions.internalNote,
          p_notify_customer: rescheduleOptions.notifyCustomer,
          p_idempotency_key: rescheduleOptions.idempotencyKey,
          p_balance_request_id: balanceRequestId,
          p_access_token_hash: await bookingAccessTokenHash(balanceToken),
          p_deadline_at: rescheduleOptions.deadlineAt,
        },
      );
      if (result.error || !result.data) throw mapRpcError(result.error);
      return objectValue(result.data);
    },

    async getEvent(
      tenantId: string,
      bookingReference: string,
      eventId: string,
    ): Promise<JsonObject | null> {
      const bookingResult = await db.from("bookings")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("reference", bookingReference)
        .maybeSingle();
      if (bookingResult.error) throw managerDataUnavailable();
      if (!bookingResult.data) return null;
      const result = await db.from("booking_reschedule_events")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("booking_id", bookingResult.data.id)
        .eq("id", eventId)
        .maybeSingle();
      if (result.error) throw managerDataUnavailable();
      const event = result.data as JsonObject | null;
      if (event) await assertCurrentEvent(db, tenantId, event);
      return event;
    },

    async getEmailPayload(
      tenantId: string,
      eventId: string,
    ): Promise<JsonObject | null> {
      const eventResult = await db.from("booking_reschedule_events")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", eventId)
        .maybeSingle();
      if (eventResult.error) throw managerDataUnavailable();
      const event = eventResult.data;
      if (!event) return null;
      await assertCurrentEvent(db, tenantId, event as JsonObject);
      const [bookingResult, courtResult, tenantResult] = await Promise.all([
        db.from("bookings")
          .select(
            "id,reference,customer_name,total_amount,currency,status,payment_status",
          )
          .eq("tenant_id", tenantId)
          .eq("id", event.booking_id)
          .maybeSingle(),
        db.from("courts")
          .select("id,name")
          .eq("tenant_id", tenantId)
          .eq("id", event.court_id)
          .maybeSingle(),
        db.from("tenants")
          .select(
            "id,slug,name,timezone,branding,contact_email,contact_phone,reply_to_email,public_config",
          )
          .eq("id", tenantId)
          .maybeSingle(),
      ]);
      if (
        bookingResult.error || courtResult.error || tenantResult.error ||
        !bookingResult.data || !courtResult.data || !tenantResult.data
      ) {
        throw managerDataUnavailable();
      }
      const tenant = tenantResult.data;
      const publicConfig = objectValue(tenant.public_config);
      return {
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          timezone: tenant.timezone,
          branding: tenant.branding,
          contactEmail: tenant.contact_email,
          contactPhone: tenant.contact_phone,
          replyToEmail: tenant.reply_to_email,
          emailEnabled: publicConfig.emailEnabled === true,
        },
        booking: {
          id: bookingResult.data.id,
          reference: bookingResult.data.reference,
          customerName: bookingResult.data.customer_name,
          customerEmail: event.customer_email_snapshot,
          totalAmount: event.total_amount,
          currency: event.currency,
          status: bookingResult.data.status,
          paymentStatus: bookingResult.data.payment_status,
        },
        court: courtResult.data,
        event,
      };
    },

    async claimEmail(
      eventId: string,
      forceResend: boolean,
    ): Promise<JsonObject> {
      const result = await db.rpc("claim_booking_reschedule_email", {
        p_event_id: eventId,
        p_force_resend: forceResend,
      });
      if (result.error || !result.data) throw mapRpcError(result.error);
      return objectValue(result.data);
    },

    async finishEmail(finishOptions): Promise<JsonObject> {
      const result = await db.rpc("finish_booking_reschedule_email", {
        p_event_id: finishOptions.eventId,
        p_status: finishOptions.status,
        p_provider_reference: finishOptions.providerReference,
        p_error_code: finishOptions.errorCode,
      });
      if (result.error || !result.data) throw managerDataUnavailable();
      return objectValue(result.data);
    },

    async skipEmail(
      eventId: string,
      status: "disabled" | "skipped_no_email" | "not_requested",
    ): Promise<JsonObject> {
      const result = await db.rpc("skip_booking_reschedule_email", {
        p_event_id: eventId,
        p_status: status,
      });
      if (result.error || !result.data) throw managerDataUnavailable();
      return objectValue(result.data);
    },
  };
}
