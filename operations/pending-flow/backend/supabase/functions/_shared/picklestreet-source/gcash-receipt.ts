import {
  extractReceiptAmount,
  type ReceiptAmountExtraction,
} from "./receipt-amount.ts";

export type GcashFieldSource =
  | "ref_label"
  | "standalone"
  | "recipient_block"
  | "missing";

export type GcashFieldConfidence = "high" | "medium" | "low";

export type GcashTypedReferenceMatch =
  | "match"
  | "mismatch"
  | "typed_invalid"
  | "not_provided"
  | "ocr_missing";

export type GcashReferenceField = {
  value: string | null;
  raw: string | null;
  source: GcashFieldSource;
  lineIndex: number | null;
  confidence: GcashFieldConfidence;
  typedMatch: GcashTypedReferenceMatch;
};

export type GcashTimestamp = {
  raw: string | null;
  date: string | null;
  time24: string | null;
  zone: "Asia/Manila";
  instant: string | null;
  completeness: "date_time" | "date_only" | "missing" | "invalid";
  lineIndex: number | null;
};

export type GcashPhoneField = {
  raw: string | null;
  normalized: string | null;
  last4: string | null;
  visibility: "full" | "masked" | "missing";
  source: "recipient_block" | "missing";
  lineIndex: number | null;
  confidence: GcashFieldConfidence;
};

export type GcashNameField = {
  raw: string | null;
  tokens: string[];
  visibility: "full" | "masked" | "initials" | "missing";
  source: "recipient_block" | "missing";
  lineIndex: number | null;
  confidence: GcashFieldConfidence;
};

export type GcashReceiver = {
  phone: GcashPhoneField;
  name: GcashNameField;
};

export type GcashReceiptIndicators = {
  sentViaGcash: boolean;
  totalAmountSent: boolean;
  referenceLabel: boolean;
  amountLabel: boolean;
  competingProviders: Array<"bdopay" | "maya" | "bpi">;
  classification: "gcash" | "conflict" | "insufficient";
};

export type GcashReceiptIssue =
  | "AMBIGUOUS_REFERENCE"
  | "REFERENCE_MISSING"
  | "AMOUNT_MISSING"
  | "AMBIGUOUS_AMOUNT"
  | "CONFLICTING_PRIMARY_AMOUNTS"
  | "TIMESTAMP_INVALID"
  | "RECEIVER_PHONE_MISSING"
  | "RECEIVER_NAME_MISSING"
  | "COMPETING_PROVIDER"
  | "INSUFFICIENT_GCASH_INDICATORS";

export type GcashReceiptParse = {
  provider: "gcash";
  reference: GcashReferenceField;
  amount: ReceiptAmountExtraction & {
    conflictingPrimaryAmounts: boolean;
    matchingPrimaryAmountDisplays: boolean;
  };
  timestamp: GcashTimestamp;
  receiver: GcashReceiver;
  indicators: GcashReceiptIndicators;
  issues: GcashReceiptIssue[];
};

export type GcashPhoneComparison =
  | "exact"
  | "last4_only"
  | "mismatch"
  | "missing"
  | "not_configured";

export type GcashNameComparison =
  | "exact"
  | "masked_compatible"
  | "mismatch"
  | "inconclusive"
  | "missing"
  | "not_configured";

export type GcashRecipientComparison = {
  phone: GcashPhoneComparison;
  name: GcashNameComparison;
  nameSupportingOnly: boolean;
};

export type ParseGcashReceiptOptions = {
  typedReference?: string;
};

export type ExpectedGcashRecipient = {
  phone?: string;
  name?: string;
};

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const REFERENCE_LABEL_RE =
  /\bref(?:erence)?(?:\s*(?:no|number))?\.?\s*(?:[:#]\s*)?/i;
const SENT_VIA_GCASH_RE = /\bsent\s+(?:via|through)\s+g\s*cash\b/i;
const TOTAL_AMOUNT_SENT_RE = /\btotal\s+amount\s+sent\b/i;
const AMOUNT_LABEL_RE = /\bamount\b/i;
const FULL_MOBILE_RE =
  /(?<!\d)(?:(?:\+?\s*63)\s*|0\s*)?9(?:[\s-]*\d){9}(?![\s-]*\d)/gi;
const MASKED_MOBILE_RE =
  /(?<!\d)(?:(?:\+?\s*63)\s*|0\s*)?9[\d\s\-•‣●◦∙·*xX#._]{4,32}\d(?!\d)/i;
const NAME_MASK_RE = /[•‣●◦∙·*#]|\.\.|[xX]{2,}/;

function normalizeText(rawText: string): string {
  return String(rawText || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\r\n?/g, "\n");
}

function receiptLines(rawText: string): string[] {
  return normalizeText(rawText).split("\n").map((line) =>
    line.replace(/[ \t]+/g, " ").trim()
  );
}

function digitsOnly(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeGcashMobile(value: string): string | null {
  let digits = digitsOnly(value);
  if (digits.startsWith("63")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return /^9\d{9}$/.test(digits) ? digits : null;
}

function numericClusters(value: string): Array<{ raw: string; value: string }> {
  const clusters = value.match(/\d[\d \t-]*\d|\d/g) || [];
  return clusters.map((raw) => ({ raw, value: digitsOnly(raw) }));
}

type ReferenceCandidate = {
  raw: string;
  value: string;
  lineIndex: number;
};

function nextNonEmptyLineIndex(
  lines: string[],
  lineIndex: number,
): number | null {
  for (let index = lineIndex + 1; index < lines.length; index++) {
    if (lines[index]) return index;
  }
  return null;
}

function typedReferenceMatch(
  parsedReference: string | null,
  typedReference: string | undefined,
): GcashTypedReferenceMatch {
  if (!String(typedReference || "").trim()) return "not_provided";
  const typed = digitsOnly(String(typedReference));
  if (typed.length !== 13) return "typed_invalid";
  if (!parsedReference) return "ocr_missing";
  return parsedReference === typed ? "match" : "mismatch";
}

function uniqueReferenceCandidates(
  candidates: ReferenceCandidate[],
): ReferenceCandidate[] {
  const byValue = new Map<string, ReferenceCandidate>();
  for (const candidate of candidates) {
    if (!byValue.has(candidate.value)) {
      byValue.set(candidate.value, candidate);
    }
  }
  return [...byValue.values()];
}

function parseReference(
  lines: string[],
  typedReference: string | undefined,
): {
  field: GcashReferenceField;
  ambiguous: boolean;
} {
  const labeled: ReferenceCandidate[] = [];

  lines.forEach((line, lineIndex) => {
    const label = line.match(REFERENCE_LABEL_RE);
    if (!label) return;

    const afterLabel = line.slice((label.index || 0) + label[0].length);
    for (const candidate of numericClusters(afterLabel)) {
      if (candidate.value.length === 13) {
        labeled.push({ ...candidate, lineIndex });
      }
    }

    if (labeled.some((candidate) => candidate.lineIndex === lineIndex)) return;
    const nextIndex = nextNonEmptyLineIndex(lines, lineIndex);
    if (nextIndex == null) return;
    for (const candidate of numericClusters(lines[nextIndex])) {
      if (candidate.value.length === 13) {
        labeled.push({ ...candidate, lineIndex: nextIndex });
      }
    }
  });

  const uniqueLabeled = uniqueReferenceCandidates(labeled);
  if (uniqueLabeled.length === 1) {
    const candidate = uniqueLabeled[0];
    return {
      field: {
        value: candidate.value,
        raw: candidate.raw,
        source: "ref_label",
        lineIndex: candidate.lineIndex,
        confidence: "high",
        typedMatch: typedReferenceMatch(candidate.value, typedReference),
      },
      ambiguous: false,
    };
  }
  if (uniqueLabeled.length > 1) {
    return {
      field: {
        value: null,
        raw: null,
        source: "missing",
        lineIndex: null,
        confidence: "low",
        typedMatch: typedReferenceMatch(null, typedReference),
      },
      ambiguous: true,
    };
  }

  const standalone: ReferenceCandidate[] = [];
  lines.forEach((line, lineIndex) => {
    for (const candidate of numericClusters(line)) {
      if (candidate.value.length === 13) {
        standalone.push({ ...candidate, lineIndex });
      }
    }
  });
  const uniqueStandalone = uniqueReferenceCandidates(standalone);
  if (uniqueStandalone.length === 1) {
    const candidate = uniqueStandalone[0];
    return {
      field: {
        value: candidate.value,
        raw: candidate.raw,
        source: "standalone",
        lineIndex: candidate.lineIndex,
        confidence: "medium",
        typedMatch: typedReferenceMatch(candidate.value, typedReference),
      },
      ambiguous: false,
    };
  }

  return {
    field: {
      value: null,
      raw: null,
      source: "missing",
      lineIndex: null,
      confidence: "low",
      typedMatch: typedReferenceMatch(null, typedReference),
    },
    ambiguous: uniqueStandalone.length > 1,
  };
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day;
}

function timestampLineIndex(lines: string[]): number | null {
  const datePattern =
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i;
  const index = lines.findIndex((line) => datePattern.test(line));
  return index >= 0 ? index : null;
}

function parseTimestamp(text: string, lines: string[]): GcashTimestamp {
  const flat = text.replace(/[|]/g, " ").replace(/\s+/g, " ").trim();
  const datePattern =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[\s,.\-]+(\d{4})\b/i;
  const dateMatch = flat.match(datePattern);
  const lineIndex = timestampLineIndex(lines);
  const base: Pick<GcashTimestamp, "zone" | "lineIndex"> = {
    zone: "Asia/Manila",
    lineIndex,
  };
  if (!dateMatch) {
    return {
      ...base,
      raw: null,
      date: null,
      time24: null,
      instant: null,
      completeness: "missing",
    };
  }

  const month = MONTHS[dateMatch[1].toLowerCase().slice(0, 3)];
  const day = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);
  if (
    month == null || !Number.isInteger(day) || !Number.isInteger(year) ||
    !validCalendarDate(year, month, day)
  ) {
    return {
      ...base,
      raw: dateMatch[0],
      date: null,
      time24: null,
      instant: null,
      completeness: "invalid",
    };
  }

  const date = `${year}-${String(month + 1).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
  const dateEnd = (dateMatch.index || 0) + dateMatch[0].length;
  const afterDate = flat.slice(dateEnd, dateEnd + 80);
  const beforeDate = flat.slice(
    Math.max(0, (dateMatch.index || 0) - 40),
    dateMatch.index || 0,
  );
  const timePattern =
    /\b(\d{1,2})\s*[:;.]\s*(\d{2})(?:\s*[:;.]\s*\d{2})?\s*([ap](?:\s*\.?\s*m\.?)?|[ap])\b/i;
  const timeMatch = afterDate.match(timePattern) ||
    beforeDate.match(timePattern);
  if (!timeMatch) {
    return {
      ...base,
      raw: dateMatch[0],
      date,
      time24: null,
      instant: null,
      completeness: "date_only",
    };
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3].toLowerCase().replace(/[^apm]/g, "");
  if (
    !Number.isInteger(hour) || hour < 1 || hour > 12 ||
    !Number.isInteger(minute) || minute < 0 || minute > 59
  ) {
    return {
      ...base,
      raw: `${dateMatch[0]} ${timeMatch[0]}`,
      date,
      time24: null,
      instant: null,
      completeness: "invalid",
    };
  }
  if (meridiem.startsWith("p") && hour !== 12) hour += 12;
  if (meridiem.startsWith("a") && hour === 12) hour = 0;

  const time24 = `${String(hour).padStart(2, "0")}:${
    String(minute).padStart(2, "0")
  }`;
  const instant = new Date(
    Date.UTC(year, month, day, hour - 8, minute, 0),
  ).toISOString();
  return {
    ...base,
    raw: `${dateMatch[0]} ${timeMatch[0]}`,
    date,
    time24,
    instant,
    completeness: "date_time",
  };
}

function previousNonEmptyIndexes(
  lines: string[],
  beforeIndex: number,
  limit: number,
): number[] {
  const indexes: number[] = [];
  for (let index = beforeIndex - 1; index >= 0; index--) {
    if (!lines[index]) continue;
    indexes.push(index);
    if (indexes.length >= limit) break;
  }
  return indexes;
}

function parsePhoneLine(
  line: string,
  lineIndex: number,
): GcashPhoneField | null {
  FULL_MOBILE_RE.lastIndex = 0;
  for (const match of line.matchAll(FULL_MOBILE_RE)) {
    const raw = match[0].trim();
    const normalized = normalizeGcashMobile(raw);
    if (!normalized) continue;
    return {
      raw,
      normalized,
      last4: normalized.slice(-4),
      visibility: "full",
      source: "recipient_block",
      lineIndex,
      confidence: "high",
    };
  }

  const masked = line.match(MASKED_MOBILE_RE);
  if (masked && NAME_MASK_RE.test(masked[0])) {
    const raw = masked[0].trim();
    const visibleDigits = digitsOnly(raw);
    return {
      raw,
      normalized: null,
      last4: visibleDigits.length >= 4 ? visibleDigits.slice(-4) : null,
      visibility: "masked",
      source: "recipient_block",
      lineIndex,
      confidence: "medium",
    };
  }
  return null;
}

function nameTokens(raw: string): string[] {
  return raw.split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

function nameVisibility(raw: string): GcashNameField["visibility"] {
  if (NAME_MASK_RE.test(raw)) return "masked";
  const tokens = nameTokens(raw);
  if (tokens.length && tokens.some((token) => /^[A-Za-z]\.$/.test(token))) {
    return "initials";
  }
  return "full";
}

function plausibleRecipientName(line: string): boolean {
  if (!line || line.length > 100 || !/[A-Za-z]/.test(line)) return false;
  if (
    REFERENCE_LABEL_RE.test(line) || SENT_VIA_GCASH_RE.test(line) ||
    TOTAL_AMOUNT_SENT_RE.test(line) || /\bamount\b/i.test(line) ||
    /\b(?:jul|jan|feb|mar|apr|may|jun|aug|sep|oct|nov|dec)\b/i
      .test(line) ||
    /(?:PHP|₱|\d{2,})/i.test(line)
  ) return false;
  return true;
}

function missingPhone(): GcashPhoneField {
  return {
    raw: null,
    normalized: null,
    last4: null,
    visibility: "missing",
    source: "missing",
    lineIndex: null,
    confidence: "low",
  };
}

function missingName(): GcashNameField {
  return {
    raw: null,
    tokens: [],
    visibility: "missing",
    source: "missing",
    lineIndex: null,
    confidence: "low",
  };
}

function parseReceiver(lines: string[]): GcashReceiver {
  const anchorIndexes = lines.map((line, index) =>
    SENT_VIA_GCASH_RE.test(line) ? index : -1
  ).filter((index) => index >= 0);

  for (const anchorIndex of anchorIndexes) {
    const preceding = previousNonEmptyIndexes(lines, anchorIndex, 6);
    let phone: GcashPhoneField | null = null;
    for (const lineIndex of preceding) {
      phone = parsePhoneLine(lines[lineIndex], lineIndex);
      if (phone) break;
    }
    if (!phone || phone.lineIndex == null) continue;

    let name = missingName();
    const nameIndexes = previousNonEmptyIndexes(lines, phone.lineIndex, 3);
    for (const lineIndex of nameIndexes) {
      const line = lines[lineIndex];
      if (!plausibleRecipientName(line)) continue;
      name = {
        raw: line,
        tokens: nameTokens(line),
        visibility: nameVisibility(line),
        source: "recipient_block",
        lineIndex,
        confidence: "high",
      };
      break;
    }
    return { phone, name };
  }

  return { phone: missingPhone(), name: missingName() };
}

function hasBdoPayIndicator(text: string): boolean {
  return /\bbdo\s*pay\b/i.test(text) ||
    /\bthank\s+you\s+for\s+using\s+bdo\b/i.test(text) ||
    /\bbn[\s-]*\d{8}[\s-]*\d{8}\b/i.test(text);
}

function hasMayaIndicator(text: string): boolean {
  return /\bmaya\b/i.test(text) &&
    (
      /\bsent\s+money\s+via\b/i.test(text) ||
      /\breference\s+id\b/i.test(text) ||
      /\binsta\s*pay\b|\bqr\s*ph\b|\bqrph\b/i.test(text)
    );
}

function hasBpiIndicator(text: string): boolean {
  return /\bsent\s+via\s+bpi\b/i.test(text) ||
    /\btransfer\s+successful\b[\s\S]*\bbpi\b/i.test(text) ||
    /\bbpi\s+online\b/i.test(text);
}

function parseIndicators(text: string): GcashReceiptIndicators {
  const sentViaGcash = SENT_VIA_GCASH_RE.test(text);
  const totalAmountSent = TOTAL_AMOUNT_SENT_RE.test(text);
  const referenceLabel = REFERENCE_LABEL_RE.test(text);
  const amountLabel = AMOUNT_LABEL_RE.test(text);
  const competingProviders: GcashReceiptIndicators["competingProviders"] = [];
  if (hasBdoPayIndicator(text)) competingProviders.push("bdopay");
  if (hasMayaIndicator(text)) competingProviders.push("maya");
  if (hasBpiIndicator(text)) competingProviders.push("bpi");

  const hasGcashLayout = sentViaGcash ||
    (totalAmountSent && referenceLabel);
  const classification = competingProviders.length
    ? "conflict"
    : hasGcashLayout
    ? "gcash"
    : "insufficient";
  return {
    sentViaGcash,
    totalAmountSent,
    referenceLabel,
    amountLabel,
    competingProviders,
    classification,
  };
}

function conflictingPrimaryAmounts(
  amount: ReceiptAmountExtraction,
): boolean {
  const primary = amount.candidates.filter((candidate) =>
    !candidate.excluded &&
    (
      candidate.evidence.includes("amount_label") ||
      candidate.evidence.includes("total_label") ||
      candidate.evidence.includes("gcash_amount_block_observation")
    )
  );
  return new Set(primary.map((candidate) => candidate.amount)).size > 1;
}

function matchingPrimaryAmountDisplays(
  amount: ReceiptAmountExtraction,
): boolean {
  if (amount.amount == null) return false;
  const matchingLocations = new Set(
    amount.candidates
      .filter((candidate) =>
        !candidate.excluded && candidate.amount === amount.amount &&
        (
          candidate.evidence.includes("amount_label") ||
          candidate.evidence.includes("total_label") ||
          candidate.evidence.includes("gcash_concordant_amount_block")
        )
      )
      .map((candidate) => candidate.lineIndex),
  );
  return matchingLocations.size >= 2;
}

function normalizedExpectedNameTokens(expectedName: string): string[] {
  return String(expectedName || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
}

type ObservedNameToken = {
  pattern: string;
  initial: boolean;
  masked: boolean;
  visibleLetters: number;
};

function observedNameToken(rawToken: string): ObservedNameToken | null {
  const folded = rawToken.normalize("NFKD").replace(/\p{M}/gu, "");
  const initial = /^[A-Za-z]\.$/.test(folded);
  let pattern = folded
    .replace(/[xX]{2,}/g, (run) => "*".repeat(run.length))
    .replace(/\.{2,}/g, (run) => "*".repeat(run.length))
    .replace(/[•‣●◦∙·#]/g, "*")
    .toUpperCase()
    .replace(/[^A-Z*]/g, "");
  if (initial) pattern = folded[0].toUpperCase();
  if (!pattern) return null;
  return {
    pattern,
    initial,
    masked: pattern.includes("*"),
    visibleLetters: (pattern.match(/[A-Z]/g) || []).length,
  };
}

function tokenCompatible(
  observed: ObservedNameToken,
  expected: string,
): boolean {
  if (observed.initial || (!observed.masked && observed.pattern.length === 1)) {
    return expected.startsWith(observed.pattern);
  }
  if (!observed.masked) return observed.pattern === expected;

  if (observed.pattern.length === expected.length) {
    for (let index = 0; index < observed.pattern.length; index++) {
      const visible = observed.pattern[index];
      if (visible !== "*" && visible !== expected[index]) return false;
    }
    return true;
  }

  const regexSource = observed.pattern
    .split(/\*+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regexSource}$`).test(expected);
}

function orderedTokenMapping(
  observed: ObservedNameToken[],
  expected: string[],
  observedIndex = 0,
  expectedIndex = 0,
): boolean {
  if (observedIndex >= observed.length) return true;
  const remainingObserved = observed.length - observedIndex;
  for (
    let index = expectedIndex;
    index <= expected.length - remainingObserved;
    index++
  ) {
    if (!tokenCompatible(observed[observedIndex], expected[index])) continue;
    if (
      orderedTokenMapping(observed, expected, observedIndex + 1, index + 1)
    ) return true;
  }
  return false;
}

export function compareGcashMaskedName(
  observedRaw: string | null | undefined,
  expectedRaw: string | null | undefined,
): GcashNameComparison {
  const expected = normalizedExpectedNameTokens(String(expectedRaw || ""));
  if (!expected.length) return "not_configured";
  const raw = String(observedRaw || "").trim();
  if (!raw) return "missing";

  const rawTokens = nameTokens(raw);
  const observed = rawTokens.map(observedNameToken).filter(
    (token): token is ObservedNameToken => token !== null,
  );
  if (!observed.length) return "missing";

  const anyMasked = observed.some((token) => token.masked || token.initial);
  if (!anyMasked) {
    return observed.map((token) => token.pattern).join(" ") ===
        expected.join(" ")
      ? "exact"
      : "mismatch";
  }

  const compatible = observed.length === expected.length
    ? observed.every((token, index) => tokenCompatible(token, expected[index]))
    : orderedTokenMapping(observed, expected);
  const visibleLetters = observed.reduce(
    (sum, token) => sum + token.visibleLetters,
    0,
  );
  if (!compatible) {
    return visibleLetters >= 3 ? "mismatch" : "inconclusive";
  }
  return visibleLetters >= 3 && observed.length >= 2
    ? "masked_compatible"
    : "inconclusive";
}

function comparePhone(
  observed: GcashPhoneField,
  expectedRaw: string | undefined,
): GcashPhoneComparison {
  const expectedProvided = String(expectedRaw || "").trim();
  if (!expectedProvided) return "not_configured";
  const expected = normalizeGcashMobile(expectedProvided);
  if (!expected) return "not_configured";
  if (observed.visibility === "missing") return "missing";
  if (observed.normalized) {
    return observed.normalized === expected ? "exact" : "mismatch";
  }
  if (observed.last4) {
    return observed.last4 === expected.slice(-4) ? "last4_only" : "mismatch";
  }
  return "missing";
}

export function compareGcashRecipient(
  receiver: GcashReceiver,
  expected: ExpectedGcashRecipient,
): GcashRecipientComparison {
  const name = compareGcashMaskedName(receiver.name.raw, expected.name);
  return {
    phone: comparePhone(receiver.phone, expected.phone),
    name,
    nameSupportingOnly: name === "masked_compatible" ||
      name === "inconclusive",
  };
}

export function parseGcashReceipt(
  rawText: string,
  options: ParseGcashReceiptOptions = {},
): GcashReceiptParse {
  const text = normalizeText(rawText);
  const lines = receiptLines(text);
  const referenceResult = parseReference(lines, options.typedReference);
  const baseAmount = extractReceiptAmount(text, { provider: "gcash" });
  const amount = {
    ...baseAmount,
    conflictingPrimaryAmounts: conflictingPrimaryAmounts(baseAmount),
    matchingPrimaryAmountDisplays: matchingPrimaryAmountDisplays(baseAmount),
  };
  const timestamp = parseTimestamp(text, lines);
  const receiver = parseReceiver(lines);
  const indicators = parseIndicators(text);
  const issues: GcashReceiptIssue[] = [];

  if (referenceResult.ambiguous) issues.push("AMBIGUOUS_REFERENCE");
  else if (!referenceResult.field.value) issues.push("REFERENCE_MISSING");
  if (amount.amount == null) issues.push("AMOUNT_MISSING");
  if (amount.ambiguous) issues.push("AMBIGUOUS_AMOUNT");
  if (amount.conflictingPrimaryAmounts) {
    issues.push("CONFLICTING_PRIMARY_AMOUNTS");
  }
  if (timestamp.completeness === "invalid") issues.push("TIMESTAMP_INVALID");
  if (receiver.phone.visibility === "missing") {
    issues.push("RECEIVER_PHONE_MISSING");
  }
  if (receiver.name.visibility === "missing") {
    issues.push("RECEIVER_NAME_MISSING");
  }
  if (indicators.classification === "conflict") {
    issues.push("COMPETING_PROVIDER");
  } else if (indicators.classification === "insufficient") {
    issues.push("INSUFFICIENT_GCASH_INDICATORS");
  }

  return {
    provider: "gcash",
    reference: referenceResult.field,
    amount,
    timestamp,
    receiver,
    indicators,
    issues,
  };
}
