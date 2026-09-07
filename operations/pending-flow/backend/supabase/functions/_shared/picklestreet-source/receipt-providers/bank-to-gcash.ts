import {
  compareGcashMaskedName,
  type GcashNameComparison,
  normalizeGcashMobile,
} from "../gcash-receipt.ts";
import {
  extractReceiptAmount,
  type ReceiptAmountExtraction,
} from "../receipt-amount.ts";

export type BankToGcashProvider = "gotyme" | "maribank";

export type TypedReferenceMatch =
  | "match"
  | "mismatch"
  | "typed_invalid"
  | "not_provided"
  | "ocr_missing";

export type BankReferenceField = {
  value: string | null;
  raw: string | null;
  source:
    | "transaction_label"
    | "reference_label"
    | "transfer_label"
    | "missing";
  label: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
  typedMatch: TypedReferenceMatch;
};

export type BankRailReferenceField = {
  scheme: "instapay";
  value: string | null;
  raw: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
};

export type BankReceiptTimestamp = {
  raw: string | null;
  date: string | null;
  time24: string | null;
  zone: "Asia/Manila";
  instant: string | null;
  completeness: "date_time" | "date_only" | "missing" | "invalid";
  lineIndex: number | null;
};

export type BankReceiptRecipient = {
  nameRaw: string | null;
  accountRaw: string | null;
  phoneNormalized: string | null;
  phoneLast4: string | null;
  phoneVisibility: "full" | "masked" | "missing";
  lineIndex: number | null;
};

export type BankReceiptIndicators = {
  providerBrand: boolean;
  competingProviderBrand: BankToGcashProvider | null;
  transferSuccess: boolean;
  destinationGcash: boolean;
  instaPay: boolean;
};

export type BankToGcashReceiptParse = {
  provider: BankToGcashProvider;
  destinationProvider: "gcash";
  parserVersion: "gotyme_to_gcash_v1" | "maribank_to_gcash_v1";
  reference: BankReferenceField;
  railReference: BankRailReferenceField;
  amount: ReceiptAmountExtraction;
  timestamp: BankReceiptTimestamp;
  recipient: BankReceiptRecipient;
  indicators: BankReceiptIndicators;
  issues: string[];
};

export type BankRecipientComparison = {
  phone: "exact" | "last4_only" | "mismatch" | "missing" | "not_configured";
  name: GcashNameComparison;
};

export type ReceiptVerificationContext = {
  typedReference?: string;
  expectedAmount: number | null;
  pricingAvailable: boolean;
  amountTolerance: number;
  expectedRecipientNumber?: string;
  expectedRecipientName?: string;
  expectedRecipientAccount?: string;
  bookingStartedAt?: string | null;
  bookingStartedDate?: string | null;
  paymentWindowMinutes: number;
  earlyToleranceMinutes: number;
};

export type ReceiptDedupeKey = {
  key: string;
  providerKey: string;
  duplicateFlag: string;
};

export type BankReceiptVerificationEvidence = {
  provider: BankToGcashProvider;
  destinationProvider: "gcash";
  parserVersion: BankToGcashReceiptParse["parserVersion"];
  flags: string[];
  recipientComparison: BankRecipientComparison;
  dedupeKeys: ReceiptDedupeKey[];
};

export type BankReceiptParserConfig = {
  provider: BankToGcashProvider;
  parserVersion: BankToGcashReceiptParse["parserVersion"];
  brandPattern: RegExp;
  competingBrandPattern: RegExp;
  competingProvider: BankToGcashProvider;
  unreadableFlag: string;
};

const PRIMARY_LABELS: Array<{
  label: string;
  source: BankReferenceField["source"];
  pattern: RegExp;
}> = [
  {
    label: "transaction_id",
    source: "transaction_label",
    pattern:
      /^(?:transaction\s*(?:id|no\.?|number)|transaction\s*(?:reference|ref)(?:\s*(?:no\.?|number))?)\s*[:#\-–—]?\s*(.*)$/i,
  },
  {
    label: "reference_no",
    source: "reference_label",
    pattern:
      /^(?:reference|ref\.?)\s*(?:id|no\.?|number|#)?\s*[:#\-–—]?\s*(.*)$/i,
  },
  {
    label: "transfer_id",
    source: "transfer_label",
    pattern:
      /^(?:transfer)\s*(?:id|reference|ref|no\.?|number)\s*[:#\-–—]?\s*(.*)$/i,
  },
  {
    label: "receipt_no",
    source: "reference_label",
    pattern: /^(?:receipt)\s*(?:id|no\.?|number)\s*[:#\-–—]?\s*(.*)$/i,
  },
];

const RAIL_LABELS = [
  /^(?:insta\s*pay)\s*(?:reference|ref)(?:\s*(?:id|no\.?|number))?\s*[:#\-–—]?\s*(.*)$/i,
  /^(?:network\s*(?:reference|ref)|trace\s*(?:id|no\.?|number))\s*[:#\-–—]?\s*(.*)$/i,
];

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

export function normalizeBankReference(value: string): string {
  return String(value || "").normalize("NFKC").toUpperCase().replace(
    /[^A-Z0-9]/g,
    "",
  );
}

function validReference(value: string): boolean {
  const normalized = normalizeBankReference(value);
  const digitCount = (normalized.match(/\d/g) || []).length;
  return normalized.length >= 6 && normalized.length <= 40 && digitCount >= 4;
}

function cleanCandidate(raw: string): string {
  return String(raw || "")
    .replace(/\s+(?:date|time|amount|status|fee)\b.*$/i, "")
    .trim();
}

function valueAfterLabel(
  lines: string[],
  index: number,
  inline: string,
): string {
  const cleaned = cleanCandidate(inline);
  if (validReference(cleaned)) return cleaned;
  const next = cleanCandidate(lines[index + 1] || "");
  return validReference(next) ? next : "";
}

function typedReferenceMatch(
  observed: string | null,
  typedReference: string,
): TypedReferenceMatch {
  const typed = normalizeBankReference(typedReference);
  if (!typed) return "not_provided";
  if (!validReference(typed)) return "typed_invalid";
  if (!observed) return "ocr_missing";
  return observed === typed ? "match" : "mismatch";
}

function parsePrimaryReference(
  lines: string[],
  typedReference: string,
): { field: BankReferenceField; ambiguous: boolean } {
  const candidates: Array<{
    value: string;
    raw: string;
    label: string;
    source: BankReferenceField["source"];
    lineIndex: number;
  }> = [];
  lines.forEach((line, lineIndex) => {
    for (const definition of PRIMARY_LABELS) {
      const match = line.match(definition.pattern);
      if (!match) continue;
      const raw = valueAfterLabel(lines, lineIndex, match[1] || "");
      const value = normalizeBankReference(raw);
      if (validReference(value)) {
        candidates.push({
          value,
          raw,
          label: definition.label,
          source: definition.source,
          lineIndex,
        });
      }
      break;
    }
  });
  const unique = [
    ...new Map(candidates.map((item) => [item.value, item])).values(),
  ];
  const selected = unique.length === 1 ? unique[0] : null;
  return {
    ambiguous: unique.length > 1,
    field: {
      value: selected?.value || null,
      raw: selected?.raw || null,
      source: selected?.source || "missing",
      label: selected?.label || null,
      lineIndex: selected?.lineIndex ?? null,
      confidence: selected ? "high" : "low",
      typedMatch: typedReferenceMatch(selected?.value || null, typedReference),
    },
  };
}

function parseRailReference(lines: string[]): {
  field: BankRailReferenceField;
  ambiguous: boolean;
} {
  const candidates: Array<{ value: string; raw: string; lineIndex: number }> =
    [];
  lines.forEach((line, lineIndex) => {
    for (const pattern of RAIL_LABELS) {
      const match = line.match(pattern);
      if (!match) continue;
      const raw = valueAfterLabel(lines, lineIndex, match[1] || "");
      const value = normalizeBankReference(raw);
      if (validReference(value)) candidates.push({ value, raw, lineIndex });
      break;
    }
  });
  const unique = [
    ...new Map(candidates.map((item) => [item.value, item])).values(),
  ];
  const selected = unique.length === 1 ? unique[0] : null;
  return {
    ambiguous: unique.length > 1,
    field: {
      scheme: "instapay",
      value: selected?.value || null,
      raw: selected?.raw || null,
      lineIndex: selected?.lineIndex ?? null,
      confidence: selected ? "high" : "low",
    },
  };
}

function validDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function timestampResult(
  raw: string,
  lineIndex: number,
  year: number,
  month: number,
  day: number,
  hourRaw: number | null,
  minuteRaw: number | null,
  meridiem: string,
): BankReceiptTimestamp {
  if (!validDateParts(year, month, day)) {
    return {
      raw,
      date: null,
      time24: null,
      zone: "Asia/Manila",
      instant: null,
      completeness: "invalid",
      lineIndex,
    };
  }
  const date = [
    year.toString().padStart(4, "0"),
    month.toString().padStart(2, "0"),
    day.toString().padStart(2, "0"),
  ].join("-");
  if (hourRaw == null || minuteRaw == null) {
    return {
      raw,
      date,
      time24: null,
      zone: "Asia/Manila",
      instant: null,
      completeness: "date_only",
      lineIndex,
    };
  }
  let hour = hourRaw;
  const minute = minuteRaw;
  const period = meridiem.toUpperCase();
  const invalidClock = minute > 59 ||
    (period ? hour < 1 || hour > 12 : hour > 23);
  if (invalidClock) {
    return {
      raw,
      date,
      time24: null,
      zone: "Asia/Manila",
      instant: null,
      completeness: "invalid",
      lineIndex,
    };
  }
  if (period === "AM" && hour === 12) hour = 0;
  if (period === "PM" && hour !== 12) hour += 12;
  const time24 = [
    hour.toString().padStart(2, "0"),
    minute.toString().padStart(2, "0"),
  ].join(":");
  const parsed = new Date(`${date}T${time24}:00+08:00`);
  return {
    raw,
    date,
    time24,
    zone: "Asia/Manila",
    instant: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(),
    completeness: Number.isNaN(parsed.getTime()) ? "invalid" : "date_time",
    lineIndex,
  };
}

function parseTimestamp(lines: string[]): BankReceiptTimestamp {
  const monthName =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})(?:\s*(?:,|at)?\s*(\d{1,2}):(\d{2})\s*(AM|PM))?\b/i;
  const iso =
    /\b(\d{4})-(\d{2})-(\d{2})(?:[ T,]+(\d{1,2}):(\d{2})\s*(AM|PM)?)?\b/i;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const named = line.match(monthName);
    if (named) {
      return timestampResult(
        named[0],
        lineIndex,
        Number(named[3]),
        MONTHS[named[1].toLowerCase()] || 0,
        Number(named[2]),
        named[4] ? Number(named[4]) : null,
        named[5] ? Number(named[5]) : null,
        named[6] || "",
      );
    }
    const numeric = line.match(iso);
    if (numeric) {
      return timestampResult(
        numeric[0],
        lineIndex,
        Number(numeric[1]),
        Number(numeric[2]),
        Number(numeric[3]),
        numeric[4] ? Number(numeric[4]) : null,
        numeric[5] ? Number(numeric[5]) : null,
        numeric[6] || "",
      );
    }
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

function parseRecipient(lines: string[]): BankReceiptRecipient {
  const anchor =
    /^(?:recipient|receiver|beneficiary|sent\s+to|to|destination)(?:\s+(?:name|account))?\s*[:\-–—]?\s*(.*)$/i;
  let lineIndex: number | null = null;
  let inline = "";
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(anchor);
    if (!match) continue;
    lineIndex = index;
    inline = String(match[1] || "").trim();
    break;
  }
  const start = lineIndex ?? 0;
  const block = lines.slice(start, Math.min(lines.length, start + 5));
  const blockText = block.join("\n");
  const fullPhone = blockText.match(
    /(?:\+?63|0)?9(?:[\s-]*\d){9}\b/,
  )?.[0] || null;
  const phoneNormalized = fullPhone ? normalizeGcashMobile(fullPhone) : null;
  const maskedPhone = blockText.match(
    /(?:\+?63|0)?9?[\d\s-]{0,4}[•*xX]{2,}[•*xX\d\s-]*?(\d{4})\b/,
  );
  const labeledLast4 = blockText.match(
    /(?:mobile|account|number|no\.?)\D{0,20}(\d{4})\b/i,
  );
  const phoneLast4 = phoneNormalized?.slice(-4) || maskedPhone?.[1] ||
    labeledLast4?.[1] || null;
  const accountRaw =
    block.find((line) =>
      /\b(?:mobile|account)\s*(?:number|no\.?|#)?\b/i.test(line)
    ) || fullPhone || null;
  const namedLine = block.find((line) =>
    /^(?:recipient|receiver|beneficiary|account)\s*name\s*[:\-–—]/i.test(line)
  );
  const namedMatch = namedLine?.match(/[:\-–—]\s*(.+)$/);
  const possibleNames = [namedMatch?.[1] || "", inline, ...block.slice(1)]
    .map((value) => value.trim())
    .filter((value) =>
      value.length >= 2 &&
      !/\b(?:gcash|g-?xchange|insta\s*pay|account|mobile|number|successful|amount|php|₱)\b/i
        .test(value) &&
      !/\d{4}/.test(value)
    );
  return {
    nameRaw: possibleNames[0] || null,
    accountRaw,
    phoneNormalized,
    phoneLast4,
    phoneVisibility: phoneNormalized
      ? "full"
      : phoneLast4
      ? "masked"
      : "missing",
    lineIndex,
  };
}

function compareRecipient(
  recipient: BankReceiptRecipient,
  expectedNumber: string,
  expectedName: string,
): BankRecipientComparison {
  const expectedPhone = normalizeGcashMobile(expectedNumber);
  let phone: BankRecipientComparison["phone"] = "not_configured";
  if (expectedPhone) {
    if (recipient.phoneNormalized) {
      phone = recipient.phoneNormalized === expectedPhone
        ? "exact"
        : "mismatch";
    } else if (recipient.phoneLast4) {
      phone = recipient.phoneLast4 === expectedPhone.slice(-4)
        ? "last4_only"
        : "mismatch";
    } else {
      phone = "missing";
    }
  }
  return {
    phone,
    name: compareGcashMaskedName(recipient.nameRaw, expectedName),
  };
}

function addUnique(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

export function parseBankToGcashReceipt(
  rawText: string,
  options: { typedReference?: string },
  config: BankReceiptParserConfig,
): BankToGcashReceiptParse {
  const lines = linesOf(rawText);
  const text = lines.join("\n");
  const primary = parsePrimaryReference(lines, options.typedReference || "");
  const rail = parseRailReference(lines);
  let amount = extractReceiptAmount(text, { provider: config.provider });
  if (amount.amount == null) {
    // Bank receipts commonly put an account-number line immediately before
    // the amount. The shared parser deliberately excludes account-adjacent
    // money, so retry only the explicit Amount/Total block instead of weakening
    // its global false-positive protection.
    const amountBlock: string[] = [];
    lines.forEach((line, index) => {
      if (!/\b(?:amount|total)\b/i.test(line)) return;
      amountBlock.push(line);
      if (lines[index + 1]) amountBlock.push(lines[index + 1]);
    });
    if (amountBlock.length) {
      const focused = extractReceiptAmount(amountBlock.join("\n"), {
        provider: config.provider,
      });
      if (focused.amount != null) amount = focused;
    }
  }
  const timestamp = parseTimestamp(lines);
  const recipient = parseRecipient(lines);
  const issues: string[] = [];
  if (primary.ambiguous) issues.push("AMBIGUOUS_REFERENCE");
  if (!primary.field.value) issues.push("REFERENCE_MISSING");
  if (rail.ambiguous) issues.push("AMBIGUOUS_INSTAPAY_REFERENCE");
  if (amount.amount == null) issues.push("AMOUNT_MISSING");
  if (amount.ambiguous) issues.push("AMBIGUOUS_AMOUNT");
  if (timestamp.completeness === "missing") issues.push("TIMESTAMP_MISSING");
  if (timestamp.completeness === "invalid") issues.push("TIMESTAMP_INVALID");
  if (!recipient.nameRaw) issues.push("RECIPIENT_NAME_MISSING");
  if (recipient.phoneVisibility === "missing") {
    issues.push("RECIPIENT_PHONE_MISSING");
  }
  return {
    provider: config.provider,
    destinationProvider: "gcash",
    parserVersion: config.parserVersion,
    reference: primary.field,
    railReference: rail.field,
    amount,
    timestamp,
    recipient,
    indicators: {
      providerBrand: config.brandPattern.test(text),
      competingProviderBrand: config.competingBrandPattern.test(text)
        ? config.competingProvider
        : null,
      transferSuccess:
        /\b(?:transfer|transaction)\s+(?:successful|completed?)\b|\bsuccessfully\s+(?:sent|transferred)\b|\bmoney\s+sent\b/i
          .test(text),
      destinationGcash: /\bgcash\b|\bg-?xchange\b|\bgxi\b/i.test(text),
      instaPay: /\binsta\s*pay\b/i.test(text),
    },
    issues,
  };
}

export function verifyBankToGcashReceipt(
  parsed: BankToGcashReceiptParse,
  context: ReceiptVerificationContext,
  unreadableFlag: string,
): BankReceiptVerificationEvidence {
  const flags: string[] = [];
  const recipientComparison = compareRecipient(
    parsed.recipient,
    context.expectedRecipientNumber || "",
    context.expectedRecipientName || "",
  );
  if (!parsed.indicators.providerBrand) addUnique(flags, unreadableFlag);
  if (parsed.indicators.competingProviderBrand) {
    addUnique(flags, "METHOD_MISMATCH");
  }
  if (!parsed.indicators.transferSuccess) {
    addUnique(flags, "TRANSFER_STATUS_UNREADABLE");
  }
  if (!parsed.indicators.destinationGcash) {
    addUnique(flags, "GXI_DESTINATION_UNREADABLE");
  }
  if (!parsed.indicators.instaPay) addUnique(flags, "INSTAPAY_UNREADABLE");
  if (!parsed.railReference.value) {
    addUnique(flags, "INSTAPAY_REF_UNREADABLE");
  }

  if (parsed.reference.typedMatch === "typed_invalid") {
    addUnique(flags, "REF_FORMAT_INVALID");
  }
  if (!parsed.reference.value) addUnique(flags, "REF_UNREADABLE");
  if (parsed.reference.typedMatch === "mismatch") {
    addUnique(flags, "REF_MISMATCH");
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
  ) {
    addUnique(flags, "DATE_NOT_TODAY");
  }
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

  if (recipientComparison.phone === "mismatch") {
    addUnique(flags, "WRONG_GCASH_NUMBER");
  } else if (
    recipientComparison.phone === "missing" ||
    recipientComparison.phone === "not_configured"
  ) {
    addUnique(flags, "NUMBER_UNREADABLE");
  }
  if (recipientComparison.name === "mismatch") {
    addUnique(flags, "RECEIVER_NAME_MISMATCH");
  } else if (
    context.expectedRecipientName &&
    ["missing", "inconclusive", "not_configured"].includes(
      recipientComparison.name,
    )
  ) {
    addUnique(flags, "RECEIVER_NAME_UNREADABLE");
  }

  const dedupeKeys: ReceiptDedupeKey[] = [];
  if (parsed.reference.value) {
    dedupeKeys.push({
      key: `${parsed.provider}:${parsed.reference.value}`,
      providerKey: parsed.provider,
      duplicateFlag: "DUPLICATE_REF",
    });
  }
  if (parsed.railReference.value) {
    dedupeKeys.push({
      key: `instapay:${parsed.railReference.value}`,
      providerKey: "instapay",
      duplicateFlag: "DUPLICATE_INSTAPAY_REF",
    });
  }
  return {
    provider: parsed.provider,
    destinationProvider: "gcash",
    parserVersion: parsed.parserVersion,
    flags,
    recipientComparison,
    dedupeKeys,
  };
}
