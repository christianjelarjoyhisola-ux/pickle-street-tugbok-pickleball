// @ts-nocheck
import { Temporal } from "@js-temporal/polyfill";
/** Convert tenant-local, hourly selections to unambiguous UTC instants. */ export function buildZonedBookingRange(options) {
  const plainStart = Temporal.PlainDateTime.from(`${options.bookingDate}T${options.startTime}:00`);
  const zonedStart = plainStart.toZonedDateTime(options.timeZone, {
    disambiguation: "reject"
  });
  const slots = Array.from({
    length: options.durationHours
  }, (_, index)=>{
    const startsAt = zonedStart.add({
      hours: index
    }).toInstant();
    const endsAt = zonedStart.add({
      hours: index + 1
    }).toInstant();
    return {
      startsAt: startsAt.toString(),
      endsAt: endsAt.toString()
    };
  });
  return {
    startsAt: slots[0].startsAt,
    endsAt: slots[slots.length - 1].endsAt,
    slots
  };
}

