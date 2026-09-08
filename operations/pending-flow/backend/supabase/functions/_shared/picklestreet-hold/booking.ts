// @ts-nocheck
import { RequestError } from "../http.ts";
import { normalizeTenantSlug } from "../tenant.ts";
export function createBookingMetadata(request, quote, policyAcceptance = null) {
  // Deliberate allowlist: transient anti-bot tokens and unknown request fields
  // can never be copied into the booking record.
  const metadata = {
    source: "public_web",
    clientRequestId: request.clientRequestId,
    notes: request.notes,
    rateBreakdown: quote.rateBreakdown,
    fullPaymentOnly: quote.fullPaymentOnly,
    equipmentRental: request.equipmentRental,
    equipmentRentalRates: quote.equipmentRentalRates,
    equipmentRentalFeeAmount: quote.equipmentRentalFeeAmount,
    courtSubtotalAmount: quote.courtSubtotalAmount
  };
  if (policyAcceptance) metadata.policyAcceptance = policyAcceptance;
  return metadata;
}
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_CLIENT_FIELDS = new Set([
  "tenant_id",
  "tenantId",
  "price",
  "rate",
  "subtotal",
  "subtotalAmount",
  "serviceFee",
  "serviceFeeAmount",
  "bookingFee",
  "total",
  "totalAmount",
  "currency",
  "slots",
  "metadata"
]);
function requiredText(value, field, minimum, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < minimum || text.length > maximum) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", `${field} is invalid.`);
  }
  return text;
}
function parseBookingDate(value) {
  const text = requiredText(value, "Booking date", 10, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Booking date must use YYYY-MM-DD.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Booking date is invalid.");
  }
  return text;
}
export function parseClockMinutes(value, field = "Time", allowEndOfDay = false) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (!match) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", `${field} is invalid.`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || hour === 24 && (!allowEndOfDay || minute !== 0)) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", `${field} is invalid.`);
  }
  return hour * 60 + minute;
}
function normalizedStartTime(value) {
  const minutes = parseClockMinutes(value, "Start time");
  if (minutes % 60 !== 0) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Bookings must start on the hour.");
  }
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:00`;
}
function integerBetween(value, field, min, max) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", `${field} is invalid.`);
  }
  return Number(value);
}
function parseEquipmentRental(value) {
  if (value === undefined || value === null) {
    return {
      extraPaddles: 0,
      balls: 0
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Equipment rental is invalid.");
  }
  const rental = value;
  return {
    extraPaddles: rental.extraPaddles === undefined ? 0 : integerBetween(rental.extraPaddles, "Extra paddle quantity", 0, 99),
    balls: rental.balls === undefined ? 0 : integerBetween(rental.balls, "Ball quantity", 0, 99)
  };
}
export function parsePublicBookingRequest(body, expectedTenantSlug) {
  for (const field of Object.keys(body)){
    if (FORBIDDEN_CLIENT_FIELDS.has(field)) {
      throw new RequestError(400, "CLIENT_CONTROLLED_FIELD", `${field} must be calculated by the booking service.`);
    }
  }
  const tenantSlug = normalizeTenantSlug(body.tenantSlug ?? expectedTenantSlug);
  if (expectedTenantSlug && tenantSlug !== normalizeTenantSlug(expectedTenantSlug)) {
    throw new RequestError(400, "TENANT_SLUG_MISMATCH", "The tenant slug does not match the request URL.");
  }
  const courtId = requiredText(body.courtId, "Court", 36, 36);
  if (!UUID_PATTERN.test(courtId)) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Court is invalid.");
  }
  const bookingType = body.bookingType;
  if (bookingType !== "regular" && bookingType !== "event") {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Booking type is invalid.");
  }
  const customer = body.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Customer details are required.");
  }
  const customerRecord = customer;
  const customerEmail = requiredText(customerRecord.email, "Customer email", 5, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(customerEmail)) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Customer email is invalid.");
  }
  const customerPhone = requiredText(customerRecord.phone, "Customer phone", 7, 30);
  if (!/^[+0-9][0-9 ()+.-]{6,29}$/.test(customerPhone)) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Customer phone is invalid.");
  }
  // A caller-stable idempotency key is mandatory. Generating one here would
  // let a lost response create a second hold when the browser retries.
  const clientRequestId = requiredText(body.clientRequestId, "Client request ID", 36, 36).toLowerCase();
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw new RequestError(400, "BOOKING_INPUT_INVALID", "Client request ID must be a cryptographically random UUID.");
  }
  return {
    tenantSlug,
    courtId: courtId.toLowerCase(),
    bookingDate: parseBookingDate(body.bookingDate),
    startTime: normalizedStartTime(body.startTime),
    durationHours: integerBetween(body.durationHours, "Duration", 1, 18),
    bookingType,
    customerName: requiredText(customerRecord.name, "Customer name", 2, 100),
    customerEmail,
    customerPhone,
    guestCount: body.guestCount === undefined ? 1 : integerBetween(body.guestCount, "Guest count", 1, 500),
    equipmentRental: parseEquipmentRental(body.equipmentRental),
    notes: body.notes === undefined || body.notes === null || body.notes === "" ? null : requiredText(body.notes, "Notes", 1, 1_000),
    clientRequestId,
    policyAccepted: body.policyAccepted === true,
    // Do not trim this field. A configured tenant must submit the exact
    // canonical version rendered to the customer.
    policyVersion: typeof body.policyVersion === "string" ? body.policyVersion : null
  };
}
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function assertEventBookingEnabled(bookingType, tenantPublicConfig, courtPricingConfig) {
  if (bookingType !== "event") return;
  const tenantConfig = objectValue(tenantPublicConfig);
  const eventConfig = objectValue(objectValue(courtPricingConfig).event);
  if (tenantConfig.eventBookingEnabled !== true || eventConfig.enabled !== true) {
    throw new RequestError(422, "EVENT_BOOKING_DISABLED", "Event booking is not enabled for this venue and court.");
  }
}
function finiteNumber(value, field, minimum = 0) {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number) || number < minimum) {
    throw new RequestError(422, "PRICING_CONFIG_INVALID", `${field} is not configured correctly.`);
  }
  return number;
}
function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function formatClock(minutes) {
  const normalized = (minutes % 1_440 + 1_440) % 1_440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}
function assertWithinOperatingHours(request, openTime, closeTime) {
  const opening = parseClockMinutes(openTime, "Court opening time");
  // PostgreSQL stores a human-friendly end-of-day sentinel as 23:59:59.
  // Hourly bookings ending at 00:00 must treat that sentinel as midnight.
  let closing = String(closeTime).trim() === "23:59:59" ? 1_440 : parseClockMinutes(closeTime, "Court closing time", true);
  if (closing <= opening) closing += 1_440;
  let start = parseClockMinutes(request.startTime, "Start time");
  if (start < opening && closing > 1_440) start += 1_440;
  const end = start + request.durationHours * 60;
  if (start < opening || end > closing) {
    throw new RequestError(422, "OUTSIDE_OPERATING_HOURS", "The selected hours are outside court operating hours.");
  }
  return start;
}
function calculateBookingFee(feeConfigValue, subtotal, durationHours) {
  const config = objectValue(feeConfigValue);
  const mode = config.feeMode;
  const amount = config.feeAmount;
  if (mode === "fixed_per_booking") {
    return money(finiteNumber(amount, "Fixed booking fee"));
  }
  if (mode === "fixed_per_hour") {
    return money(finiteNumber(amount, "Hourly booking fee") * durationHours);
  }
  if (mode === "percentage") {
    return money(subtotal * finiteNumber(amount, "Booking fee percentage") / 100);
  }
  throw new RequestError(500, "PLATFORM_BILLING_INVALID", "Platform billing is not configured correctly.");
}
/**
 * Calculate all monetary fields exclusively from server-fetched configuration.
 * The browser request contains no price, currency, or fee fields.
 */ export function calculateBookingQuote(options) {
  const config = objectValue(options.pricingConfig);
  const startMinutes = assertWithinOperatingHours(options.request, options.openTime, options.closeTime);
  const section = objectValue(config[options.request.bookingType]);
  const minimumHours = section.minimumHours === undefined ? 1 : finiteNumber(section.minimumHours, "Minimum booking hours", 1);
  const maximumHours = section.maximumHours === undefined ? 18 : finiteNumber(section.maximumHours, "Maximum booking hours", 1);
  if (options.request.durationHours < minimumHours || options.request.durationHours > maximumHours) {
    throw new RequestError(422, "DURATION_NOT_ALLOWED", `This booking requires ${minimumHours}-${maximumHours} hours.`);
  }
  const maximumGuests = section.maximumGuests === undefined ? 500 : finiteNumber(section.maximumGuests, "Maximum guests", 1);
  if (options.request.guestCount > maximumGuests) {
    throw new RequestError(422, "GUEST_LIMIT_EXCEEDED", `This booking allows up to ${maximumGuests} guests.`);
  }
  const rateBreakdown = [];
  if (options.request.bookingType === "event") {
    const hourlyRate = finiteNumber(section.hourlyRate, "Event hourly rate", 0.01);
    for(let index = 0; index < options.request.durationHours; index++){
      rateBreakdown.push({
        startTime: formatClock(startMinutes + index * 60),
        hourlyRate: money(hourlyRate)
      });
    }
  } else {
    const bands = Array.isArray(section.bands) ? section.bands : [];
    if (!bands.length) {
      throw new RequestError(422, "PRICING_CONFIG_INVALID", "Regular hourly rates are not configured.");
    }
    for(let index = 0; index < options.request.durationHours; index++){
      const slotStart = startMinutes + index * 60;
      // SQL prices each timestamptz slot using its tenant-local minute-of-day.
      // Normalize here as well so slots after midnight match wrapping bands.
      const slotMinuteOfDay = (slotStart % 1_440 + 1_440) % 1_440;
      const matchingBands = bands.filter((candidate)=>{
        const band = objectValue(candidate);
        const bandStart = parseClockMinutes(band.start, "Rate band start");
        let bandEnd = parseClockMinutes(band.end, "Rate band end", true);
        if (bandEnd <= bandStart) bandEnd += 1_440;
        let comparisonMinutes = slotMinuteOfDay;
        if (comparisonMinutes < bandStart) comparisonMinutes += 1_440;
        return comparisonMinutes >= bandStart && comparisonMinutes < bandEnd;
      });
      if (matchingBands.length !== 1) {
        throw new RequestError(422, "RATE_NOT_CONFIGURED", `Exactly one positive rate must be configured for ${formatClock(slotStart)}.`);
      }
      const hourlyRate = finiteNumber(objectValue(matchingBands[0]).hourlyRate, "Regular hourly rate", 0.01);
      rateBreakdown.push({
        startTime: formatClock(slotStart),
        hourlyRate: money(hourlyRate)
      });
    }
  }
  const courtSubtotalAmount = money(rateBreakdown.reduce((sum, item)=>sum + item.hourlyRate, 0));
  const serviceFeeAmount = calculateBookingFee(options.platformBillingConfig, courtSubtotalAmount, options.request.durationHours);
  const rentalConfig = objectValue(options.equipmentRentalConfig);
  const rentalRequested = options.request.equipmentRental.extraPaddles > 0 || options.request.equipmentRental.balls > 0;
  if (rentalRequested && rentalConfig.enabled !== true) {
    throw new RequestError(422, "EQUIPMENT_RENTAL_UNAVAILABLE", "Equipment rental is not available for this venue.");
  }
  const equipmentRentalRates = {
    extraPaddle: rentalConfig.enabled === true ? money(finiteNumber(rentalConfig.extraPaddleRate, "Extra paddle rate")) : 0,
    ball: rentalConfig.enabled === true ? money(finiteNumber(rentalConfig.ballRate, "Ball rate")) : 0
  };
  const equipmentRentalFeeAmount = money(options.request.equipmentRental.extraPaddles * equipmentRentalRates.extraPaddle + options.request.equipmentRental.balls * equipmentRentalRates.ball);
  // Equipment is part of the stored subtotal so the database invariant remains
  // total = subtotal + service fee. The booking fee above is intentionally
  // calculated from court time only.
  const subtotalAmount = money(courtSubtotalAmount + equipmentRentalFeeAmount);
  const currency = String(options.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RequestError(422, "PRICING_CONFIG_INVALID", "Court currency is invalid.");
  }
  return {
    courtSubtotalAmount,
    equipmentRentalFeeAmount,
    equipmentRentalRates,
    subtotalAmount,
    serviceFeeAmount,
    totalAmount: money(subtotalAmount + serviceFeeAmount),
    currency,
    fullPaymentOnly: section.fullPaymentRequired === true,
    rateBreakdown
  };
}

