import {
  extractReceiptAmount,
  type ReceiptAmountExtraction,
} from "../receipt-amount.ts";
import type {
  BankReceiptTimestamp,
  ReceiptDedupeKey,
  ReceiptVerificationContext,
  TypedReferenceMatch,
} from "./bank-to-gcash.ts";

export type BpiReferenceField = {
  value: string | null;
  raw: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
  typedMatch: TypedReferenceMatch;
};

export type BpiTransactionReferenceField = {
  value: string | null;
  raw: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
};

export type BpiRecipientField = {
  labelRaw: string | null;
  labelNormalized: string | null;
  accountRaw: string | null;
  accountSuffix: string | null;
  lineIndex: number | null;
};

export type BpiReceiptParse = {
  provider: "bpi";
  destinationProvider: "gcash";
  parserVersion: "bpi_to_gcash_v1";
  reference: BpiReferenceField;
  transactionReference: BpiTransactionReferenceField;
  amount: ReceiptAmountExtraction;
  timestamp: BankReceiptTimestamp;
  recipient: BpiRecipientField;
  indicators: {
    providerBrand: boolean;
    competingProviderBrand: boolean;
    transferSuccess: boolean;
    destinationGcash: boolean;
    instaPay: boolean;
    qrCodeRecipient: boolean;
    gmtPlus8: boolean;
  };
  issues: string[];
};

export type BpiRecipientComparison =
  | "exact"
  | "mismatch"
  | "missing"
  | "not_configured";

export type BpiRecipientAccountComparison =
  | "exact"
  | "mismatch"
  | "missing"
  | "not_configured";

export type BpiReceiptVerificationEvidence = {
  provider: "bpi";
  destinationProvider: "gcash";
  parserVersion: "bpi_to_gcash_v1";
  flags: string[];
  recipientComparison: BpiRecipientComparison;
  recipientAccountComparison: BpiRecipientAccountComparison;
  dedupeKeys: ReceiptDedupeKey[];
};

type BpiVerificationContext = ReceiptVerificationContext & {
  expectedRecipientLabel?: string;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function linesOf(rawText: string): string[] {
  return String(rawText || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function digitsOnly(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

function validConfirmation(value: string): boolean {
  return /^\d{10,20}$/.test(value);
}

function validTransactionReference(value: string): boolean {
  return /^\d{4,20}$/.test(value);
}

function typedMatch(
  observed: string | null,
  typedReference: string,
): TypedReferenceMatch {
  const typed = digitsOnly(typedReference);
  if (!typed) return "not_provided";
  if (!validConfirmation(typed)) return "typed_invalid";
  if (!observed) return "ocr_missing";
  return observed === typed ? "match" : "mismatch";
}

function uniqueField(
  lines: string[],
  pattern: RegExp,
  validator: (value: string) => boolean,
): {
  value: string | null;
  raw: string | null;
  lineIndex: number | null;
  ambiguous: boolean;
} {
  const candidates: Array<{ value: string; raw: string; lineIndex: number }> =
    [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(pattern);
    if (!match) return;
    const inline = String(match[1] || "").trim();
    const raw = inline || String(lines[lineIndex + 1] || "").trim();
    if (!/^[0-9][0-9\s-]*$/.test(raw)) return;
    const value = digitsOnly(raw);
    if (validator(value)) candidates.push({ value, raw, lineIndex });
  });
  const unique = [
    ...new Map(candidates.map((item) => [item.value, item])).values(),
  ];
  const selected = unique.length === 1 ? unique[0] : null;
  return {
    value: selected?.value || null,
    raw: selected?.raw || null,
    lineIndex: selected?.lineIndex ?? null,
    ambiguous: unique.length > 1,
  };
}

function validDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseTimestamp(lines: string[]): BankReceiptTimestamp {
  const pattern =
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\s*,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\b/i;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const match = lines[lineIndex].match(pattern);
    if (!match) continue;
    const month = MONTHS[match[1].toLowerCase()] || 0;
    const day = Number(match[2]);
    const year = Number(match[3]);
    let hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const meridiem = match[7].toUpperCase();
    if (
      !validDateParts(year, month, day) || hour < 1 || hour > 12 ||
      minute > 59 || second > 59
    ) {
      return {
        raw: match[0],
        date: null,
        time24: null,
        zone: "Asia/Manila",
        instant: null,
        completeness: "invalid",
        lineIndex,
      };
    }
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour !== 12) hour += 12;
    const date = `${year.toString().padStart(4, "0")}-${
      month.toString().padStart(2, "0")
    }-${day.toString().padStart(2, "0")}`;
    const time24 = `${hour.toString().padStart(2, "0")}:${
      minute.toString().padStart(2, "0")
    }`;
    const instant = new Date(
      `${date}T${time24}:${second.toString().padStart(2, "0")}+08:00`,
    );
    return {
      raw: match[0],
      date,
      time24,
      zone: "Asia/Manila",
      instant: Number.isNaN(instant.getTime()) ? null : instant.toISOString(),
      completeness: Number.isNaN(instant.getTime()) ? "invalid" : "date_time",
      lineIndex,
    };
  }
  return {
    raw: null,
    date: null,
    time24: null,
    zone: "Asia/Manila",
    instant: null,
    completeness: "missing",
    lineIndex: null,
  };
}

export function normalizeBpiRecipientLabel(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\(\s*QR\s*Code\s*\)/gi, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parseRecipient(lines: string[]): BpiRecipientField {
  const transferIndex = lines.findIndex((line) =>
    /^transfer\s+to\b/i.test(line)
  );
  if (transferIndex < 0) {
    return {
      labelRaw: null,
      labelNormalized: null,
      accountRaw: null,
      accountSuffix: null,
      lineIndex: null,
    };
  }
  const block = lines.slice(transferIndex + 1, transferIndex + 6);
  const destinationOffset = block.findIndex((line) =>
    /\bgcash\s*\/\s*g-?xchange\b/i.test(line)
  );
  const labelIndex = destinationOffset >= 0 ? destinationOffset + 1 : 0;
  const labelRaw = String(block[labelIndex] || "").trim() || null;
  const accountRaw =
    block.slice(labelIndex + 1).find((line) =>
      /(?:[*xX]{3,}|X{3,})[A-Z0-9]{2,6}$/i.test(line.replace(/\s/g, ""))
    ) || null;
  const compactAccount = accountRaw?.replace(/\s/g, "") || "";
  const suffix = compactAccount.replace(/^[*xX]+/, "").toUpperCase() || null;
  return {
    labelRaw,
    labelNormalized: labelRaw ? normalizeBpiRecipientLabel(labelRaw) : null,
    accountRaw,
    accountSuffix: suffix,
    lineIndex: labelRaw ? transferIndex + 1 + labelIndex : null,
  };
}

function compareRecipientLabel(
  observed: string | null,
  expectedRaw: string,
): BpiRecipientComparison {
  const expected = normalizeBpiRecipientLabel(expectedRaw);
  if (!expected) return "not_configured";
  if (!observed) return "missing";
  return observed === expected ? "exact" : "mismatch";
}

function normalizeDestinationToken(value: string): string {
  return String(value || "").normalize("NFKC").toUpperCase().replace(
    /[^A-Z0-9]/g,
    "",
  );
}

function compareRecipientAccount(
  observedSuffixRaw: string | null,
  expectedTokenRaw: string,
): BpiRecipientAccountComparison {
  const expectedToken = normalizeDestinationToken(expectedTokenRaw);
  const observedSuffix = normalizeDestinationToken(observedSuffixRaw || "");
  if (!expectedToken) return "not_configured";
  if (!observedSuffix) return "missing";
  if (observedSuffix.length < 3) return "mismatch";
  return expectedToken === observedSuffix ||
      expectedToken.endsWith(observedSuffix)
    ? "exact"
    : "mismatch";
}

function addUnique(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

function failClosedOnConflictingBpiAmounts(
  amount: ReceiptAmountExtraction,
): ReceiptAmountExtraction {
  const principalAmounts = new Set(
    amount.candidates
      .filter((candidate) =>
        !candidate.excluded &&
        (candidate.evidence.includes("amount_label") ||
          candidate.evidence.includes("total_label"))
      )
      .map((candidate) => candidate.amount),
  );
  if (principalAmounts.size <= 1) return amount;
  return {
    ...amount,
    amount: null,
    reliable: false,
    ambiguous: true,
    evidence: [],
    selectedCandidate: null,
    reason: "ambiguous",
  };
}

export function parseBpiToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BpiReceiptParse {
  const lines = linesOf(rawText);
  const text = lines.join("\n");
  const confirmation = uniqueField(
    lines,
    /^confirmation\s*(?:no\.?|number|#)\s*[:#\-–—]?\s*(.*)$/i,
    validConfirmation,
  );
  const transaction = uniqueField(
    lines,
    /^transaction\s*(?:ref\.?|reference)(?:\s*(?:no\.?|number|#))?\s*[:#\-–—]?\s*(.*)$/i,
    validTransactionReference,
  );
  const amount = failClosedOnConflictingBpiAmounts(
    extractReceiptAmount(text, { provider: "bpi" }),
  );
  const timestamp = parseTimestamp(lines);
  const recipient = parseRecipient(lines);
  const issues: string[] = [];
  if (confirmation.ambiguous) issues.push("AMBIGUOUS_CONFIRMATION_NUMBER");
  if (!confirmation.value) issues.push("CONFIRMATION_NUMBER_MISSING");
  if (transaction.ambiguous) issues.push("AMBIGUOUS_TRANSACTION_REFERENCE");
  if (!transaction.value) issues.push("TRANSACTION_REFERENCE_MISSING");
  if (amount.amount == null) issues.push("AMOUNT_MISSING");
  if (!amount.reliable || amount.ambiguous) issues.push("AMOUNT_UNRELIABLE");
  if (timestamp.completeness === "missing") issues.push("TIMESTAMP_MISSING");
  if (timestamp.completeness === "invalid") issues.push("TIMESTAMP_INVALID");
  if (!recipient.labelNormalized) issues.push("RECIPIENT_LABEL_MISSING");
  return {
    provider: "bpi",
    destinationProvider: "gcash",
    parserVersion: "bpi_to_gcash_v1",
    reference: {
      value: confirmation.value,
      raw: confirmation.raw,
      lineIndex: confirmation.lineIndex,
      confidence: confirmation.value ? "high" : "low",
      typedMatch: typedMatch(confirmation.value, options.typedReference || ""),
    },
    transactionReference: {
      value: transaction.value,
      raw: transaction.raw,
      lineIndex: transaction.lineIndex,
      confidence: transaction.value ? "high" : "low",
    },
    amount,
    timestamp,
    recipient,
    indicators: {
      providerBrand: /\bsent\s+via\s+bpi\b/i.test(text),
      competingProviderBrand:
        /\bsent\s+via\s+(?:gcash|maya|bdo|gotyme|go\s*tyme|maribank|mari\s*bank)\b/i
          .test(text),
      transferSuccess: /\btransfer\s+successful!?\b/i.test(text),
      destinationGcash: /\bgcash\s*\/\s*g-?xchange\b/i.test(text),
      instaPay: /\binsta\s*pay\b/i.test(text),
      qrCodeRecipient: /\(\s*qr\s*code\s*\)/i.test(text),
      gmtPlus8: /\(\s*gmt\s*\+\s*8(?::?00)?\s*\)/i.test(text),
    },
    issues,
  };
}

export function verifyBpiToGcashReceipt(
  parsed: BpiReceiptParse,
  context: BpiVerificationContext,
): BpiReceiptVerificationEvidence {
  const flags: string[] = [];
  const recipientComparison = compareRecipientLabel(
    parsed.recipient.labelNormalized,
    context.expectedRecipientLabel || context.expectedRecipientName || "",
  );
  const recipientAccountComparison = compareRecipientAccount(
    parsed.recipient.accountSuffix,
    context.expectedRecipientAccount || "",
  );
  if (!parsed.indicators.providerBrand) addUnique(flags, "BPI_UNREADABLE");
  if (parsed.indicators.competingProviderBrand) {
    addUnique(flags, "METHOD_MISMATCH");
  }
  if (!parsed.indicators.transferSuccess) {
    addUnique(flags, "TRANSFER_STATUS_UNREADABLE");
  }
  if (!parsed.indicators.destinationGcash) {
    addUnique(flags, "GXI_DESTINATION_UNREADABLE");
  }
  if (!parsed.indicators.instaPay) addUnique(flags, "INSTAPAY_QRPH_UNREADABLE");
  if (!parsed.indicators.qrCodeRecipient) {
    addUnique(flags, "RECEIVER_NAME_UNREADABLE");
  }
  if (!parsed.indicators.gmtPlus8) addUnique(flags, "TIMEZONE_UNREADABLE");

  if (parsed.reference.typedMatch === "typed_invalid") {
    addUnique(flags, "REF_FORMAT_INVALID");
  }
  if (!parsed.reference.value) addUnique(flags, "BPI_CONFIRMATION_UNREADABLE");
  if (parsed.reference.typedMatch === "mismatch") {
    addUnique(flags, "REF_MISMATCH");
  }
  if (!parsed.transactionReference.value) {
    addUnique(flags, "BPI_TRANSACTION_UNREADABLE");
  }

  if (!context.pricingAvailable || context.expectedAmount == null) {
    addUnique(flags, "PRICING_UNAVAILABLE");
  } else if (
    parsed.amount.amount == null || !parsed.amount.reliable ||
    parsed.amount.ambiguous
  ) {
    addUnique(flags, "AMOUNT_UNREADABLE");
  } else if (
    Math.abs(parsed.amount.amount - context.expectedAmount) >
      context.amountTolerance
  ) {
    addUnique(flags, "AMOUNT_MISMATCH");
  }

  if (!parsed.timestamp.date) addUnique(flags, "DATE_UNREADABLE");
  else if (
    context.bookingStartedDate &&
    parsed.timestamp.date !== context.bookingStartedDate
  ) addUnique(flags, "DATE_NOT_TODAY");
  const bookingStartedAt = context.bookingStartedAt
    ? new Date(context.bookingStartedAt)
    : null;
  const receiptInstant = parsed.timestamp.instant
    ? new Date(parsed.timestamp.instant)
    : null;
  if (
    !bookingStartedAt || Number.isNaN(bookingStartedAt.getTime()) ||
    !receiptInstant || Number.isNaN(receiptInstant.getTime())
  ) {
    addUnique(flags, "TIME_UNREADABLE");
  } else {
    const ageMinutes = (receiptInstant.getTime() - bookingStartedAt.getTime()) /
      60000;
    if (ageMinutes < -context.earlyToleranceMinutes) {
      addUnique(flags, "TIME_FUTURE");
    } else if (ageMinutes > context.paymentWindowMinutes) {
      addUnique(flags, "TIME_EXPIRED");
    }
  }

  if (recipientComparison === "not_configured") {
    addUnique(flags, "MERCHANT_CONFIG_MISSING");
  } else if (recipientComparison === "missing") {
    addUnique(flags, "RECEIVER_NAME_UNREADABLE");
  } else if (recipientComparison === "mismatch") {
    addUnique(flags, "RECEIVER_NAME_MISMATCH");
  }
  if (recipientAccountComparison === "not_configured") {
    addUnique(flags, "MERCHANT_CONFIG_MISSING");
  } else if (recipientAccountComparison === "missing") {
    addUnique(flags, "RECEIVER_ACCOUNT_UNREADABLE");
  } else if (recipientAccountComparison === "mismatch") {
    addUnique(flags, "RECEIVER_ACCOUNT_MISMATCH");
  }

  const dedupeKeys: ReceiptDedupeKey[] = [];
  if (parsed.reference.value) {
    dedupeKeys.push({
      key: `bpi:${parsed.reference.value}`,
      providerKey: "bpi",
      duplicateFlag: "DUPLICATE_REF",
    });
  }
  if (parsed.transactionReference.value) {
    dedupeKeys.push({
      key: `bpi_transaction:${parsed.transactionReference.value}`,
      providerKey: "bpi_transaction",
      duplicateFlag: "DUPLICATE_BPI_TRANSACTION_REF",
    });
  }
  return {
    provider: "bpi",
    destinationProvider: "gcash",
    parserVersion: parsed.parserVersion,
    flags,
    recipientComparison,
    recipientAccountComparison,
    dedupeKeys,
  };
}
