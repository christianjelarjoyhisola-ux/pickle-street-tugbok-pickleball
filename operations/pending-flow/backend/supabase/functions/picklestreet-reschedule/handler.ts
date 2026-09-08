import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  readJsonObject,
  RequestError,
} from "../_shared/http.ts";
import {
  type JsonObject,
  RESCHEDULE_REASON_CODES,
  type RescheduleEmailSender,
} from "../_shared/reschedule-booking.ts";
import { type TenantRequestContext } from "../_shared/tenant.ts";

export const TENANT_ID = "f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a";
export const TENANT_SLUG = "pickle-street-tugbok";
export const objectValue = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
export const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
export type GroupChange = {
  sessionId: string;
  newDate: string;
  newStartTime: string;
};
export interface GroupStore {
  resolveTenant(
    slug: unknown,
    origin: string | null,
  ): Promise<TenantRequestContext>;
  authenticate(token: string): Promise<string | null>;
  authorize(tenantId: string, userId: string): Promise<boolean>;
  findBookingId(reference: string): Promise<string | null>;
  context(
    bookingId: string,
    actor: string,
    origin: string,
  ): Promise<JsonObject>;
  options(
    bookingId: string,
    actor: string,
    sessionId: string,
    date: string,
    version: string,
  ): Promise<JsonObject>;
  preview(
    bookingId: string,
    actor: string,
    changes: GroupChange[],
    reason: string,
    version: string,
  ): Promise<JsonObject>;
  reschedule(
    input: {
      bookingId: string;
      actor: string;
      changes: GroupChange[];
      reason: string;
      version: string;
      quoteHash: string;
      publicReason: string;
      internalNote: string | null;
      notifyCustomer: boolean;
      idempotencyKey: string;
      origin: string;
    },
  ): Promise<JsonObject>;
  deliver(
    eventId: string,
    bookingId: string,
    forceResend: boolean,
    sender: RescheduleEmailSender,
  ): Promise<JsonObject>;
}

const common = ["action", "tenantSlug", "bookingReference"];
const keys: Record<string, Set<string>> = {
  context: new Set(common),
  options: new Set([...common, "sessionId", "bookingDate", "expectedVersion"]),
  preview: new Set([...common, "changes", "reasonCode", "expectedVersion"]),
  reschedule: new Set([
    ...common,
    "changes",
    "reasonCode",
    "expectedVersion",
    "expectedQuoteHash",
    "publicReason",
    "internalNote",
    "notifyCustomer",
    "idempotencyKey",
  ]),
  resend: new Set([...common, "eventId"]),
};
function invalid(message: string): never {
  throw new RequestError(400, "RESCHEDULE_FIELDS_INVALID", message);
}
function date(value: unknown): string {
  const s = text(value);
  if (
    !/^20\d{2}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s + "T00:00:00Z")) ||
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s
  ) invalid("Choose a valid booking date.");
  return s;
}
function version(value: unknown): string {
  const s = text(value);
  if (!s || s.length > 256) invalid("Reload the booking before rescheduling.");
  return s;
}
function uuid(value: unknown): string {
  const s = text(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(s)
  ) invalid("A valid request identifier is required.");
  return s;
}
function sessionId(value: unknown): string {
  const s = text(value);
  if (!s || s.length > 200 || /[\x00-\x1f]/.test(s)) {
    invalid("Select a valid booking session.");
  }
  return s;
}
function bounded(
  value: unknown,
  label: string,
  max: number,
  optional = false,
): string | null {
  const s = text(value);
  if (!s && optional) return null;
  if (s.length < 3 || s.length > max) {
    invalid(`${label} must contain 3 to ${max} characters.`);
  }
  return s;
}
export function parseChanges(value: unknown): GroupChange[] {
  if (!Array.isArray(value) || !value.length || value.length > 18) {
    invalid("Choose 1 to 18 sessions to reschedule.");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const row = objectValue(item);
    if (
      Object.keys(row).some((k) =>
        !["sessionId", "newDate", "newStartTime"].includes(k)
      )
    ) invalid("A session contains an unsupported change.");
    const id = sessionId(row.sessionId);
    if (seen.has(id)) invalid("Each session may only be rescheduled once.");
    seen.add(id);
    const time = text(row.newStartTime);
    if (!/^(?:[01]\d|2[0-3]):00$/.test(time)) {
      invalid("Choose a start time on the hour.");
    }
    return { sessionId: id, newDate: date(row.newDate), newStartTime: time };
  });
}

export function createGroupRescheduleHandler(
  store: GroupStore,
  sender: RescheduleEmailSender,
) {
  return async (request: Request): Promise<Response> => {
    let origin: string | undefined;
    try {
      if (!["POST", "OPTIONS"].includes(request.method)) {
        return errorResponse(405, "METHOD_NOT_ALLOWED", "Use POST.");
      }
      const querySlug = new URL(request.url).searchParams.get("tenantSlug") ??
        request.headers.get("x-tenant-slug");
      const body = request.method === "OPTIONS"
        ? {}
        : await readJsonObject(request, 24_576);
      const slug = body.tenantSlug ?? querySlug;
      if (slug !== TENANT_SLUG || (querySlug && querySlug !== TENANT_SLUG)) {
        throw new RequestError(
          403,
          "TENANT_ACCESS_DENIED",
          "This service is only available for Pickle Street.",
        );
      }
      const context = await store.resolveTenant(
        slug,
        request.headers.get("origin"),
      );
      if (
        context.tenantId !== TENANT_ID || context.tenantSlug !== TENANT_SLUG
      ) {
        throw new RequestError(
          403,
          "TENANT_ACCESS_DENIED",
          "This venue is not supported.",
        );
      }
      origin = context.origin;
      if (request.method === "OPTIONS") return noContentResponse(origin);
      const action = text(body.action);
      if (
        !keys[action] || Object.keys(body).some((k) => !keys[action].has(k))
      ) invalid("The reschedule request contains unsupported fields.");
      const ref = text(body.bookingReference).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(ref)) {
        invalid("Enter a valid booking reference.");
      }
      const token = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      const actor = token ? await store.authenticate(token) : null;
      if (!actor) {
        throw new RequestError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Sign in to reschedule this booking.",
        );
      }
      if (!await store.authorize(TENANT_ID, actor)) {
        throw new RequestError(
          403,
          "TENANT_ACCESS_DENIED",
          "Only a venue owner or admin can reschedule bookings.",
        );
      }
      const bookingId = await store.findBookingId(ref);
      if (!bookingId) {
        throw new RequestError(404, "BOOKING_NOT_FOUND", "Booking not found.");
      }
      if (action === "context") {
        const result = await store.context(bookingId, actor, origin);
        return jsonResponse(
          {
            ...result,
            ok: true,
            policies: {
              sameCourtOnly: true,
              sameDurationOnly: true,
              paymentWindowMinutes: 15,
              notificationDefault: true,
              reasonCodes: RESCHEDULE_REASON_CODES,
              ...objectValue(result.policies),
            },
          },
          200,
          origin,
        );
      }
      if (action === "options") {
        return jsonResponse(
          {
            ...await store.options(
              bookingId,
              actor,
              sessionId(body.sessionId),
              date(body.bookingDate),
              version(body.expectedVersion),
            ),
            ok: true,
          },
          200,
          origin,
        );
      }
      if (action === "resend") {
        return jsonResponse(
          {
            ok: true,
            email: await store.deliver(
              uuid(body.eventId),
              bookingId,
              true,
              sender,
            ),
          },
          200,
          origin,
        );
      }
      const changes = parseChanges(body.changes);
      const reason = text(body.reasonCode);
      if (!RESCHEDULE_REASON_CODES.some((r) => r.value === reason)) {
        invalid("Choose a reschedule reason.");
      }
      const expectedVersion = version(body.expectedVersion);
      if (action === "preview") {
        return jsonResponse(
          {
            ...await store.preview(
              bookingId,
              actor,
              changes,
              reason,
              expectedVersion,
            ),
            ok: true,
          },
          200,
          origin,
        );
      }
      if (typeof body.notifyCustomer !== "boolean") {
        invalid("Choose whether to notify the customer.");
      }
      const result = await store.reschedule({
        bookingId,
        actor,
        changes,
        reason,
        version: expectedVersion,
        quoteHash: version(body.expectedQuoteHash),
        publicReason: bounded(
          body.publicReason,
          "Customer-visible reason",
          500,
        )!,
        internalNote: bounded(body.internalNote, "Internal note", 1000, true),
        notifyCustomer: body.notifyCustomer as boolean,
        idempotencyKey: uuid(body.idempotencyKey),
        origin,
      });
      if (result.paymentRequired === true) {
        return jsonResponse(
          { ...result, ok: true, balanceNoticeRequired: false },
          200,
          origin,
        );
      }
      const event = objectValue(result.event);
      const eventId = text(event.id ?? result.rescheduleEventId);
      // A committed schedule remains successful even if notification is temporarily unavailable.
      let email: JsonObject = { status: "pending" };
      if (eventId) {
        try {
          email = await store.deliver(eventId, bookingId, false, sender);
        } catch {
          email = {
            status: "pending",
            errorCode: "RESCHEDULE_EMAIL_UNAVAILABLE",
          };
        }
      }
      return jsonResponse({ ...result, ok: true, email }, 200, origin);
    } catch (error) {
      if (error instanceof RequestError) {
        return errorResponse(error.status, error.code, error.message, origin);
      }
      console.error("Pickle Street group reschedule unavailable", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return errorResponse(
        503,
        "RESCHEDULE_UNAVAILABLE",
        "The booking could not be updated. Refresh its details before trying again.",
        origin,
      );
    }
  };
}
