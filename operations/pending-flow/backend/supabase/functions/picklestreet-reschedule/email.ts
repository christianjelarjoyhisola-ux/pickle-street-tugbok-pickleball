import type { SupabaseClient } from "@supabase/supabase-js";
import { RequestError } from "../_shared/http.ts";
import {
  MailerooDeliveryError,
  sendMailerooEmail,
} from "../_shared/maileroo.ts";
import type {
  JsonObject,
  RescheduleEmailMessage,
  RescheduleEmailSender,
} from "../_shared/reschedule-booking.ts";
import { objectValue, TENANT_ID, TENANT_SLUG, text } from "./handler.ts";

const htmlEscape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const rows = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.map(objectValue) : [];
function schedule(session: JsonObject, timezone: string): string {
  const start = new Date(text(session.startsAt ?? session.starts_at));
  const end = new Date(text(session.endsAt ?? session.ends_at));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("Invalid group schedule.");
  }
  const day = new Intl.DateTimeFormat("en-PH", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const time = new Intl.DateTimeFormat("en-PH", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  const endDate = day.format(end) !== day.format(start)
    ? ` (${day.format(end)})`
    : "";
  return `${text(session.courtName ?? session.court_name) || "Court"} — ${
    day.format(start)
  } · ${time.format(start)}–${time.format(end)}${endDate}`;
}
function money(value: unknown, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Invalid reschedule amount.");
  }
  return new Intl.NumberFormat("en-PH", { style: "currency", currency }).format(
    amount,
  );
}

export function buildGroupedRescheduleEmail(
  payload: JsonObject,
  referenceId: string,
): RescheduleEmailMessage {
  const tenant = objectValue(payload.tenant),
    booking = objectValue(payload.booking),
    event = objectValue(payload.event);
  const before = rows(payload.beforeSessions), after = rows(payload.sessions);
  if (!after.length || !before.length) {
    throw new Error("The complete booking schedule is required.");
  }
  const timezone = text(tenant.timezone) || "Asia/Manila";
  const tenantName = text(tenant.name) || "Pickle Street Tugbok";
  const customerName = text(booking.customerName) || "Guest";
  const reference = text(booking.reference),
    reason = text(event.public_reason ?? event.publicReason);
  const currency = text(booking.currency) || "PHP";
  const total = money(booking.totalAmount, currency);
  const quote = objectValue(payload.quote);
  const additional = Number(
    objectValue(quote.price).additionalAmount ?? quote.additionalAmount ?? 0,
  );
  const current = after.map((row) => schedule(row, timezone));
  const changes = after.flatMap((row, index) => {
    const id = text(row.sessionId ?? row.session_id);
    const old = before.find((b) =>
      id && text(b.sessionId ?? b.session_id) === id
    ) ?? before[index];
    if (
      !old ||
      (text(old.startsAt ?? old.starts_at) ===
          text(row.startsAt ?? row.starts_at) &&
        text(old.endsAt ?? old.ends_at) === text(row.endsAt ?? row.ends_at))
    ) return [];
    return [{
      previous: schedule(old, timezone),
      next: schedule(row, timezone),
    }];
  });
  const list = current.map((item) =>
    `<li style="padding:9px 0">${htmlEscape(item)}</li>`
  ).join("");
  const history = changes.map((item) =>
    `<div style="padding:12px 0;border-bottom:1px solid #dce6e9"><div style="color:#667b84;font-size:13px">Previous: ${
      htmlEscape(item.previous)
    }</div><div style="margin-top:5px;font-weight:600">Updated: ${
      htmlEscape(item.next)
    }</div></div>`
  ).join("");
  const amountNote = additional > 0
    ? `Additional payment received: ${money(additional, currency)}.`
    : "Your original payment is carried forward.";
  const plainText = [
    `Hello ${customerName},`,
    "",
    `Your ${tenantName} booking has been rescheduled.`,
    `Booking reference: ${reference}`,
    "",
    "Your complete confirmed schedule:",
    ...current.map((item) => `• ${item}`),
    "",
    "Schedule changes:",
    ...changes.flatMap(
      (item) => [`Previous: ${item.previous}`, `Updated: ${item.next}`],
    ),
    "",
    `Reason: ${reason}`,
    `Booking total: ${total}`,
    amountNote,
    "Your booking reference and payment history remain the same.",
    "Reply to this email if you need help.",
  ].join("\n");
  const html =
    `<!doctype html><html><body style="margin:0;background:#eef3f5;color:#16323d;font-family:Arial,sans-serif"><div style="max-width:640px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden"><div style="padding:26px;background:#176c7b;color:white"><div style="font-size:12px;letter-spacing:2px">${
      htmlEscape(tenantName.toUpperCase())
    }</div><h1 style="font-size:25px;margin:12px 0 0">Your booking is rescheduled</h1></div><div style="padding:26px"><p>Hello ${
      htmlEscape(customerName)
    },</p><p>All confirmed court sessions are listed below under your one booking reference.</p><div style="padding:16px;background:#eef6f7;border-radius:10px"><div style="font-size:12px;color:#536b73">BOOKING REFERENCE</div><strong>${
      htmlEscape(reference)
    }</strong></div><h2 style="font-size:19px">Your complete schedule</h2><ul style="padding-left:20px;line-height:1.6">${list}</ul><h2 style="font-size:19px">What changed</h2>${history}<p><strong>Reason:</strong> ${
      htmlEscape(reason)
    }</p><p><strong>Booking total:</strong> ${htmlEscape(total)}<br>${
      htmlEscape(amountNote)
    }</p><p style="font-size:14px;color:#536b73">Your booking reference and payment history remain the same. Reply to this email if you need help.</p></div></div></body></html>`;
  return {
    fromName: tenantName,
    replyTo: text(tenant.replyToEmail) || text(tenant.contactEmail),
    replyToName: tenantName,
    to: text(booking.customerEmail),
    toName: customerName,
    subject: `${tenantName} booking rescheduled ${reference}`,
    html,
    plainText,
    referenceId,
    tags: {
      tenant: TENANT_SLUG,
      booking: reference,
      kind: "group_booking_rescheduled",
    },
  };
}

export interface GroupEmailStore {
  payload(eventId: string, bookingId?: string): Promise<JsonObject | null>;
  claim(eventId: string, forceResend: boolean): Promise<JsonObject>;
  finish(
    eventId: string,
    status: "sent" | "failed" | "delivery_unknown",
    providerReference: string | null,
    errorCode: string | null,
  ): Promise<JsonObject>;
  skip(eventId: string, status: string): Promise<void>;
}
export function createGroupEmailStore(db: SupabaseClient): GroupEmailStore {
  async function rpc(name: string, args: JsonObject): Promise<JsonObject> {
    const result = await db.rpc(name, args);
    if (result.error || !result.data) {
      const message = text(result.error?.message);
      if (message.includes("rate_limited")) {
        throw new RequestError(
          429,
          "EMAIL_RESEND_RATE_LIMITED",
          "Wait one minute before resending this notification.",
        );
      }
      if (message.includes("superseded")) {
        throw new RequestError(
          409,
          "RESCHEDULE_EVENT_SUPERSEDED",
          "This notification belongs to an older booking schedule.",
        );
      }
      throw new Error("Reschedule email state unavailable.");
    }
    return objectValue(result.data);
  }
  return {
    async payload(eventId, bookingId) {
      const group = await db.from("picklestreet_group_reschedule_events")
        .select("*").eq("tenant_id", TENANT_ID).eq("event_id", eventId)
        .maybeSingle();
      if (group.error) throw new Error("Group schedule unavailable.");
      if (!group.data || (bookingId && group.data.booking_id !== bookingId)) {
        return null;
      }
      const [eventResult, bookingResult, tenantResult] = await Promise.all([
        db.from("booking_reschedule_events").select("*").eq(
          "tenant_id",
          TENANT_ID,
        ).eq("id", eventId).eq("booking_id", group.data.booking_id)
          .maybeSingle(),
        db.from("bookings").select(
          "id,reference,customer_name,total_amount,currency,status,payment_status,starts_at,ends_at,archived_at,metadata",
        ).eq("tenant_id", TENANT_ID).eq("id", group.data.booking_id)
          .maybeSingle(),
        db.from("tenants").select(
          "name,timezone,contact_email,reply_to_email,public_config",
        ).eq("id", TENANT_ID).single(),
      ]);
      if (eventResult.error || bookingResult.error || tenantResult.error) {
        throw new Error("Group email unavailable.");
      }
      const event = eventResult.data,
        booking = bookingResult.data,
        tenant = tenantResult.data;
      if (!event || !booking || !tenant) return null;
      const last = objectValue(objectValue(booking.metadata).lastReschedule);
      if (
        text(last.eventId) !== eventId || booking.archived_at ||
        booking.status !== "confirmed" || booking.payment_status !== "paid" ||
        Date.parse(booking.ends_at) <= Date.now() ||
        Date.parse(booking.starts_at) !== Date.parse(event.new_starts_at) ||
        Date.parse(booking.ends_at) !== Date.parse(event.new_ends_at)
      ) {
        throw new RequestError(
          409,
          "RESCHEDULE_EVENT_SUPERSEDED",
          "This notification belongs to an older booking schedule.",
        );
      }
      return {
        tenant: {
          ...tenant,
          replyToEmail: tenant.reply_to_email,
          contactEmail: tenant.contact_email,
          emailEnabled: objectValue(tenant.public_config).emailEnabled === true,
        },
        booking: {
          id: booking.id,
          reference: booking.reference,
          customerName: booking.customer_name,
          customerEmail: event.customer_email_snapshot,
          totalAmount: booking.total_amount,
          currency: booking.currency,
        },
        event,
        beforeSessions: group.data.before_sessions,
        sessions: group.data.after_sessions,
        quote: group.data.quote,
      };
    },
    claim: (id, force) =>
      rpc("claim_booking_reschedule_email", {
        p_event_id: id,
        p_force_resend: force,
      }),
    finish: (id, status, ref, code) =>
      rpc("finish_booking_reschedule_email", {
        p_event_id: id,
        p_status: status,
        p_provider_reference: ref,
        p_error_code: code,
      }),
    async skip(id, status) {
      await rpc("skip_booking_reschedule_email", {
        p_event_id: id,
        p_status: status,
      });
    },
  };
}

export async function deliverGroupedRescheduleEmail(
  options: {
    store: GroupEmailStore;
    sender: RescheduleEmailSender;
    eventId: string;
    bookingId?: string;
    forceResend?: boolean;
    retryFailed?: boolean;
  },
): Promise<JsonObject> {
  const { store, sender, eventId } = options;
  const payload = await store.payload(eventId, options.bookingId);
  if (!payload) {
    throw new RequestError(
      404,
      "RESCHEDULE_EVENT_NOT_FOUND",
      "The grouped reschedule was not found for this booking.",
    );
  }
  const tenant = objectValue(payload.tenant),
    booking = objectValue(payload.booking),
    event = objectValue(payload.event);
  const state = text(event.email_status);
  // Never automatically reclaim an ambiguous or interrupted send. This prevents
  // a provider timeout from causing duplicate customer confirmations.
  if (["sending", "delivery_unknown"].includes(state)) {
    return { status: state, existing: true };
  }
  if (!options.forceResend && event.notify_customer !== true) {
    await store.skip(eventId, "not_requested");
    return { status: "not_requested" };
  }
  if (tenant.emailEnabled !== true) {
    await store.skip(eventId, "disabled");
    return { status: "disabled" };
  }
  if (!text(booking.customerEmail)) {
    await store.skip(eventId, "skipped_no_email");
    return { status: "skipped_no_email" };
  }
  const startedAt = Date.parse(text(event.email_started_at));
  if (
    options.retryFailed && state === "failed" && Number.isFinite(startedAt) &&
    Date.now() - startedAt < 60_000
  ) return { status: "failed", existing: true };
  const referenceId = options.forceResend
    ? crypto.randomUUID().replaceAll("-", "").slice(0, 24)
    : eventId.replaceAll("-", "").slice(0, 24);
  // Render before taking the delivery claim so invalid data cannot strand a send.
  const message = buildGroupedRescheduleEmail(payload, referenceId);
  const claim = await store.claim(
    eventId,
    options.forceResend === true ||
      (options.retryFailed === true && state === "failed"),
  );
  if (claim.shouldSend !== true) {
    return { status: text(claim.status) || "pending", existing: true };
  }
  let delivery: { referenceId: string | null };
  try {
    delivery = await sender.send(message);
  } catch (error) {
    const unknown = error instanceof MailerooDeliveryError &&
      error.outcomeUnknown;
    const status = unknown ? "delivery_unknown" : "failed";
    await store.finish(
      eventId,
      status,
      null,
      unknown ? "MAILEROO_DELIVERY_UNKNOWN" : "MAILEROO_DELIVERY_FAILED",
    );
    return { status };
  }
  try {
    const finished = await store.finish(
      eventId,
      "sent",
      delivery.referenceId,
      null,
    );
    return {
      status: "sent",
      deliveryId: delivery.referenceId,
      sentAt: finished.sentAt ?? null,
    };
  } catch {
    try {
      await store.finish(
        eventId,
        "delivery_unknown",
        delivery.referenceId,
        "EMAIL_FINALIZATION_UNKNOWN",
      );
    } catch { /* Keep the existing claim for reconciliation. */ }
    return { status: "delivery_unknown", deliveryId: delivery.referenceId };
  }
}

export function createGroupedRescheduleEmailSender(): RescheduleEmailSender {
  const env = (name: string): string => {
    const value = Deno.env.get(name)?.trim();
    if (!value) throw new Error("Email configuration unavailable.");
    return value;
  };
  return {
    async send(message) {
      return await sendMailerooEmail({
        ...message,
        apiKey: env("PICKLESTREET_MAILEROO_API_KEY"),
        fromAddress: env("PICKLESTREET_MAILEROO_FROM_EMAIL"),
      });
    },
  };
}

export async function dispatchDueGroupRescheduleEmails(
  db: SupabaseClient,
  sender: RescheduleEmailSender,
): Promise<{ checked: number; sent: number }> {
  // The database filters current event IDs before LIMIT, so historical failed
  // notices cannot crowd a current booking out of the dispatch queue.
  const due = await db.rpc("list_due_picklestreet_group_reschedule_emails");
  if (due.error) throw new Error("Grouped reschedule outbox unavailable.");
  const store = createGroupEmailStore(db);
  const results = await Promise.all(
    rows(due.data).map(async (event) => {
      try {
        return await deliverGroupedRescheduleEmail({
          store,
          sender,
          eventId: text(event.event_id),
          bookingId: text(event.booking_id),
          retryFailed: true,
        });
      } catch {
        return { status: "pending" };
      }
    }),
  );
  return {
    checked: results.length,
    sent: results.filter((row) => row.status === "sent").length,
  };
}
