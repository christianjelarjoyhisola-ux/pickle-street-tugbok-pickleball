import { createClient } from "@supabase/supabase-js";
import {
  isPaidConfirmedBooking,
  parseBookingConfirmationEmailKind,
} from "../_shared/booking-email.ts";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  readJsonObject,
  RequestError,
} from "../_shared/http.ts";
import {
  MailerooDeliveryError,
  sendMailerooEmail,
} from "../_shared/maileroo.ts";
import { requireHighEntropySecret, secretsMatch } from "../_shared/security.ts";
import {
  normalizeTenantSlug,
  resolveTenantForRequest,
} from "../_shared/tenant.ts";

type JsonObject = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
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

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[character] ?? character);
}

function safeBrandColor(value: unknown): string {
  const color = text(value);
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#123c5a";
}

function safePublicUrl(value: unknown): string {
  const candidate = text(value);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function formatMoney(amount: unknown, currency: string): string {
  const number = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(number) || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Booking amount or currency is invalid.");
  }
  return new Intl.NumberFormat("en-PH", { style: "currency", currency }).format(
    number,
  );
}

function formatSchedule(startsAt: string, endsAt: string, timeZone: string) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const date = new Intl.DateTimeFormat("en-PH", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(start);
  const timeFormatter = new Intl.DateTimeFormat("en-PH", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    date,
    time: `${timeFormatter.format(start)} - ${timeFormatter.format(end)}`,
  };
}

function createEmail(options: {
  tenantName: string;
  customerName: string;
  reference: string;
  courtName: string;
  bookingType: string;
  scheduleDate: string;
  scheduleTime: string;
  total: string;
  paymentStatus: string;
  logoUrl: string;
  primaryColor: string;
  contactPhone: string;
}) {
  const heading = "Booking confirmed";
  const logo = options.logoUrl
    ? `<img src="${escapeHtml(options.logoUrl)}" alt="${
      escapeHtml(options.tenantName)
    }" width="80" style="display:block;width:80px;height:auto;margin:0 auto 16px">`
    : "";
  const rows = [
    ["Booking reference", options.reference],
    ["Court", options.courtName],
    ["Booking type", options.bookingType],
    ["Date", options.scheduleDate],
    ["Time", options.scheduleTime],
    ["Total", options.total],
    ["Payment", options.paymentStatus],
  ].map(([label, value]) =>
    `<tr><td style="padding:8px 0;color:#607080">${
      escapeHtml(label)
    }</td><td style="padding:8px 0;text-align:right;font-weight:700">${
      escapeHtml(value)
    }</td></tr>`
  ).join("");
  const contact = options.contactPhone
    ? `<p style="margin:24px 0 0;color:#607080;font-size:14px">Questions? Contact ${
      escapeHtml(options.tenantName)
    } at ${escapeHtml(options.contactPhone)}.</p>`
    : "";
  const html =
    `<!doctype html><html><body style="margin:0;background:#f4f7f8;font-family:Arial,sans-serif;color:#10283a"><div style="max-width:600px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border-radius:18px;padding:32px;box-shadow:0 8px 30px rgba(16,40,58,.08)">${logo}<h1 style="margin:0;text-align:center;font-size:25px;color:${
      escapeHtml(options.primaryColor)
    }">${heading}</h1><p style="margin:12px 0 24px;text-align:center;color:#607080">Hi ${
      escapeHtml(options.customerName)
    }, here are your booking details for ${
      escapeHtml(options.tenantName)
    }.</p><table style="width:100%;border-collapse:collapse;border-top:1px solid #e6ecef;border-bottom:1px solid #e6ecef">${rows}</table>${contact}</div></div></body></html>`;
  const plainText = [
    `${heading} - ${options.tenantName}`,
    `Hi ${options.customerName},`,
    `Reference: ${options.reference}`,
    `Court: ${options.courtName}`,
    `Booking type: ${options.bookingType}`,
    `Date: ${options.scheduleDate}`,
    `Time: ${options.scheduleTime}`,
    `Total: ${options.total}`,
    `Payment: ${options.paymentStatus}`,
    options.contactPhone ? `Contact: ${options.contactPhone}` : "",
  ].filter(Boolean).join("\n");
  return { html, plainText };
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

    const supabaseUrl = requiredEnvironment("SUPABASE_URL");
    const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
    const db = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { "X-Client-Info": "pickleball-platform-booking-email/1.0" },
      },
    });
    const requestUrl = new URL(request.url);
    const queryTenantSlug = requestUrl.searchParams.get("tenantSlug") ??
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
    if(body.tenantSlug!=='pickle-street-tugbok')throw new RequestError(403,'TENANT_ACCESS_DENIED','This email service is only available for Pickle Street.');
    let tenantSlug: string;
    const isManualResend = request.headers.has("origin");
    if (isManualResend) {
      const context = await resolveTenantForRequest(
        db,
        body.tenantSlug ?? queryTenantSlug,
        request.headers.get("origin"),
      );
      allowedOrigin = context.origin;
      if (body.resend !== true) {
        throw new RequestError(
          403,
          "MANUAL_RESEND_REQUIRED",
          "Browser requests may only resend an existing confirmation.",
        );
      }
      const token = bearerToken(request.headers.get("authorization"));
      const userResult = await db.auth.getUser(token);
      const userId = userResult.data.user?.id ?? "";
      if (userResult.error || !userId) {
        throw new RequestError(
          401,
          "AUTHENTICATION_REQUIRED",
          "A valid owner session is required.",
        );
      }
      const [membershipResult, profileResult] = await Promise.all([
        db.from("tenant_memberships")
          .select("id")
          .eq("tenant_id", context.tenantId)
          .eq("user_id", userId)
          .eq("status", "active")
          .in("role", ["owner", "admin"])
          .maybeSingle(),
        db.from("platform_profiles")
          .select("user_id")
          .eq("user_id", userId)
          .eq("is_platform_owner", true)
          .maybeSingle(),
      ]);
      if (membershipResult.error || profileResult.error) {
        throw new RequestError(
          503,
          "EMAIL_RESEND_UNAVAILABLE",
          "The confirmation email cannot be resent right now.",
        );
      }
      if (!membershipResult.data && !profileResult.data) {
        throw new RequestError(
          403,
          "TENANT_ACCESS_DENIED",
          "Only a tenant owner or system owner may resend confirmation emails.",
        );
      }
      tenantSlug = context.tenantSlug;
    } else {
      const internalSecret = requireHighEntropySecret(
        "EDGE_INTERNAL_SECRET",
        Deno.env.get("EDGE_INTERNAL_SECRET"),
      );
      if (
        !await secretsMatch(
          request.headers.get("x-internal-secret"),
          internalSecret,
        )
      ) {
        return errorResponse(
          401,
          "UNAUTHORIZED",
          "Internal authentication failed.",
        );
      }
      tenantSlug = normalizeTenantSlug(body.tenantSlug);
    }
    const emailKind = parseBookingConfirmationEmailKind(body.emailKind);
    if (!emailKind) {
      throw new RequestError(
        400,
        "EMAIL_KIND_INVALID",
        "Only paid-booking confirmation emails are supported.",
      );
    }
    const bookingReference = text(body.bookingReference).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{5,63}$/.test(bookingReference)) {
      throw new RequestError(
        400,
        "BOOKING_REFERENCE_INVALID",
        "A valid booking reference is required.",
      );
    }

    const payloadResult = await db.rpc("get_booking_email_payload", {
      p_tenant_slug: tenantSlug,
      p_booking_reference: bookingReference,
    });
    if (payloadResult.error || !payloadResult.data) {
      throw new RequestError(
        404,
        "BOOKING_NOT_FOUND",
        "The booking was not found.",
      );
    }
    const payload = objectValue(payloadResult.data);
    const tenant = objectValue(payload.tenant);
    const booking = objectValue(payload.booking);
    const court = objectValue(payload.court);
    if (!text(tenant.id) || !text(booking.id) || !text(court.id)) {
      throw new RequestError(
        404,
        "BOOKING_NOT_FOUND",
        "The booking was not found.",
      );
    }
    if (
      ["cancelled", "expired", "void"].includes(
        text(booking.status).toLowerCase(),
      )
    ) {
      throw new RequestError(
        409,
        "BOOKING_EMAIL_NOT_ALLOWED",
        "Email is not allowed for this booking status.",
      );
    }
    if (!isPaidConfirmedBooking(booking.status, booking.paymentStatus)) {
      throw new RequestError(
        409,
        "BOOKING_EMAIL_NOT_ALLOWED",
        "A confirmation email requires a confirmed, fully paid booking.",
      );
    }

    const branding = objectValue(tenant.branding);
    const tenantName = text(tenant.name, "Pickleball Court");
    const replyTo = text(tenant.replyToEmail, text(tenant.contactEmail));
    if (!replyTo) throw new Error("Tenant Reply-To email is not configured.");
    const schedule = formatSchedule(
      text(booking.startsAt),
      text(booking.endsAt),
      text(tenant.timezone, "Asia/Manila"),
    );
    const groupResult=await db.from('bookings').select('metadata').eq('tenant_id','f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a').eq('reference',text(booking.reference)).single();
    if(groupResult.error)throw new Error('Booking schedule unavailable.');
    const groupMetadata=objectValue(groupResult.data?.metadata);
    const groupSessions=Array.isArray(groupMetadata.sessions)?groupMetadata.sessions.map(objectValue):[];
    const groupSchedule=groupSessions.map(session=>{const item=formatSchedule(text(session.startsAt),text(session.endsAt),text(tenant.timezone,'Asia/Manila'));return text(session.courtName)+' — '+item.date+' · '+item.time;}).join('; ');
    const currency = text(booking.currency, "PHP").toUpperCase();
    const email = createEmail({
      tenantName,
      customerName: text(booking.customerName, "Guest"),
      reference: text(booking.reference),
      courtName: groupSessions.length ? [...new Set(groupSessions.map(s=>text(s.courtName)))].join(', ') : text(court.name, "Court"),
      bookingType: text(booking.type, "regular"),
      scheduleDate: schedule.date,
      scheduleTime: groupSchedule || schedule.time,
      total: formatMoney(booking.totalAmount, currency),
      paymentStatus: text(booking.paymentStatus, "pending").replaceAll(
        "_",
        " ",
      ),
      logoUrl: safePublicUrl(branding.logoUrl ?? branding.logo_url),
      primaryColor: safeBrandColor(
        branding.primaryColor ?? branding.primary_color,
      ),
      contactPhone: text(tenant.contactPhone),
    });
    if (isManualResend) {
      const existingResult = await db.from("booking_email_deliveries")
        .select("id,status,sent_at")
        .eq("tenant_id", text(tenant.id))
        .eq("booking_id", text(booking.id))
        .eq("email_kind", emailKind)
        .maybeSingle();
      if (existingResult.error) {
        throw new RequestError(
          503,
          "EMAIL_RESEND_UNAVAILABLE",
          "The confirmation email cannot be resent right now.",
        );
      }
      const existing = existingResult.data;
      if (existing?.status === "delivery_unknown") {
        throw new RequestError(
          409,
          "EMAIL_DELIVERY_UNKNOWN",
          "Email delivery must be reconciled in Maileroo before retrying.",
        );
      }
      if (existing?.status === "sending") {
        throw new RequestError(
          409,
          "EMAIL_ALREADY_SENDING",
          "A confirmation email is already being sent.",
        );
      }
      const sentAt = existing?.sent_at ? Date.parse(existing.sent_at) : 0;
      if (sentAt && Date.now() - sentAt < 60_000) {
        throw new RequestError(
          429,
          "EMAIL_RESEND_RATE_LIMITED",
          "Wait one minute before resending this confirmation.",
        );
      }
      if (existing?.id) {
        const resetResult = await db.from("booking_email_deliveries")
          .update({
            status: "failed",
            last_error_code: "MANUAL_RESEND_REQUESTED",
          })
          .eq("id", existing.id);
        if (resetResult.error) {
          throw new RequestError(
            503,
            "EMAIL_RESEND_UNAVAILABLE",
            "The confirmation email cannot be resent right now.",
          );
        }
      }
    }
    const claimResult = await db.rpc("claim_booking_email_delivery", {
      p_booking_id: text(booking.id),
      p_email_kind: emailKind,
    });
    if (claimResult.error || !claimResult.data) {
      throw new Error("Booking email delivery could not be claimed.");
    }
    const claim = objectValue(claimResult.data);
    const deliveryId = text(claim.deliveryId);
    if (!deliveryId) throw new Error("Booking email claim has no identifier.");
    if (claim.shouldSend !== true) {
      if (text(claim.status) === "delivery_unknown") {
        throw new RequestError(
          409,
          "EMAIL_DELIVERY_UNKNOWN",
          "Email delivery must be reconciled in Maileroo before retrying.",
        );
      }
      return jsonResponse(
        {
          ok: true,
          existing: true,
          bookingReference,
          emailKind,
          deliveryId: text(claim.providerReference) || null,
        },
        200,
        allowedOrigin,
      );
    }
    let delivery: Awaited<ReturnType<typeof sendMailerooEmail>>;
    try {
      delivery = await sendMailerooEmail({
        apiKey: requiredEnvironment("MAILEROO_API_KEY"),
        fromAddress: requiredEnvironment("MAILEROO_FROM_EMAIL"),
        fromName: tenantName,
        replyTo,
        replyToName: tenantName,
        to: text(booking.customerEmail),
        toName: text(booking.customerName),
        subject: `${tenantName} booking confirmed ${bookingReference}`,
        html: email.html,
        plainText: email.plainText,
        referenceId: (isManualResend ? crypto.randomUUID() : deliveryId)
          .replaceAll("-", "").slice(0, 24),
        tags: {
          tenant: tenantSlug,
          booking: bookingReference,
          kind: emailKind,
        },
      });
    } catch (error) {
      const outcomeUnknown = error instanceof MailerooDeliveryError &&
        error.outcomeUnknown;
      await db.rpc("finish_booking_email_delivery", {
        p_delivery_id: deliveryId,
        p_status: outcomeUnknown ? "delivery_unknown" : "failed",
        p_provider_reference: null,
        p_error_code: outcomeUnknown
          ? "MAILEROO_DELIVERY_UNKNOWN"
          : "MAILEROO_DELIVERY_FAILED",
      });
      throw error;
    }
    const finished = await db.rpc("finish_booking_email_delivery", {
      p_delivery_id: deliveryId,
      p_status: "sent",
      p_provider_reference: delivery.referenceId,
      p_error_code: null,
    });
    if (finished.error) {
      throw new Error("Booking email delivery could not be finalized.");
    }

    return jsonResponse(
      {
        ok: true,
        bookingReference,
        emailKind,
        deliveryId: delivery.referenceId,
      },
      200,
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
    console.error("Unhandled send-booking-email error", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(
      500,
      "EMAIL_DELIVERY_FAILED",
      "The booking email could not be sent.",
      allowedOrigin,
    );
  }
});
