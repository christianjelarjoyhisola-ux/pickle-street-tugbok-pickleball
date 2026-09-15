// @ts-nocheck
import { Temporal } from "@js-temporal/polyfill";
import { RequestError } from "../http.ts";
export const DEFAULT_MINIMUM_LEAD_MINUTES = 30;
export const DEFAULT_OVERNIGHT_MINIMUM_LEAD_MINUTES = 120;
export const DEFAULT_MAXIMUM_ADVANCE_DAYS = 180;
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function boundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : fallback;
}
export function bookingHorizonPolicy(publicConfig) {
  const config = objectValue(publicConfig);
  return {
    minimumLeadMinutes: boundedInteger(config.minimumLeadMinutes, 0, 10_080, DEFAULT_MINIMUM_LEAD_MINUTES),
    overnightMinimumLeadMinutes: boundedInteger(config.overnightMinimumLeadMinutes, 0, 10_080, DEFAULT_OVERNIGHT_MINIMUM_LEAD_MINUTES),
    maximumAdvanceDays: boundedInteger(config.maximumAdvanceDays, 0, 730, DEFAULT_MAXIMUM_ADVANCE_DAYS)
  };
}
/** Enforce lead time and an inclusive tenant-local maximum booking date. */ export function enforceBookingHorizon(options) {
  let start;
  let now;
  try {
    start = Temporal.Instant.from(options.startsAt);
    now = options.now ? Temporal.Instant.from(options.now) : Temporal.Now.instant();
  } catch  {
    throw new RequestError(422, "BOOKING_TIME_INVALID", "The selected booking time is invalid.");
  }
  const policy = bookingHorizonPolicy(options.publicConfig);
  if (Temporal.Instant.compare(start, now) <= 0) {
    throw new RequestError(422, "BOOKING_TIME_PAST", "The selected booking time has already passed.");
  }
  let localHour;
  try {
    localHour = start.toZonedDateTimeISO(options.timeZone).hour;
  } catch {
    throw new RequestError(500, "TIMEZONE_INVALID", "The venue timezone is not configured correctly.");
  }
  const requiredLeadMinutes = localHour >= 0 && localHour < 5
    ? Math.max(policy.minimumLeadMinutes, policy.overnightMinimumLeadMinutes)
    : policy.minimumLeadMinutes;
  const earliest = now.add({
    minutes: requiredLeadMinutes
  });
  if (Temporal.Instant.compare(start, earliest) < 0) {
    const message = localHour >= 0 && localHour < 5
      ? `Overnight bookings from 12:00 to 5:00 AM require at least ${requiredLeadMinutes} minutes notice.`
      : `Bookings require at least ${requiredLeadMinutes} minutes notice.`;
    throw new RequestError(422, "BOOKING_TOO_SOON", message);
  }
  let latest;
  try {
    latest = now.toZonedDateTimeISO(options.timeZone).add({
      days: policy.maximumAdvanceDays
    }).with({
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
      microsecond: 999,
      nanosecond: 999
    }).toInstant();
  } catch  {
    throw new RequestError(500, "TIMEZONE_INVALID", "The venue timezone is not configured correctly.");
  }
  if (Temporal.Instant.compare(start, latest) > 0) {
    throw new RequestError(422, "BOOKING_TOO_FAR", `Bookings can be made up to ${policy.maximumAdvanceDays} days ahead.`);
  }
  return policy;
}

