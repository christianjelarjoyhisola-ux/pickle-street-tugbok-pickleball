import {
  weatherRefundPercentForElapsedSeconds,
  type WeatherRefundRuleVersion,
} from "./weather-refund.ts";

type JsonObject = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function amountInCents(value: unknown): number | null {
  if (
    value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 0.000001 ? cents : null;
}

function integerValue(value: unknown): number | null {
  if (
    value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function exactWeatherRefundPercent(
  elapsedSeconds: number | null,
  ruleVersion: string,
): number | null {
  if (
    elapsedSeconds === null ||
    !["rain-v1", "rain-v2", "rain-v3"].includes(ruleVersion)
  ) return null;
  try {
    return weatherRefundPercentForElapsedSeconds(
      elapsedSeconds,
      ruleVersion as WeatherRefundRuleVersion,
    );
  } catch {
    return null;
  }
}

function validPayoutLifecycle(
  status: string,
  payoutStatus: string,
  payoutSentAt: string | null,
  refundAmountInCents: number,
): boolean {
  const hasValidSentAt = payoutSentAt !== null &&
    Number.isFinite(Date.parse(payoutSentAt));
  if (payoutStatus === "sent") {
    return status === "approved" && refundAmountInCents > 0 && hasValidSentAt;
  }
  if (payoutSentAt !== null) return false;
  if (payoutStatus === "pending") {
    return ["reported", "approved"].includes(status) &&
      refundAmountInCents > 0;
  }
  return payoutStatus === "not_required" &&
    (refundAmountInCents === 0 || status === "rejected");
}

/**
 * Return only the customer-safe portion of a weather refund incident.
 * Operator notes, actor IDs, incident IDs, and payout evidence stay private.
 */
export function customerWeatherRefundSummary(
  value: unknown,
): JsonObject | null {
  if (!value) return null;
  const incident = objectValue(value);
  const status = text(incident.status);
  const payoutStatus = text(incident.payout_status);
  const payoutSentAt = text(incident.payout_sent_at) || null;
  const ruleVersion = text(incident.rule_version);
  const calculationBasis = text(incident.calculation_basis);
  const currency = text(incident.currency).toUpperCase();
  const elapsedSeconds = integerValue(incident.elapsed_seconds);
  const refundPercent = integerValue(incident.refund_percent);
  const grossPaidAmount = amountInCents(incident.paid_amount);
  const courtRentalAmount = amountInCents(incident.court_rental_amount);
  const equipmentRentalAmount = amountInCents(
    incident.equipment_rental_amount,
  );
  const platformBookingFeeAmount = amountInCents(
    incident.platform_booking_fee_amount,
  );
  const refundableBasisAmount = amountInCents(
    incident.refundable_basis_amount,
  );
  const refundAmount = amountInCents(incident.refund_amount);
  const exactRefundPercent = exactWeatherRefundPercent(
    elapsedSeconds,
    ruleVersion,
  );
  const legacyCalculation = ["rain-v1", "rain-v2"].includes(ruleVersion) &&
    calculationBasis === "gross-paid-legacy" &&
    refundableBasisAmount === grossPaidAmount;
  const currentCalculation = ruleVersion === "rain-v3" &&
    calculationBasis === "court-rental-v1" &&
    refundableBasisAmount === courtRentalAmount &&
    grossPaidAmount !== null &&
    grossPaidAmount ===
      (courtRentalAmount ?? -1) +
        (equipmentRentalAmount ?? -1) +
        (platformBookingFeeAmount ?? -1);
  if (
    !["reported", "approved", "rejected"].includes(status) ||
    !["pending", "sent", "not_required"].includes(payoutStatus) ||
    !["rain-v1", "rain-v2", "rain-v3"].includes(ruleVersion) ||
    elapsedSeconds === null ||
    refundPercent === null ||
    exactRefundPercent === null ||
    refundPercent !== exactRefundPercent ||
    grossPaidAmount === null ||
    courtRentalAmount === null ||
    equipmentRentalAmount === null ||
    platformBookingFeeAmount === null ||
    refundableBasisAmount === null ||
    refundAmount === null ||
    refundAmount !== Math.round(refundableBasisAmount * refundPercent / 100) ||
    (!legacyCalculation && !currentCalculation) ||
    !validPayoutLifecycle(
      status,
      payoutStatus,
      payoutSentAt,
      refundAmount,
    ) ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    throw new Error("Weather refund status is invalid.");
  }
  return {
    status,
    ruleVersion,
    refundPercent,
    grossPaidAmount: grossPaidAmount / 100,
    courtRentalAmount: courtRentalAmount / 100,
    equipmentRentalAmount: equipmentRentalAmount / 100,
    platformBookingFeeAmount: platformBookingFeeAmount / 100,
    refundableBasisAmount: refundableBasisAmount / 100,
    calculationBasis,
    refundAmount: refundAmount / 100,
    currency,
    payoutStatus: status === "reported" ? "awaiting_approval" : payoutStatus,
    payoutSentAt: status === "reported" ? null : payoutSentAt,
  };
}

/**
 * Pair a claim with final incident facts only when the protected foreign key
 * matches. Before approval the immutable claim estimate remains authoritative;
 * after approval the verified incident timing, amount, and payout state win.
 */
export function playerRainClaimWithFinalIncident(
  claimValue: unknown,
  incidentValue: unknown,
): JsonObject | null {
  if (!claimValue) return null;
  const claim = objectValue(claimValue);
  const incident = objectValue(incidentValue);
  const incidentMatches = text(claim.status) === "approved" &&
    text(incident.status) === "approved" &&
    text(claim.incident_id) !== "" &&
    text(claim.incident_id) === text(incident.id);
  return {
    ...claim,
    ...(incidentMatches
      ? {
        elapsed_seconds: incident.elapsed_seconds,
        rule_version: incident.rule_version,
        refund_percent: incident.refund_percent,
        paid_amount: incident.paid_amount,
        court_rental_amount: incident.court_rental_amount,
        equipment_rental_amount: incident.equipment_rental_amount,
        platform_booking_fee_amount: incident.platform_booking_fee_amount,
        refundable_basis_amount: incident.refundable_basis_amount,
        calculation_basis: incident.calculation_basis,
        refund_amount: incident.refund_amount,
        currency: incident.currency,
        payout_status: incident.payout_status,
        payout_sent_at: incident.payout_sent_at,
      }
      : {
        refund_amount: null,
        payout_status: null,
        payout_sent_at: null,
      }),
  };
}

/**
 * A claim is read before its possible incident so an approval committed
 * between the two statements cannot expose an approved claim without the
 * matching incident facts. The incident read remains unconditional because
 * staff/manual reports do not have a player claim.
 */
export async function readPlayerClaimThenWeatherRefund(
  readPlayerClaim: () => Promise<unknown>,
  readWeatherRefund: (playerRainClaim: unknown) => Promise<unknown>,
): Promise<{ playerRainClaim: unknown; weatherRefund: unknown }> {
  const playerRainClaim = await readPlayerClaim();
  const weatherRefund = await readWeatherRefund(playerRainClaim);
  return { playerRainClaim, weatherRefund };
}

/**
 * Capability-protected booking status may expose the progress of the player's
 * own claim, but never its token hash, contact proof, storage path, notes,
 * decision reason, or operator identity.
 */
export function customerPlayerRainClaimSummary(
  value: unknown,
  nowMs = Date.now(),
): JsonObject | null {
  if (!value) return null;
  const claim = objectValue(value);
  const storedStatus = text(claim.status);
  const proofDueAt = text(claim.proof_due_at);
  const proofDueAtMs = Date.parse(proofDueAt);
  const status = storedStatus === "awaiting_proof" &&
      Number.isFinite(proofDueAtMs) && proofDueAtMs < nowMs
    ? "expired"
    : storedStatus;
  const id = text(claim.id).toLowerCase();
  const rainReportedAt = text(claim.rain_reported_at);
  const ruleVersion = text(claim.rule_version);
  const calculationBasis = text(claim.calculation_basis);
  const currency = text(claim.currency).toUpperCase();
  const elapsedSeconds = integerValue(claim.elapsed_seconds);
  const refundPercent = integerValue(claim.refund_percent);
  const exactRefundPercent = exactWeatherRefundPercent(
    elapsedSeconds,
    ruleVersion,
  );
  const grossPaidAmount = amountInCents(claim.paid_amount);
  const courtRentalAmount = amountInCents(claim.court_rental_amount);
  const equipmentRentalAmount = amountInCents(claim.equipment_rental_amount);
  const platformBookingFeeAmount = amountInCents(
    claim.platform_booking_fee_amount,
  );
  const refundableBasisAmount = amountInCents(
    claim.refundable_basis_amount,
  );
  const estimatedRefundAmount = amountInCents(
    claim.estimated_refund_amount,
  );
  const refundAmount = amountInCents(claim.refund_amount);
  const payoutStatus = text(claim.payout_status) || null;
  const payoutSentAt = text(claim.payout_sent_at) || null;
  const hasFinalIncident = refundAmount !== null || payoutStatus !== null ||
    payoutSentAt !== null;
  const presentedRefundAmount = hasFinalIncident
    ? refundAmount
    : estimatedRefundAmount;
  const payoutLifecycleValid = hasFinalIncident &&
      refundAmount !== null &&
      payoutStatus !== null
    ? validPayoutLifecycle(
      "approved",
      payoutStatus,
      payoutSentAt,
      refundAmount,
    )
    : payoutStatus === null && payoutSentAt === null;
  const legacyCalculation = ruleVersion === "rain-v2" &&
    calculationBasis === "gross-paid-legacy" &&
    refundableBasisAmount === grossPaidAmount;
  const currentCalculation = ruleVersion === "rain-v3" &&
    calculationBasis === "court-rental-v1" &&
    refundableBasisAmount === courtRentalAmount &&
    grossPaidAmount !== null &&
    grossPaidAmount ===
      (courtRentalAmount ?? -1) +
        (equipmentRentalAmount ?? -1) +
        (platformBookingFeeAmount ?? -1);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(id) ||
    !["awaiting_proof", "submitted", "approved", "rejected", "expired"]
      .includes(status) ||
    !Number.isFinite(Date.parse(rainReportedAt)) ||
    !Number.isFinite(proofDueAtMs) ||
    !["rain-v2", "rain-v3"].includes(ruleVersion) ||
    elapsedSeconds === null ||
    elapsedSeconds < 1 ||
    refundPercent === null ||
    exactRefundPercent === null ||
    refundPercent !== exactRefundPercent ||
    grossPaidAmount === null ||
    courtRentalAmount === null ||
    equipmentRentalAmount === null ||
    platformBookingFeeAmount === null ||
    refundableBasisAmount === null ||
    presentedRefundAmount === null ||
    presentedRefundAmount !==
      Math.round(refundableBasisAmount * refundPercent / 100) ||
    (!legacyCalculation && !currentCalculation) ||
    (status === "approved") !== hasFinalIncident ||
    (!hasFinalIncident && estimatedRefundAmount === null) ||
    !payoutLifecycleValid ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    throw new Error("Player rain claim status is invalid.");
  }
  return {
    id,
    status,
    rainReportedAt,
    proofDueAt,
    proofAvailable: Boolean(text(claim.proof_storage_path)),
    elapsedSeconds,
    elapsedMinutes: Math.round(elapsedSeconds / 6) / 10,
    ruleVersion,
    refundPercent,
    grossPaidAmount: grossPaidAmount / 100,
    courtRentalAmount: courtRentalAmount / 100,
    equipmentRentalAmount: equipmentRentalAmount / 100,
    platformBookingFeeAmount: platformBookingFeeAmount / 100,
    refundableBasisAmount: refundableBasisAmount / 100,
    calculationBasis,
    ...(hasFinalIncident
      ? { refundAmount: (refundAmount as number) / 100 }
      : { estimatedRefundAmount: (estimatedRefundAmount as number) / 100 }),
    currency,
    submittedAt: text(claim.submitted_at) || null,
    decidedAt: text(claim.decided_at) || null,
    payoutStatus,
    payoutSentAt,
  };
}
