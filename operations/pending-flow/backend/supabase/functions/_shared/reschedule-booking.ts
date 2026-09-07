import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  readJsonObject,
  RequestError,
} from "./http.ts";
import { MailerooDeliveryError } from "./maileroo.ts";
import { normalizeTenantSlug, type TenantRequestContext } from "./tenant.ts";

export const RESCHEDULE_REASON_CODES = [
  { value: "customer_request", label: "Customer request" },
  { value: "weather", label: "Weather" },
  { value: "court_maintenance", label: "Court maintenance" },
  { value: "schedule_conflict", label: "Schedule conflict" },
  { value: "admin_correction", label: "Admin correction" },
  { value: "other", label: "Other" },
] as const;

export type RescheduleActorAccess = {
  membershipRole: "owner" | "admin" | "staff" | null;
  isSystemOwner: boolean;
};

export type JsonObject = Record<string, unknown>;

export type RescheduleEmailMessage = {
  fromName: string;
  replyTo: string;
  replyToName: string;
  to: string;
  toName: string;
  subject: string;
  html: string;
  plainText: string;
  referenceId: string;
  tags: Record<string, string>;
};

export interface RescheduleEmailSender {
  send(
    message: RescheduleEmailMessage,
  ): Promise<{ referenceId: string | null }>;
}

export interface RescheduleBookingStore {
  resolveTenant(
    tenantSlug: unknown,
    originHeader: string | null,
  ): Promise<TenantRequestContext>;
  authenticate(accessToken: string): Promise<string | null>;
  authorize(
    tenantId: string,
    userId: string,
  ): Promise<RescheduleActorAccess>;
  findBookingId(
    tenantId: string,
    bookingReference: string,
  ): Promise<string | null>;
  preview(options: {
    accessToken: string;
    origin: string;
    bookingId: string;
    bookingDate: string;
  }): Promise<JsonObject>;
  reschedule(options: {
    accessToken: string;
    origin: string;
    tenantId: string;
    bookingId: string;
    newDate: string;
    newStartTime: string;
    reasonCode: string;
    publicReason: string;
    internalNote: string | null;
    notifyCustomer: boolean;
    idempotencyKey: string;
    deadlineAt: string | null;
  }): Promise<JsonObject>;
  getEvent(
    tenantId: string,
    bookingReference: string,
    eventId: string,
  ): Promise<JsonObject | null>;
  getEmailPayload(
    tenantId: string,
    eventId: string,
  ): Promise<JsonObject | null>;
  claimEmail(
    eventId: string,
    forceResend: boolean,
  ): Promise<JsonObject>;
  finishEmail(options: {
    eventId: string;
    status: "sent" | "failed" | "delivery_unknown";
    providerReference: string | null;
    errorCode: string | null;
  }): Promise<JsonObject>;
  skipEmail(
    eventId: string,
    status: "disabled" | "skipped_no_email" | "not_requested",
  ): Promise<JsonObject>;
}

type RescheduleAction = "preview" | "reschedule" | "resend";

const COMMON_KEYS = new Set(["action", "tenantSlug", "bookingReference"]);
const PREVIEW_KEYS = new Set([...COMMON_KEYS, "bookingDate"]);
const RESCHEDULE_KEYS = new Set([
  ...COMMON_KEYS,
  "newDate",
  "newStartTime",
  "reasonCode",
  "publicReason",
  "internalNote",
  "notifyCustomer",
  "idempotencyKey",
  "deadlineAt",
]);
const RESEND_KEYS = new Set([...COMMON_KEYS, "eventId"]);
const REASON_VALUES = new Set(
  RESCHEDULE_REASON_CODES.map((reason) => reason.value),
);

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

function field(value: JsonObject, camel: string, snake: string): unknown {
  return value[camel] ?? value[snake];
}

function assertOnlyKeys(body: JsonObject, allowed: ReadonlySet<string>): void {
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new RequestError(
      400,
      "RESCHEDULE_FIELDS_INVALID",
      "The reschedule request contains an unsupported field.",
    );
  }
}

function parseAction(value: unknown): RescheduleAction {
  if (value === "preview" || value === "reschedule" || value === "resend") {
    return value;
  }
  throw new RequestError(
    400,
    "RESCHEDULE_ACTION_INVALID",
    "Choose preview, reschedule, or resend.",
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

function parseDate(value: unknown, label: string): string {
  const date = text(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new RequestError(
      400,
      "RESCHEDULE_DATE_INVALID",
      `${label} must use YYYY-MM-DD.`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000 || year > 2200 || candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day
  ) {
    throw new RequestError(
      400,
      "RESCHEDULE_DATE_INVALID",
      `${label} must be a real calendar date.`,
    );
  }
  return date;
}

function parseStartTime(value: unknown): string {
  const startTime = text(value);
  if (!/^(?:[01]\d|2[0-3]):00$/.test(startTime)) {
    throw new RequestError(
      400,
      "RESCHEDULE_TIME_INVALID",
      "The new start time must be on an exact hour.",
    );
  }
  return startTime;
}

function parseOptionalDeadline(value: unknown): string | null {
  if (value === null || value === undefined || text(value) === "") return null;
  const deadline = new Date(text(value));
  if (!Number.isFinite(deadline.getTime())) {
    throw new RequestError(
      400,
      "RESCHEDULE_DEADLINE_INVALID",
      "Choose a valid additional-payment deadline.",
    );
  }
  return deadline.toISOString();
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

function parseReasonCode(value: unknown): string {
  const reason = text(value).toLowerCase();
  if (
    !REASON_VALUES.has(
      reason as typeof RESCHEDULE_REASON_CODES[number]["value"],
    )
  ) {
    throw new RequestError(
      400,
      "RESCHEDULE_REASON_INVALID",
      "Choose a supported reschedule reason.",
    );
  }
  return reason;
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
  if (
    (value === null || value === undefined || text(value) === "") &&
    options.optional
  ) {
    return null;
  }
  const normalized = text(value);
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

function parseBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new RequestError(
      400,
      "RESCHEDULE_NOTIFICATION_INVALID",
      "Choose whether to notify the customer.",
    );
  }
  return value;
}

function bearerToken(value: string | null): string {
  const match = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(value ?? "");
  if (!match) {
    throw new RequestError(
      401,
      "AUTHENTICATION_REQUIRED",
      "A valid owner session is required.",
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

function hasManagerAccess(access: RescheduleActorAccess): boolean {
  return access.isSystemOwner || access.membershipRole === "owner";
}

function eventView(value: unknown): JsonObject {
  const event = objectValue(value);
  const status = text(field(event, "emailStatus", "email_status")) ||
    "not_requested";
  const sentAt = field(event, "emailSentAt", "email_sent_at") ?? null;
  const errorCode = field(event, "emailErrorCode", "email_last_error_code") ??
    null;
  const providerReference =
    field(event, "emailProviderReference", "email_provider_reference") ?? null;
  const attemptCount = Number(
    field(event, "emailAttemptCount", "email_attempt_count") ?? 0,
  );
  return {
    id: field(event, "id", "id"),
    reasonCode: field(event, "reasonCode", "reason_code"),
    publicReason: field(event, "publicReason", "public_reason"),
    internalNote: field(event, "internalNote", "internal_note") ?? null,
    notifyCustomer: field(event, "notifyCustomer", "notify_customer") === true,
    oldStartsAt: field(event, "oldStartsAt", "old_starts_at"),
    oldEndsAt: field(event, "oldEndsAt", "old_ends_at"),
    newStartsAt: field(event, "newStartsAt", "new_starts_at"),
    newEndsAt: field(event, "newEndsAt", "new_ends_at"),
    rescheduledAt: field(event, "rescheduledAt", "created_at"),
    rescheduledBy: field(event, "rescheduledBy", "rescheduled_by"),
    emailStatus: status,
    emailSentAt: sentAt,
    emailErrorCode: errorCode,
    email: {
      status,
      sentAt,
      errorCode,
      providerReference,
      attemptCount: Number.isFinite(attemptCount) ? attemptCount : 0,
    },
  };
}

function emailView(value: unknown): JsonObject {
  const event = eventView(value);
  return objectValue(event.email);
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeColor(value: unknown): string {
  const color = text(value);
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#18392f";
}

function formatMoney(value: unknown, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return currency;
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency,
  }).format(amount);
}

function schedule(
  startsAt: unknown,
  endsAt: unknown,
  timezone: string,
): { date: string; time: string } {
  const start = new Date(text(startsAt));
  const end = new Date(text(endsAt));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("Reschedule email contains an invalid schedule.");
  }
  const dateFormat = new Intl.DateTimeFormat("en-PH", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeFormat = new Intl.DateTimeFormat("en-PH", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    date: dateFormat.format(start),
    time: `${timeFormat.format(start)} – ${timeFormat.format(end)}`,
  };
}

export function buildRescheduleEmail(
  payloadValue: unknown,
  referenceId: string,
): RescheduleEmailMessage {
  const payload = objectValue(payloadValue);
  const tenant = objectValue(payload.tenant);
  const booking = objectValue(payload.booking);
  const court = objectValue(payload.court);
  const event = objectValue(payload.event);
  const branding = objectValue(tenant.branding);
  const tenantName = text(tenant.name) || "Pickleball Court";
  const customerName = text(booking.customerName) || "Guest";
  const bookingReference = text(booking.reference);
  const timezone = text(tenant.timezone) || "Asia/Manila";
  const previous = schedule(
    field(event, "oldStartsAt", "old_starts_at"),
    field(event, "oldEndsAt", "old_ends_at"),
    timezone,
  );
  const updated = schedule(
    field(event, "newStartsAt", "new_starts_at"),
    field(event, "newEndsAt", "new_ends_at"),
    timezone,
  );
  const reason = text(field(event, "publicReason", "public_reason"));
  const currency = (text(booking.currency) || "PHP").toUpperCase();
  const total = formatMoney(booking.totalAmount, currency);
  const primaryColor = safeColor(
    branding.primaryColor ?? branding.primary_color,
  );
  const rows = [
    ["Booking reference", bookingReference],
    ["Court", text(court.name) || "Court"],
    ["Previous schedule", `${previous.date}, ${previous.time}`],
    ["New schedule", `${updated.date}, ${updated.time}`],
    ["Reason", reason],
    ["Amount", `${total} (unchanged)`],
  ];
  const table = rows.map(([label, value]) =>
    `<tr><td style="padding:8px 12px;color:#59635f">${htmlEscape(label)}</td>` +
    `<td style="padding:8px 12px;font-weight:600">${
      htmlEscape(value)
    }</td></tr>`
  ).join("");
  const html =
    `<!doctype html><html><body style="margin:0;background:#f4f5f2;font-family:Arial,sans-serif;color:#18201d">` +
    `<div style="max-width:620px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden">` +
    `<div style="padding:22px 28px;background:${primaryColor};color:#fff"><h1 style="margin:0;font-size:22px">Booking rescheduled</h1></div>` +
    `<div style="padding:26px 28px"><p>Hello ${htmlEscape(customerName)},</p>` +
    `<p>Your ${
      htmlEscape(tenantName)
    } court booking has been rescheduled. Your booking reference and payment record remain the same.</p>` +
    `<table style="width:100%;border-collapse:collapse;background:#f7f7f4;border-radius:10px">${table}</table>` +
    `<p style="margin-top:22px">If you have questions, reply to this email and the venue will assist you.</p></div></div></body></html>`;
  const plainText = [
    `Hello ${customerName},`,
    "",
    `Your ${tenantName} court booking has been rescheduled.`,
    `Booking reference: ${bookingReference}`,
    `Court: ${text(court.name) || "Court"}`,
    `Previous schedule: ${previous.date}, ${previous.time}`,
    `New schedule: ${updated.date}, ${updated.time}`,
    `Reason: ${reason}`,
    `Amount: ${total} (unchanged)`,
    "",
    "Your booking reference and payment record remain the same.",
  ].join("\n");
  return {
    fromName: tenantName,
    replyTo: text(tenant.replyToEmail) || text(tenant.contactEmail),
    replyToName: tenantName,
    to: text(booking.customerEmail),
    toName: customerName,
    subject: `${tenantName} booking rescheduled ${bookingReference}`,
    html,
    plainText,
    referenceId,
    tags: {
      tenant: text(tenant.slug),
      booking: bookingReference,
      kind: "booking_rescheduled",
    },
  };
}

export async function deliverEmail(options: {
  store: RescheduleBookingStore;
  sender: RescheduleEmailSender;
  tenantId: string;
  eventId: string;
  forceResend: boolean;
}): Promise<JsonObject> {
  const payload = await options.store.getEmailPayload(
    options.tenantId,
    options.eventId,
  );
  if (!payload) {
    throw new RequestError(
      404,
      "RESCHEDULE_EVENT_NOT_FOUND",
      "The reschedule event was not found.",
    );
  }
  const tenant = objectValue(payload.tenant);
  const booking = objectValue(payload.booking);
  const event = objectValue(payload.event);
  if (
    !options.forceResend &&
    field(event, "notifyCustomer", "notify_customer") !== true
  ) {
    await options.store.skipEmail(options.eventId, "not_requested");
    return { status: "not_requested" };
  }
  if (tenant.emailEnabled !== true) {
    await options.store.skipEmail(options.eventId, "disabled");
    return { status: "disabled" };
  }
  if (!text(booking.customerEmail)) {
    await options.store.skipEmail(options.eventId, "skipped_no_email");
    return { status: "skipped_no_email" };
  }

  const claim = await options.store.claimEmail(
    options.eventId,
    options.forceResend,
  );
  if (claim.shouldSend !== true) {
    return {
      status: text(claim.status) || "failed",
      deliveryId: claim.providerReference ?? null,
      existing: true,
    };
  }

  const referenceId = options.forceResend
    ? crypto.randomUUID().replaceAll("-", "").slice(0, 24)
    : options.eventId.replaceAll("-", "").slice(0, 24);
  let delivery: { referenceId: string | null };
  try {
    delivery = await options.sender.send(
      buildRescheduleEmail(payload, referenceId),
    );
  } catch (error) {
    const outcomeUnknown = error instanceof MailerooDeliveryError &&
      error.outcomeUnknown;
    const status = outcomeUnknown ? "delivery_unknown" : "failed";
    const errorCode = outcomeUnknown
      ? "MAILEROO_DELIVERY_UNKNOWN"
      : "MAILEROO_DELIVERY_FAILED";
    await options.store.finishEmail({
      eventId: options.eventId,
      status,
      providerReference: null,
      errorCode,
    });
    return { status, errorCode };
  }
  try {
    const finished = await options.store.finishEmail({
      eventId: options.eventId,
      status: "sent",
      providerReference: delivery.referenceId,
      errorCode: null,
    });
    return {
      status: "sent",
      deliveryId: finished.providerReference ?? delivery.referenceId,
      sentAt: finished.sentAt ?? null,
    };
  } catch {
    // Maileroo has accepted the message. Do not downgrade the claim to failed
    // after an ambiguous database finalization response, because that could
    // authorize a duplicate resend.
    try {
      await options.store.finishEmail({
        eventId: options.eventId,
        status: "delivery_unknown",
        providerReference: delivery.referenceId,
        errorCode: "EMAIL_FINALIZATION_UNKNOWN",
      });
    } catch {
      // The first finalization may already have committed despite its failed
      // response. A later reconciliation can inspect the provider reference.
    }
    return {
      status: "delivery_unknown",
      errorCode: "EMAIL_FINALIZATION_UNKNOWN",
      deliveryId: delivery.referenceId,
    };
  }
}

export function createRescheduleBookingHandler(
  store: RescheduleBookingStore,
  sender: RescheduleEmailSender,
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
      const requestedSlug = tenantSlugForRequest(
        body.tenantSlug,
        queryTenantSlug,
      );
      const context = await store.resolveTenant(
        requestedSlug,
        request.headers.get("origin"),
      );
      allowedOrigin = context.origin;
      const action = parseAction(body.action);
      assertOnlyKeys(
        body,
        action === "preview"
          ? PREVIEW_KEYS
          : action === "reschedule"
          ? RESCHEDULE_KEYS
          : RESEND_KEYS,
      );
      const bookingReference = parseBookingReference(body.bookingReference);
      const accessToken = bearerToken(request.headers.get("authorization"));
      const userId = await store.authenticate(accessToken);
      if (!userId) {
        throw new RequestError(
          401,
          "AUTHENTICATION_REQUIRED",
          "A valid owner session is required.",
        );
      }
      const access = await store.authorize(context.tenantId, userId);
      if (!hasManagerAccess(access)) {
        throw new RequestError(
          403,
          "TENANT_ACCESS_DENIED",
          "Only a Court Owner or System Owner may reschedule bookings.",
        );
      }

      const bookingId = await store.findBookingId(
        context.tenantId,
        bookingReference,
      );
      if (!bookingId) {
        throw new RequestError(
          404,
          "BOOKING_NOT_FOUND",
          "Booking not found.",
        );
      }

      if (action === "preview") {
        const bookingDate = parseDate(body.bookingDate, "Booking date");
        const result = await store.preview({
          accessToken,
          origin: context.origin,
          bookingId,
          bookingDate,
        });
        const booking = objectValue(result.booking);
        const options = Array.isArray(result.options) ? result.options : [];
        const notificationAvailable = result.emailEnabled === true &&
          Boolean(text(booking.customerEmail));
        return jsonResponse(
          {
            ok: true,
            booking,
            options,
            policies: {
              sameCourtOnly: true,
              sameDurationOnly: true,
              amountPolicy: "preserve_original",
              reasonCodes: RESCHEDULE_REASON_CODES,
              notificationDefault: true,
              notificationAvailable,
            },
          },
          200,
          context.origin,
        );
      }

      if (action === "reschedule") {
        const result = await store.reschedule({
          accessToken,
          origin: context.origin,
          tenantId: context.tenantId,
          bookingId,
          newDate: parseDate(body.newDate, "New date"),
          newStartTime: parseStartTime(body.newStartTime),
          reasonCode: parseReasonCode(body.reasonCode),
          publicReason: parseBoundedText(body.publicReason, {
            code: "RESCHEDULE_REASON_INVALID",
            label: "Customer-visible reason",
            minimum: 3,
            maximum: 500,
          }) as string,
          internalNote: parseBoundedText(body.internalNote, {
            code: "RESCHEDULE_NOTE_INVALID",
            label: "Internal note",
            minimum: 3,
            maximum: 1000,
            optional: true,
          }),
          notifyCustomer: parseBoolean(body.notifyCustomer),
          idempotencyKey: parseUuid(
            body.idempotencyKey,
            "IDEMPOTENCY_KEY_INVALID",
            "A valid reschedule idempotency key is required.",
          ),
          deadlineAt: parseOptionalDeadline(body.deadlineAt),
        });
        const booking = objectValue(result.booking);
        if (result.paymentRequired === true) {
          return jsonResponse(
            {
              ok: true,
              booking,
              paymentRequired: true,
              balanceNoticeRequired: result.balanceNoticeRequired === true,
              balanceRequest: objectValue(result.balanceRequest),
              price: objectValue(result.price),
              idempotent: result.idempotent === true,
              supersededBalanceRequest: result.supersededBalanceRequest
                ? objectValue(result.supersededBalanceRequest)
                : null,
            },
            200,
            context.origin,
          );
        }
        const committedEvent = eventView(result.event);
        const eventId = text(committedEvent.id);
        if (!eventId) {
          throw new Error("Reschedule result did not include an event.");
        }
        let email: JsonObject;
        try {
          email = await deliverEmail({
            store,
            sender,
            tenantId: context.tenantId,
            eventId,
            forceResend: false,
          });
        } catch {
          email = {
            status: "failed",
            errorCode: "RESCHEDULE_EMAIL_UNAVAILABLE",
          };
          try {
            await store.finishEmail({
              eventId,
              status: "failed",
              providerReference: null,
              errorCode: "RESCHEDULE_EMAIL_UNAVAILABLE",
            });
          } catch {
            // The schedule is already committed. A pending or stale delivery
            // remains visible for an explicit resend instead of masking the
            // successful reschedule with an HTTP failure.
          }
        }
        let refreshed: JsonObject | null = null;
        try {
          refreshed = await store.getEvent(
            context.tenantId,
            bookingReference,
            eventId,
          );
        } catch {
          // Return the immutable commit result even if the post-commit refresh
          // is temporarily unavailable.
        }
        return jsonResponse(
          {
            ok: true,
            booking,
            event: refreshed ? eventView(refreshed) : committedEvent,
            email,
            balanceNoticeRequired: false,
            supersededBalanceRequest: result.supersededBalanceRequest
              ? objectValue(result.supersededBalanceRequest)
              : null,
          },
          200,
          context.origin,
        );
      }

      const eventId = parseUuid(
        body.eventId,
        "RESCHEDULE_EVENT_INVALID",
        "A valid reschedule event is required.",
      );
      const event = await store.getEvent(
        context.tenantId,
        bookingReference,
        eventId,
      );
      if (!event) {
        throw new RequestError(
          404,
          "RESCHEDULE_EVENT_NOT_FOUND",
          "The reschedule event was not found.",
        );
      }
      const email = await deliverEmail({
        store,
        sender,
        tenantId: context.tenantId,
        eventId,
        forceResend: true,
      });
      const refreshed = await store.getEvent(
        context.tenantId,
        bookingReference,
        eventId,
      );
      return jsonResponse(
        {
          ok: true,
          event: eventView(refreshed ?? event),
          email,
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
      console.error("Unhandled reschedule-booking error", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return errorResponse(
        500,
        "RESCHEDULE_UNAVAILABLE",
        "The booking could not be rescheduled right now.",
        allowedOrigin,
      );
    }
  };
}

export { emailView, eventView };
