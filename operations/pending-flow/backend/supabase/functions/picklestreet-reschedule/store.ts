import type { SupabaseClient } from "@supabase/supabase-js";
import {
  bookingAccessTokenHash,
  deriveBalancePaymentAccessToken,
} from "../_shared/booking-access.ts";
import { RequestError } from "../_shared/http.ts";
import { resolveTenantForRequest } from "../_shared/tenant.ts";
import type { JsonObject } from "../_shared/reschedule-booking.ts";
import {
  createGroupEmailStore,
  deliverGroupedRescheduleEmail,
} from "./email.ts";
import {
  type GroupStore,
  objectValue,
  TENANT_ID,
  TENANT_SLUG,
  text,
} from "./handler.ts";

export function groupRpcError(
  error: { code?: string; message?: string } | null,
): RequestError {
  const message = text(error?.message).toLowerCase();
  if (error?.code === "42501" || /access_denied|access denied/.test(message)) {
    return new RequestError(
      403,
      "TENANT_ACCESS_DENIED",
      "Only an active venue owner or admin can reschedule this booking.",
    );
  }
  if (error?.code === "P0002" || /not_found|was not found/.test(message)) {
    return new RequestError(404, "BOOKING_NOT_FOUND", "Booking not found.");
  }
  if (/quote_stale|price.*changed/.test(message)) {
    return new RequestError(
      409,
      "RESCHEDULE_PRICE_CHANGED",
      "Court prices changed. Review the updated total before confirming.",
    );
  }
  if (/stale|original_booking_changed|idempotency/.test(message)) {
    return new RequestError(
      409,
      "RESCHEDULE_BOOKING_CHANGED",
      "This booking changed. Reload its current schedule before rescheduling.",
    );
  }
  if (
    error?.code === "23P01" || /slot|overlap|unavailable|blocked/.test(message)
  ) {
    return new RequestError(
      409,
      "RESCHEDULE_SLOT_UNAVAILABLE",
      "A selected court time is unavailable. Your original schedule is unchanged.",
    );
  }
  if (
    /active_payment|receipt|payment review|adjustment|balance.*active/.test(
      message,
    )
  ) {
    return new RequestError(
      409,
      "RESCHEDULE_ADJUSTMENT_PROTECTED",
      "Resolve the current additional-payment request before rescheduling again.",
    );
  }
  if (
    error?.code === "22023" ||
    /check.?in|weather|refund|past|future|eligible/.test(message)
  ) {
    return new RequestError(
      409,
      "RESCHEDULE_REJECTED",
      "This schedule cannot be changed. Check the booking status, selected times, and venue opening hours.",
    );
  }
  return new RequestError(
    503,
    "RESCHEDULE_UNAVAILABLE",
    "Rescheduling is temporarily unavailable. Refresh the booking before trying again.",
  );
}

export function createGroupStore(
  db: SupabaseClient,
  bookingAccessTokenSecret: string,
): GroupStore {
  async function withPaymentUrl(
    balance: JsonObject,
    origin: string,
  ): Promise<JsonObject> {
    if (!text(balance.id)) return balance;
    const token = await deriveBalancePaymentAccessToken({
      secret: bookingAccessTokenSecret,
      tenantId: TENANT_ID,
      balanceRequestId: text(balance.id),
    });
    const url = new URL("/", origin);
    url.searchParams.set("balanceRequest", text(balance.id));
    url.searchParams.set("balanceToken", token);
    return { ...balance, paymentUrl: url.href };
  }
  async function rpc(name: string, args: JsonObject): Promise<JsonObject> {
    const result = await db.rpc(name, args);
    if (result.error || !result.data) throw groupRpcError(result.error);
    return objectValue(result.data);
  }
  return {
    resolveTenant: (slug, origin) => resolveTenantForRequest(db, slug, origin),
    async authenticate(token) {
      const result = await db.auth.getUser(token);
      return !result.error ? result.data.user?.id ?? null : null;
    },
    async authorize(tenantId, actor) {
      if (tenantId !== TENANT_ID) return false;
      const [membership, profile] = await Promise.all([
        db.from("tenant_memberships").select("id").eq("tenant_id", TENANT_ID)
          .eq("user_id", actor).eq("status", "active").in("role", [
            "owner",
            "admin",
          ]).maybeSingle(),
        db.from("platform_profiles").select("user_id").eq("user_id", actor).eq(
          "is_platform_owner",
          true,
        ).maybeSingle(),
      ]);
      if (membership.error || profile.error) {
        throw new RequestError(
          503,
          "AUTHORIZATION_UNAVAILABLE",
          "Venue access could not be checked.",
        );
      }
      return Boolean(membership.data || profile.data);
    },
    async findBookingId(reference) {
      const result = await db.from("bookings").select("id").eq(
        "tenant_id",
        TENANT_ID,
      ).eq("reference", reference).is("archived_at", null).maybeSingle();
      if (result.error) throw groupRpcError(result.error);
      return result.data?.id ?? null;
    },
    async context(id, actor, origin) {
      const result = await rpc("get_picklestreet_group_reschedule", {
        p_booking_id: id,
        p_actor_user_id: actor,
      });
      const pending = objectValue(result.pendingAdjustment);
      if (
        ["awaiting_payment", "payment_review"].includes(text(pending.status))
      ) result.pendingAdjustment = await withPaymentUrl(pending, origin);
      return result;
    },
    options: (id, actor, session, date, version) =>
      rpc("options_picklestreet_group_reschedule", {
        p_booking_id: id,
        p_actor_user_id: actor,
        p_session_id: session,
        p_local_date: date,
        p_expected_version: version,
      }),
    preview: (id, actor, changes, reason, version) =>
      rpc("preview_picklestreet_group_reschedule", {
        p_booking_id: id,
        p_actor_user_id: actor,
        p_changes: changes,
        p_reason_code: reason,
        p_expected_version: version,
      }),
    async reschedule(input) {
      const balanceId = crypto.randomUUID();
      const token = await deriveBalancePaymentAccessToken({
        secret: bookingAccessTokenSecret,
        tenantId: TENANT_ID,
        balanceRequestId: balanceId,
      });
      const result = await rpc("apply_picklestreet_group_reschedule", {
        p_booking_id: input.bookingId,
        p_actor_user_id: input.actor,
        p_changes: input.changes,
        p_reason_code: input.reason,
        p_expected_version: input.version,
        p_expected_quote_hash: input.quoteHash,
        p_public_reason: input.publicReason,
        p_internal_note: input.internalNote,
        p_notify_customer: input.notifyCustomer,
        p_idempotency_key: input.idempotencyKey,
        p_balance_request_id: balanceId,
        p_access_token_hash: await bookingAccessTokenHash(token),
      });
      const balance = objectValue(result.balanceRequest);
      if (result.paymentRequired === true && text(balance.id)) {
        // Replayed requests return their original balance identifier. Re-derive
        // its credential instead of returning a token for this new candidate ID.
        result.balanceRequest = await withPaymentUrl(balance, input.origin);
      }
      return result;
    },
    deliver: (eventId, bookingId, forceResend, sender) =>
      deliverGroupedRescheduleEmail({
        store: createGroupEmailStore(db),
        sender,
        eventId,
        bookingId,
        forceResend,
      }),
  };
}
