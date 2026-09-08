export const BOOKING_CONFIRMATION_EMAIL_KIND = "booking_confirmed" as const;

export function parseBookingConfirmationEmailKind(
  value: unknown,
): typeof BOOKING_CONFIRMATION_EMAIL_KIND | null {
  return typeof value === "string" &&
      value.trim() === BOOKING_CONFIRMATION_EMAIL_KIND
    ? BOOKING_CONFIRMATION_EMAIL_KIND
    : null;
}

export function isPaidConfirmedBooking(
  bookingStatus: unknown,
  paymentStatus: unknown,
): boolean {
  const status = typeof bookingStatus === "string"
    ? bookingStatus.trim().toLowerCase()
    : "";
  const payment = typeof paymentStatus === "string"
    ? paymentStatus.trim().toLowerCase()
    : "";
  return status === "confirmed" && payment === "paid";
}
