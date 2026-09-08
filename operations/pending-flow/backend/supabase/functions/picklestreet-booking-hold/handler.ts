import {
  bookingAccessTokenHash,
  deriveBookingAccessToken,
  parseBookingAccessToken,
} from "../_shared/booking-access.ts";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  parseRequestOrigin,
  readJsonObject,
  RequestError,
} from "../_shared/http.ts";
import {
  assertEventBookingEnabled,
  calculateBookingQuote,
  createBookingMetadata,
} from "../_shared/picklestreet-hold/booking.ts";
import { enforceBookingHorizon } from "../_shared/picklestreet-hold/booking-horizon.ts";
import { requireCurrentRefundPolicyAcceptance } from "../_shared/picklestreet-hold/refund-policy.ts";
import { buildZonedBookingRange } from "../_shared/picklestreet-hold/zoned-time.ts";
import { isIP } from "node:net";

export const TENANT_ID = "f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a";
export const TENANT_SLUG = "pickle-street-tugbok";
export type Obj = Record<string, any>;
export type Selection = {
  courtId: string;
  bookingDate: string;
  startTime: string;
  durationHours: number;
  bookingType: "regular" | "event";
};
export type Access = {
  p_hostname: string;
  p_booking_reference: string;
  p_access_token_hash: string;
};
export interface HoldStore {
  resolve(
    slug: string,
    origin: string,
  ): Promise<
    { tenantId: string; tenantSlug: string; hostname: string; origin: string }
  >;
  existing(
    clientRequestId: string,
    tokenHash: string,
    hostname: string,
  ): Promise<{ booking: Obj; selection: unknown } | null>;
  configuration(
    courtId: string,
  ): Promise<
    {
      tenant: Obj;
      court: Obj;
      billing: Obj;
      equipment: Obj | null;
      ready: boolean;
    }
  >;
  policy(): Promise<{ value: unknown; is_public: boolean } | null>;
  create(args: Obj): Promise<Obj>;
  status(args: Access): Promise<Obj>;
  cancel(args: Access): Promise<Obj>;
  complete(args: Access & Obj): Promise<Obj>;
}
export type Dependencies = {
  store: HoldStore;
  bookingSecret: string;
  now?: () => Date;
};
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
function fail(code: string, message: string, status = 400): never {
  throw new RequestError(status, code, message);
}
const uuid = (v: unknown, v4 = false) => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (
    !(v4
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      .test(s)
  ) fail("REQUEST_INVALID", "Refresh the booking page and try again.");
  return s;
};
function text(v: unknown, label: string, min: number, max: number): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) {
    fail("BOOKING_INPUT_INVALID", `${label} is invalid.`);
  }
  return s;
}
function allowed(body: Obj, keys: string[]) {
  if (Object.keys(body).some((k) => !keys.includes(k))) {
    fail(
      "CLIENT_CONTROLLED_FIELD",
      "This request contains unsupported booking fields.",
    );
  }
}
function reference(v: unknown): string {
  const s = text(v, "Booking reference", 6, 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(s)) {
    fail("BOOKING_REFERENCE_INVALID", "The booking reference is invalid.");
  }
  return s;
}
export function parseSelection(body: Obj): Selection {
  const courtId = uuid(body.courtId),
    bookingDate = text(body.bookingDate, "Booking date", 10, 10),
    startTime = text(body.startTime, "Start time", 5, 5);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bookingDate),
    date = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (
    !m || !date || date.getUTCFullYear() !== +m[1] ||
    date.getUTCMonth() !== +m[2] - 1 || date.getUTCDate() !== +m[3]
  ) fail("BOOKING_INPUT_INVALID", "Choose a valid booking date.");
  if (
    !/^(?:[01]\d|2[0-3]):00$/.test(startTime) ||
    !Number.isInteger(body.durationHours) || body.durationHours < 1 ||
    body.durationHours > 18
  ) fail("BOOKING_INPUT_INVALID", "Choose valid consecutive court hours.");
  if (!["regular", "event"].includes(body.bookingType)) {
    fail("BOOKING_INPUT_INVALID", "Choose a valid booking type.");
  }
  return {
    courtId,
    bookingDate,
    startTime,
    durationHours: body.durationHours,
    bookingType: body.bookingType,
  };
}
export function parseCompletion(body: Obj): Obj {
  const customer = obj(body.customer);
  allowed(customer, ["name", "email", "phone"]);
  const name = text(customer.name, "Customer name", 2, 100),
    email = text(customer.email, "Customer email", 5, 254).toLowerCase(),
    phone = text(customer.phone, "Customer phone", 7, 30);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    fail("BOOKING_INPUT_INVALID", "Enter a valid email address.");
  }
  if (!/^[+0-9][0-9 ()+.-]{6,29}$/.test(phone)) {
    fail("BOOKING_INPUT_INVALID", "Enter a valid contact number.");
  }
  const guestCount = body.guestCount ?? 1;
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 500) {
    fail("BOOKING_INPUT_INVALID", "Guest count is invalid.");
  }
  if (body.policyAccepted !== true) {
    fail(
      "POLICY_ACCEPTANCE_REQUIRED",
      "Review and accept the current Refund & Reschedule Policy.",
    );
  }
  const version = typeof body.policyVersion === "string"
    ? body.policyVersion
    : "";
  if (!version || version !== version.trim() || version.length > 120) {
    fail(
      "POLICY_ACCEPTANCE_REQUIRED",
      "Review and accept the current Refund & Reschedule Policy.",
    );
  }
  return {
    name,
    email,
    phone,
    guestCount,
    policyVersion: version,
    eventType: body.eventType == null || body.eventType === ""
      ? null
      : text(body.eventType, "Event type", 1, 100),
    eventSetupNotes: body.eventSetupNotes == null || body.eventSetupNotes === ""
      ? null
      : text(body.eventSetupNotes, "Event notes", 1, 1000),
  };
}
export function clientAddress(request: Request): string {
  const raw = (request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0] || "").trim();
  if (!isIP(raw)) {
    fail(
      "REQUEST_NETWORK_UNAVAILABLE",
      "The booking security check could not read this connection. Please try again.",
      503,
    );
  }
  return raw;
}
function amount(v: unknown): number {
  if (v === null || v === undefined || v === "") {
    throw Error("Stored amount missing");
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw Error("Stored amount invalid");
  return n;
}
export function bookingResponse(data: Obj, token?: string): Obj {
  const b = obj(data);
  const ref = reference(b.reference);
  for (const field of ["expiresAt", "accessExpiresAt", "startsAt", "endsAt"]) {
    if (
      typeof b[field] !== "string" || !Number.isFinite(Date.parse(b[field]))
    ) throw Error("Stored booking date invalid");
  }
  if (typeof b.detailsCompleted !== "boolean") {
    throw Error("Stored booking completion state missing");
  }
  return {
    bookingId: b.bookingId,
    reference: ref,
    courtId: b.courtId,
    courtName: b.courtName,
    bookingType: b.bookingType,
    status: b.status,
    paymentStatus: b.paymentStatus,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    expiresAt: b.expiresAt,
    accessExpiresAt: b.accessExpiresAt,
    subtotalAmount: amount(b.subtotalAmount),
    courtSubtotalAmount: amount(b.courtSubtotalAmount),
    equipmentRentalFeeAmount: amount(b.equipmentRentalFeeAmount),
    equipmentRental: {
      extraPaddles: amount(obj(b.equipmentRental).extraPaddles),
      balls: amount(obj(b.equipmentRental).balls),
    },
    serviceFeeAmount: amount(b.serviceFeeAmount),
    totalAmount: amount(b.totalAmount),
    currency: b.currency,
    fullPaymentOnly: b.fullPaymentOnly === true,
    detailsCompleted: b.detailsCompleted,
    provisional: b.detailsCompleted !== true,
    customerName: b.customerName ?? null,
    customerEmail: b.customerEmail ?? null,
    customerPhone: b.customerPhone ?? null,
    customer: b.detailsCompleted
      ? {
        name: b.customerName ?? null,
        email: b.customerEmail ?? null,
        phone: b.customerPhone ?? null,
      }
      : null,
    guestCount: b.guestCount,
    eventType: b.eventType ?? null,
    eventSetupNotes: b.eventSetupNotes ?? null,
    bookingDate: b.bookingDate,
    startTime: b.startTime,
    durationHours: b.durationHours,
    tenantTimezone: b.tenantTimezone,
    slots: Array.isArray(b.slots) ? b.slots : [],
    sessions: Array.isArray(b.sessions) ? b.sessions : [],
    ...(!b.detailsCompleted ? { canSubmitReceipt: false } : {}),
    ...(typeof b.reservationHeld === "boolean"
      ? { reservationHeld: b.reservationHeld }
      : {}),
    ...(token ? { bookingToken: token } : {}),
  };
}

export function parseGroupSelections(raw:unknown):Selection[] {
 if(!Array.isArray(raw)||raw.length<1||raw.length>18)fail('SELECTION_INVALID','Select up to 18 court-hours.');
 const selections=raw.map(item=>{const value=obj(item);allowed(value,['courtId','bookingDate','startTime','durationHours','bookingType']);return parseSelection(value)}).sort((a,b)=>a.courtId.localeCompare(b.courtId)||a.startTime.localeCompare(b.startTime));
 if(selections.some(s=>s.bookingType!=='regular'||s.bookingDate!==selections[0].bookingDate)||selections.reduce((sum,s)=>sum+s.durationHours,0)>18)fail('SELECTION_INVALID','Choose regular court hours on one date, up to 18 court-hours.');
 for(let i=1;i<selections.length;i++){const a=selections[i-1],b=selections[i];if(a.courtId===b.courtId && Number(a.startTime.slice(0,2))+a.durationHours>Number(b.startTime.slice(0,2)))fail('SELECTION_INVALID','The same court hour cannot be selected twice.');}
 return selections;
}

export function createHoldHandler(deps: Dependencies) {
  return async function handleRequest(request: Request): Promise<Response> {
    let origin: string | undefined;
    let action = "";
    try {
      if (!["POST", "OPTIONS"].includes(request.method)) {
        return errorResponse(
          405,
          "METHOD_NOT_ALLOWED",
          "Only POST requests are accepted.",
        );
      }
      if (request.headers.has("x-internal-secret")) {
        fail(
          "INTERNAL_ACCESS_DENIED",
          "Internal credentials are not accepted here.",
          403,
        );
      }
      const url = new URL(request.url),
        urlSlug = url.searchParams.get("tenantSlug") ??
          request.headers.get("x-tenant-slug");
      if (urlSlug !== TENANT_SLUG) {
        fail(
          "TENANT_ACCESS_DENIED",
          "This booking service is unavailable for that venue.",
          403,
        );
      }
      const parsed = parseRequestOrigin(request.headers.get("origin"));
      const context = await deps.store.resolve(TENANT_SLUG, parsed.origin);
      if (
        context.tenantId !== TENANT_ID || context.tenantSlug !== TENANT_SLUG ||
        context.origin !== parsed.origin
      ) {
        fail(
          "TENANT_ACCESS_DENIED",
          "This booking service is unavailable for that venue.",
          403,
        );
      }
      origin = context.origin;
      if (request.method === "OPTIONS") return noContentResponse(origin);
      const body = await readJsonObject(request);
      if (body.tenantSlug !== TENANT_SLUG) {
        fail(
          "TENANT_ACCESS_DENIED",
          "The booking venue does not match this request.",
          403,
        );
      }
      action = typeof body.action === "string" ? body.action : "";
      if (action === "create") {
        allowed(body, [
          "tenantSlug",
          "action",
          "courtId",
          "sessions",
          "bookingDate",
          "startTime",
          "durationHours",
          "bookingType",
          "clientRequestId",
          "turnstileToken", // Accepted but ignored for previously loaded clients.
        ]);
        const selections = body.sessions === undefined ? [parseSelection(body)] : parseGroupSelections(body.sessions);
        const selection = selections[0],
          clientRequestId = uuid(body.clientRequestId, true),
          ip = clientAddress(request);
        const token = await deriveBookingAccessToken({
            secret: deps.bookingSecret,
            tenantId: TENANT_ID,
            clientRequestId: `picklestreet-provisional:v1:${clientRequestId}`,
          }),
          tokenHash = await bookingAccessTokenHash(token);
        // A tenant-scoped retry uses its capability and stored selection,
        // quote and deadline, even when live prices or lead-time rules changed.
        const existing = await deps.store.existing(
          clientRequestId,
          tokenHash,
          context.hostname,
        );
        if (existing) {
          if (
            JSON.stringify(existing.selection) !== JSON.stringify(body.sessions === undefined ? selection : selections)
          ) {
            fail(
              "REQUEST_SELECTION_CHANGED",
              "This request already holds different court hours. Resume that reservation or start a new selection.",
              409,
            );
          }
          return jsonResponse(
            { ok: true, booking: bookingResponse(existing.booking, token) },
            200,
            origin,
          );
        }
        const pricedSessions: Obj[] = [];
        for (const selection of selections) {
        const { tenant, court, billing, equipment, ready } = await deps.store
          .configuration(selection.courtId);
        if (!ready) {
          fail(
            "BOOKING_NOT_CONFIGURED",
            "Online booking is not configured for this venue yet.",
            503,
          );
        }
        assertEventBookingEnabled(
          selection.bookingType,
          tenant.public_config,
          court.pricing_config,
        );
        const priced = {
          ...selection,
          clientRequestId,
          guestCount: 1,
          equipmentRental: { extraPaddles: 0, balls: 0 },
          notes: null,
        };
        const quote = calculateBookingQuote({
          request: priced,
          pricingConfig: court.pricing_config,
          platformBillingConfig: {
            feeMode: billing.fee_mode,
            feeAmount: Number(billing.fee_amount),
          },
          equipmentRentalConfig: equipment
            ? {
              enabled: equipment.enabled,
              extraPaddleRate: Number(equipment.extra_paddle_rate),
              ballRate: Number(equipment.ball_rate),
            }
            : undefined,
          currency: court.currency,
          openTime: court.opens_at,
          closeTime: court.closes_at,
        });
        let range;
        try {
          range = buildZonedBookingRange({
            ...selection,
            timeZone: tenant.timezone,
          });
        } catch {
          fail(
            "BOOKING_TIME_INVALID",
            "The selected court time is invalid.",
            422,
          );
        }
        enforceBookingHorizon({
          startsAt: range.startsAt,
          timeZone: tenant.timezone,
          publicConfig: court.public_config,
          now: (deps.now?.() ?? new Date()).toISOString(),
        });
        pricedSessions.push({courtId:selection.courtId,bookingDate:selection.bookingDate,startTime:selection.startTime,durationHours:selection.durationHours,startsAt:range.startsAt,endsAt:range.endsAt,slots:range.slots,subtotalAmount:quote.courtSubtotalAmount,serviceFeeAmount:quote.serviceFeeAmount,totalAmount:Math.round((quote.courtSubtotalAmount+quote.serviceFeeAmount+Number.EPSILON)*100)/100,currency:quote.currency,metadata:createBookingMetadata(priced,quote)});
        }
        const clientIpHash = await bookingAccessTokenHash(
          await deriveBookingAccessToken({
            secret: deps.bookingSecret,
            tenantId: TENANT_ID,
            clientRequestId: `picklestreet-hold-ip:v1:${ip}`,
          }),
        );
        const shared={p_hostname:context.hostname,p_client_request_id:clientRequestId,p_access_token_hash:tokenHash,p_client_ip_hash:clientIpHash};
        const first=pricedSessions[0];
        const result=await deps.store.create(body.sessions!==undefined ? {...shared,p_sessions:pricedSessions} : {...shared,p_court_id:selection.courtId,p_booking_type:selection.bookingType,p_starts_at:first.startsAt,p_ends_at:first.endsAt,p_slots:first.slots,p_subtotal_amount:first.subtotalAmount,p_service_fee_amount:first.serviceFeeAmount,p_total_amount:first.totalAmount,p_currency:first.currency,p_metadata:first.metadata});
        return jsonResponse(
          { ok: true, booking: bookingResponse(result, token) },
          201,
          origin,
        );
      }
      if (!["status", "cancel", "complete"].includes(action)) {
        fail("ACTION_INVALID", "This booking action is unavailable.");
      }
      allowed(body, [
        "tenantSlug",
        "action",
        "bookingReference",
        "bookingToken",
        ...(action === "complete"
          ? [
            "customer",
            "guestCount",
            "eventType",
            "eventSetupNotes",
            "policyAccepted",
            "policyVersion",
          ]
          : []),
      ]);
      const token = parseBookingAccessToken(body.bookingToken),
        access = {
          p_hostname: context.hostname,
          p_booking_reference: reference(body.bookingReference),
          p_access_token_hash: await bookingAccessTokenHash(token),
        };
      if (action === "status") {
        return jsonResponse(
          {
            ok: true,
            booking: bookingResponse(await deps.store.status(access)),
          },
          200,
          origin,
        );
      }
      if (action === "cancel") {
        const cancelled = await deps.store.cancel(access);
        return jsonResponse(
          {
            ok: true,
            cancellation: {
              bookingId: cancelled.bookingId,
              reference: reference(cancelled.reference),
              status: cancelled.status,
              cancelled: cancelled.cancelled === true,
              idempotent: cancelled.idempotent === true,
            },
          },
          200,
          origin,
        );
      }
      // Authenticate before reading policy or validating a completion. SQL repeats
      // capability/expiry/current-policy checks under its transaction lock.
      await deps.store.status(access);
      const completion = parseCompletion(body),
        setting = await deps.store.policy();
      if (!setting) {
        fail(
          "BOOKING_POLICY_NOT_CONFIGURED",
          "The venue has not published its approved policy.",
          503,
        );
      }
      const acceptance = await requireCurrentRefundPolicyAcceptance(setting, {
        accepted: true,
        version: completion.policyVersion,
      });
      if (!acceptance) {
        fail(
          "BOOKING_POLICY_NOT_CONFIGURED",
          "The approved venue policy is unavailable.",
          503,
        );
      }
      const completed = await deps.store.complete({
        ...access,
        p_customer_name: completion.name,
        p_customer_email: completion.email,
        p_customer_phone: completion.phone,
        p_guest_count: completion.guestCount,
        p_event_type: completion.eventType,
        p_event_setup_notes: completion.eventSetupNotes,
        p_policy_accepted: true,
        p_policy_version: acceptance.version,
        p_policy_sha256: acceptance.sha256,
      });
      return jsonResponse(
        { ok: true, booking: bookingResponse(completed, token) },
        200,
        origin,
      );
    } catch (error) {
      if (error instanceof RequestError) {
        return errorResponse(error.status, error.code, error.message, origin);
      }
      return errorResponse(
        503,
        "BOOKING_SERVICE_UNAVAILABLE",
        action === "create"
          ? "The reservation reply was interrupted. Retry the same selection; its request ID prevents a second hold."
          : "The booking reply was interrupted. Check its status before retrying; the original deadline is unchanged.",
        origin,
      );
    }
  };
}
