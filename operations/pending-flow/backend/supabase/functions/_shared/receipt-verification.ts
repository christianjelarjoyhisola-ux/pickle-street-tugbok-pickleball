import { RequestError } from "./http.ts";
import { normalizeTenantSlug } from "./tenant.ts";
import { Temporal } from "@js-temporal/polyfill";

export const RECEIPT_BUCKET = "tenant-private";
export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
export const GOOGLE_VISION_TIMEOUT_MS = 15_000;
export const RECEIPT_PAYMENT_WINDOW_MINUTES = 10;
export const RECEIPT_EARLY_TOLERANCE_MINUTES = 2;

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_EXPRESSION = new RegExp(`^${UUID_PATTERN}$`);
const RECEIPT_PATH_EXPRESSION = new RegExp(
  `^(${UUID_PATTERN})/receipts/(${UUID_PATTERN})/(${UUID_PATTERN})\\.(jpg|jpeg|png|webp)$`,
);
const REQUEST_KEYS = new Set([
  "tenantSlug",
  "bookingReference",
  "storagePath",
  "paymentSessionId",
]);

export type ReceiptVerificationRequest = {
  tenantSlug: string;
  bookingReference: string;
  storagePath: string;
  paymentSessionId: string | null;
};

export type ReceiptObjectPath = {
  tenantId: string;
  bookingId: string;
  objectId: string;
  extension: "jpg" | "jpeg" | "png" | "webp";
  folder: string;
  filename: string;
};

export type InspectedReceiptImage = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
};

export type VisionTextResult = {
  text: string;
  confidence: number | null;
};

export type SafeReceiptExtraction = {
  schemaVersion: 2;
  provider: "google_vision";
  feature: "DOCUMENT_TEXT_DETECTION";
  ocrCharacterCount: number;
  file: {
    mimeType: InspectedReceiptImage["mimeType"];
    sizeBytes: number;
  };
  detected: {
    amounts: number[];
    paymentReference?: string;
  };
  comparison: {
    expectedAmount: number;
    currency: string;
    amountMatched: boolean;
  };
  timing: {
    receiptDate: string | null;
    receiptTime: string | null;
    receiptDateTime: string | null;
    bookingStartedAt: string;
    tenantTimezone: string;
    ageMinutes: number | null;
    allowedWindowMinutes: number;
    earlyToleranceMinutes: number;
    withinWindow: boolean;
  };
  confidence: {
    vision: number | null;
    evidence: number;
    effective: number;
    source: "google_vision_plus_evidence" | "evidence_only";
  };
};

export type ReceiptPaymentContext = {
  paymentMethod: string;
  submittedReference: string;
  receiverName: string;
  receiverReference: string;
  autoApprovalEnabled?: boolean;
};

export type ReceiptTimingContext = {
  bookingStartedAt: string;
  tenantTimezone: string;
  paymentWindowMinutes?: number;
  earlyToleranceMinutes?: number;
};

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function requiredText(
  value: unknown,
  code: string,
  message: string,
): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new RequestError(400, code, message);
  return result;
}

export function parseReceiptVerificationRequest(
  body: Record<string, unknown>,
): ReceiptVerificationRequest {
  const unknownKeys = Object.keys(body).filter((key) => !REQUEST_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new RequestError(
      400,
      "RECEIPT_REQUEST_INVALID",
      "The receipt verification request contains unsupported fields.",
    );
  }

  const tenantSlug = normalizeTenantSlug(body.tenantSlug);
  const bookingReference = requiredText(
    body.bookingReference,
    "BOOKING_REFERENCE_INVALID",
    "A valid booking reference is required.",
  ).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(bookingReference)) {
    throw new RequestError(
      400,
      "BOOKING_REFERENCE_INVALID",
      "A valid booking reference is required.",
    );
  }

  const storagePath = requiredText(
    body.storagePath,
    "RECEIPT_PATH_INVALID",
    "A valid private receipt object path is required.",
  );
  // Parsing here deliberately rejects URLs, base64/data URLs, traversal,
  // percent-encoding, and arbitrary object categories.
  parseReceiptObjectPath(storagePath);

  let paymentSessionId: string | null = null;
  if (body.paymentSessionId !== undefined && body.paymentSessionId !== null) {
    paymentSessionId = requiredText(
      body.paymentSessionId,
      "PAYMENT_SESSION_INVALID",
      "The payment session identifier is invalid.",
    ).toLowerCase();
    if (!UUID_EXPRESSION.test(paymentSessionId)) {
      throw new RequestError(
        400,
        "PAYMENT_SESSION_INVALID",
        "The payment session identifier is invalid.",
      );
    }
  }

  return { tenantSlug, bookingReference, storagePath, paymentSessionId };
}

export function parseReceiptObjectPath(value: unknown): ReceiptObjectPath {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path || path.length > 240 || path !== path.toLowerCase()) {
    throw new RequestError(
      400,
      "RECEIPT_PATH_INVALID",
      "A valid private receipt object path is required.",
    );
  }
  const match = RECEIPT_PATH_EXPRESSION.exec(path);
  if (!match) {
    throw new RequestError(
      400,
      "RECEIPT_PATH_INVALID",
      "A valid private receipt object path is required.",
    );
  }

  const [, tenantId, bookingId, objectId, extensionValue] = match;
  const extension = extensionValue as ReceiptObjectPath["extension"];
  const folder = `${tenantId}/receipts/${bookingId}`;
  return {
    tenantId,
    bookingId,
    objectId,
    extension,
    folder,
    filename: `${objectId}.${extension}`,
  };
}

function normalizeMimeType(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function validateReceiptObjectMetadata(
  sizeValue: unknown,
  mimeTypeValue: unknown,
): { sizeBytes: number; mimeType: string } {
  const sizeBytes = typeof sizeValue === "number"
    ? sizeValue
    : Number(sizeValue);
  const mimeType = normalizeMimeType(mimeTypeValue);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new RequestError(
      422,
      "RECEIPT_FILE_INVALID",
      "The stored receipt file metadata is invalid.",
    );
  }
  if (sizeBytes > MAX_RECEIPT_BYTES) {
    throw new RequestError(
      413,
      "RECEIPT_FILE_TOO_LARGE",
      "The receipt image exceeds the 8 MB limit.",
    );
  }
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(mimeType)) {
    throw new RequestError(
      415,
      "RECEIPT_FILE_TYPE_INVALID",
      "The receipt must be a JPEG, PNG, or WebP image.",
    );
  }
  return { sizeBytes, mimeType };
}

function hasBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  return [...value].every((character, index) =>
    bytes[offset + index] === character.charCodeAt(0)
  );
}

export function inspectReceiptImage(
  bytes: Uint8Array,
  path: ReceiptObjectPath,
  metadataMimeType: unknown,
  downloadedMimeType: unknown,
): InspectedReceiptImage {
  if (bytes.byteLength <= 0) {
    throw new RequestError(
      422,
      "RECEIPT_FILE_INVALID",
      "The stored receipt image is empty.",
    );
  }
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw new RequestError(
      413,
      "RECEIPT_FILE_TOO_LARGE",
      "The receipt image exceeds the 8 MB limit.",
    );
  }

  let mimeType: InspectedReceiptImage["mimeType"] | null = null;
  if (
    bytes.length >= 4 && hasBytes(bytes, 0, [0xff, 0xd8, 0xff]) &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  ) {
    mimeType = "image/jpeg";
  } else if (
    bytes.length >= 24 &&
    hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    asciiAt(bytes, 12, "IHDR")
  ) {
    mimeType = "image/png";
  } else if (
    bytes.length >= 16 && asciiAt(bytes, 0, "RIFF") &&
    asciiAt(bytes, 8, "WEBP")
  ) {
    mimeType = "image/webp";
  }

  if (!mimeType) {
    throw new RequestError(
      415,
      "RECEIPT_FILE_TYPE_INVALID",
      "The stored object is not a supported receipt image.",
    );
  }

  const expectedMime = path.extension === "png"
    ? "image/png"
    : path.extension === "webp"
    ? "image/webp"
    : "image/jpeg";
  const declaredTypes = [metadataMimeType, downloadedMimeType]
    .map(normalizeMimeType)
    .filter(Boolean);
  if (
    mimeType !== expectedMime ||
    declaredTypes.some((declared) => declared !== mimeType)
  ) {
    throw new RequestError(
      415,
      "RECEIPT_FILE_TYPE_MISMATCH",
      "The receipt extension, metadata, and file contents do not match.",
    );
  }

  return { mimeType, sizeBytes: bytes.byteLength };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = Uint8Array.from(bytes).buffer;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput),
  );
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)),
    );
  }
  return btoa(chunks.join(""));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function averageVisionConfidence(annotation: Record<string, unknown>) {
  const values: number[] = [];
  const pages = Array.isArray(annotation.pages) ? annotation.pages : [];
  for (const pageValue of pages) {
    const page = objectValue(pageValue);
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    for (const blockValue of blocks) {
      const block = objectValue(blockValue);
      const paragraphs = Array.isArray(block.paragraphs)
        ? block.paragraphs
        : [];
      for (const paragraphValue of paragraphs) {
        const paragraph = objectValue(paragraphValue);
        const words = Array.isArray(paragraph.words) ? paragraph.words : [];
        for (const wordValue of words) {
          const confidence = Number(objectValue(wordValue).confidence);
          if (
            Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ) {
            values.push(confidence);
          }
        }
      }
    }
  }
  if (values.length === 0) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round(average * 10_000) / 10_000;
}

export async function detectReceiptText(options: {
  bytes: Uint8Array;
  apiKey: string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  feature?: "DOCUMENT_TEXT_DETECTION" | "TEXT_DETECTION";
}): Promise<VisionTextResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("GOOGLE_VISION_API_KEY is not configured.");
  if (
    options.bytes.byteLength <= 0 ||
    options.bytes.byteLength > MAX_RECEIPT_BYTES
  ) {
    throw new RequestError(
      422,
      "RECEIPT_FILE_INVALID",
      "The receipt image cannot be processed.",
    );
  }

  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `https://vision.googleapis.com/v1/images:annotate?key=${
        encodeURIComponent(apiKey)
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content: bytesToBase64(options.bytes) },
            // Receipt screenshots are dense documents. This mode returns the
            // same recognized text plus word-level confidence when Vision can
            // calculate it.
            features: [{
              type: options.feature ?? "DOCUMENT_TEXT_DETECTION",
              maxResults: 1,
            }],
            imageContext: { languageHints: ["en"] },
          }],
        }),
        signal: options.signal ?? AbortSignal.timeout(GOOGLE_VISION_TIMEOUT_MS),
      },
    );
  } catch {
    throw new RequestError(
      502,
      "VISION_UNAVAILABLE",
      "Receipt text verification is temporarily unavailable.",
    );
  }

  if (!response.ok) {
    throw new RequestError(
      response.status === 429 ? 503 : 502,
      "VISION_UNAVAILABLE",
      "Receipt text verification is temporarily unavailable.",
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = objectValue(await response.json());
  } catch {
    throw new RequestError(
      502,
      "VISION_RESPONSE_INVALID",
      "Receipt text verification returned an invalid response.",
    );
  }
  const responses = Array.isArray(payload.responses) ? payload.responses : [];
  const annotationResponse = objectValue(responses[0]);
  if (Object.keys(objectValue(annotationResponse.error)).length > 0) {
    throw new RequestError(
      502,
      "VISION_UNAVAILABLE",
      "Receipt text verification is temporarily unavailable.",
    );
  }

  const fullText = objectValue(annotationResponse.fullTextAnnotation);
  const textAnnotations = Array.isArray(annotationResponse.textAnnotations)
    ? annotationResponse.textAnnotations
    : [];
  const fallback = objectValue(textAnnotations[0]);
  const textValue = typeof fullText.text === "string"
    ? fullText.text
    : typeof fallback.description === "string"
    ? fallback.description
    : "";
  // OCR text stays in memory only and is bounded before any parsing.
  const text = textValue.slice(0, 100_000);
  return { text, confidence: averageVisionConfidence(fullText) };
}

function extractAmounts(text: string): number[] {
  const matches: number[] = [];
  const patterns = [
    /(?:PHP|PHP\s|₱|\bP)\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/giu,
    /\b(?:amount|total|paid|sent)\s*[:#-]?\s*(?:PHP|₱|P)?\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const amount = Number(match[1].replaceAll(",", ""));
      if (
        Number.isFinite(amount) && amount > 0 && amount <= 10_000_000 &&
        !matches.some((existing) => Math.abs(existing - amount) < 0.005)
      ) {
        matches.push(Math.round(amount * 100) / 100);
      }
      if (matches.length >= 10) return matches;
    }
  }
  return matches;
}

function extractPaymentReferences(text: string): string[] {
  const pattern =
    /\b(?:reference|ref(?:erence)?(?:\s*(?:no\.?|number))?|transaction(?:\s*(?:id|no\.?|number))?)\s*[:#-]?\s*([a-z0-9][a-z0-9-]{5,63})\b/giu;
  const references: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1].toUpperCase();
    if (/\d/.test(candidate) && !references.includes(candidate)) {
      references.push(candidate);
    }
  }
  return references;
}

function extractInstaPayReferences(text: string): string[] {
  const pattern =
    /\binsta\s*pay\s+reference(?:\s*(?:no\.?|number))?\s*[:#-]?\s*([a-z0-9][a-z0-9-]{5,63})\b/giu;
  return [...text.matchAll(pattern)]
    .map((match) => match[1].toUpperCase())
    .filter((candidate, index, references) =>
      /\d/.test(candidate) && references.indexOf(candidate) === index
    );
}

function extractPaymentReference(text: string): string | undefined {
  return extractInstaPayReferences(text)[0] ??
    extractPaymentReferences(text)[0];
}

function normalizeReference(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function expectedReferenceInText(
  text: string,
  expectedReference: string,
  paymentMethod: string,
): string | null {
  const expected = normalizeReference(expectedReference);
  if (expected.length < 6) return null;

  if (paymentMethod === "gcash" && /^\d{13}$/.test(expected)) {
    const flexibleDigits = new RegExp(
      expected.split("").join("[^0-9]{0,3}"),
    );
    return flexibleDigits.test(text) ? expected : null;
  }

  // GoTyme references must be read from a labelled receipt field. Merely
  // finding the submitted value elsewhere in the OCR text is not enough to
  // prove that it is the transfer reference.
  if (paymentMethod === "gotyme") {
    const instaPayReferences = extractInstaPayReferences(text);
    const candidates = instaPayReferences.length > 0
      ? instaPayReferences
      : extractPaymentReferences(text);
    return candidates.some((candidate) =>
        normalizeReference(candidate) === expected
      )
      ? expected
      : null;
  }

  for (const line of text.split(/\r?\n/)) {
    if (normalizeReference(line).includes(expected)) return expected;
  }
  return null;
}

const COMPETING_DESTINATION_PROVIDER_PATTERN =
  /\b(?:g\s*cash|maya\s+bank|paymaya|bdo(?:\s+pay)?|banco\s+de\s+oro|bpi|bank\s+of\s+the\s+philippine\s+islands|union\s*bank|metrobank|metropolitan\s+bank|landbank|rcbc|security\s+bank|east\s*west|cimb|seabank|tonik|shopee\s*pay|grab\s*pay|coins\.ph)\b/i;

function paymentMethodMatched(text: string, paymentMethod: string): boolean {
  if (paymentMethod === "gcash") {
    return /\bsent\s+(?:via|through)\s+gcash\b|\bgcash\s+receipt\b|\btotal\s+amount\s+sent\b/i
      .test(text) &&
      !/\bbdo\s*pay\b|\bmaya\b|\bsent\s+via\s+bpi\b/i.test(text);
  }
  if (paymentMethod !== "gotyme") return false;

  const destinationBlock = gotymeDestinationAccountBlock(text);
  if (!destinationBlock) return false;
  const hasGoTymeDestination = /\bgo\s*tyme\s+bank(?:\s+corporation)?\b/i
    .test(destinationBlock);
  const withoutGoTymeName = destinationBlock.replace(
    /\bgo\s*tyme\s+bank(?:\s+corporation)?\b/gi,
    "",
  );
  const hasCompetingDestination = COMPETING_DESTINATION_PROVIDER_PATTERN.test(
    withoutGoTymeName,
  );
  const hasSuccessfulTransfer =
    /\btransfer\s+(?:successful|completed|complete)\b|\bsuccessfully\s+transferred\b/i
      .test(text);
  const hasProcessedInstaPayTransfer =
    /\b(?:your\s+)?transaction\s+has\s+been\s+processed\b/i.test(text) &&
    /\bfund\s+transfer\s+via\s+insta\s*pay\b/i.test(text);
  return hasGoTymeDestination && !hasCompetingDestination &&
    (hasSuccessfulTransfer || hasProcessedInstaPayTransfer);
}

function normalizeMobile(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("63")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

function receiverReferenceMatched(
  text: string,
  expectedValue: string,
): boolean {
  const expected = normalizeMobile(expectedValue);
  if (expected.length !== 10 || !expected.startsWith("9")) return false;

  const exactPattern = new RegExp(expected.split("").join("[^0-9]{0,3}"));
  if (exactPattern.test(text.replace(/(?:\+?63|0)(?=9)/g, ""))) return true;

  const last4 = expected.slice(-4);
  return text.split(/\r?\n/).some((line) => {
    if (!line.includes(last4)) return false;
    const digits = line.replace(/\D/g, "");
    const looksMasked = /[*xX#\u2022]/.test(line) && digits.length >= 4;
    const looksDotMaskedPhone = new RegExp(
      `(?:\\+?63\\s*|0)?9\\d{0,2}[\\s-]*[.\\u00b7\\u2023\\u2043\\u2219\\u25e6][\\s\\-.*xX#\\u00b7\\u2022\\u2023\\u2043\\u2219\\u25e6]*${last4}\\b`,
      "i",
    ).test(line);
    const looksLikePhone = /(?:\+?63|0)?9\d{2}/.test(line) &&
      digits.length >= 7;
    return looksMasked || looksDotMaskedPhone || looksLikePhone;
  });
}

function receiverNameMatched(text: string, expectedValue: string): boolean {
  const textLetters = text.toUpperCase().replace(/[^A-Z]/g, "");
  const expectedWords = expectedValue.toUpperCase().match(/[A-Z]{3,}/g) ?? [];
  if (expectedWords.length === 0) return false;
  const fullName = expectedWords.join("");
  if (fullName.length >= 5 && textLetters.includes(fullName)) return true;
  return expectedWords.some((word) =>
    word.length >= 4 && textLetters.includes(word)
  );
}

const NON_IDENTITY_NAME_TOKENS = new Set([
  "MR",
  "MRS",
  "MS",
  "MISS",
  "DR",
  "ATTY",
  "ENGR",
  "JR",
  "SR",
  "II",
  "III",
  "IV",
  "INC",
  "CORP",
  "CORPORATION",
  "COMPANY",
  "LTD",
  "LLC",
]);

function normalizedNameTokens(value: string): string[] {
  const tokens = value.normalize("NFKD").toUpperCase().match(/[A-Z]{2,}/g) ??
    [];
  return [
    ...new Set(tokens.filter((token) => !NON_IDENTITY_NAME_TOKENS.has(token))),
  ];
}

function gotymeReceiverNameMatched(
  destinationBlock: string,
  expectedValue: string,
): boolean {
  const expectedTokens = normalizedNameTokens(expectedValue);
  if (expectedTokens.length === 0) return false;
  const receiptTokens = new Set(normalizedNameTokens(destinationBlock));
  return expectedTokens.every((token) => receiptTokens.has(token));
}

function gotymeDestinationAccountBlock(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line, index) =>
    /\bdestination\s+account\b/i.test(line) ||
    (/^\s*destination\b/i.test(line) &&
      /^\s*account\b/i.test(lines[index + 1] ?? ""))
  );
  if (start < 0) return null;

  const block = [lines[start]];
  const nextSection =
    /^(?:source|originating|sender)\s+account\b|^(?:transaction\s+(?:reference|type|date|time)|insta\s*pay\s+reference|amount|transfer\s+amount|fee|total|date|time)\b/i;
  // The production layout wraps the label across two lines, followed by the
  // receiver name, destination bank, and account number. Keep the block tight
  // so sender/source details elsewhere cannot satisfy a recipient gate.
  for (
    let index = start + 1;
    index < lines.length && block.length < 5;
    index++
  ) {
    const line = lines[index].trim();
    if (line && nextSection.test(line)) break;
    block.push(lines[index]);
  }
  return block.join("\n");
}

function gotymeReceiverAccountMatched(
  destinationBlock: string,
  expectedValue: string,
): boolean {
  const expectedDigits = expectedValue.replace(/\D/g, "");
  if (expectedDigits.length < 4) return false;

  const flexibleDigits = new RegExp(
    expectedDigits.split("").join("[^0-9]{0,3}"),
  );
  if (flexibleDigits.test(destinationBlock)) return true;

  return destinationBlock.split(/\r?\n/).some((line) => {
    const firstMask = line.search(/[*xX#\u2022]/);
    if (firstMask < 0) return false;
    const lastMask = Math.max(
      line.lastIndexOf("*"),
      line.lastIndexOf("x"),
      line.lastIndexOf("X"),
      line.lastIndexOf("#"),
      line.lastIndexOf("\u2022"),
    );
    const visiblePrefix = line.slice(0, firstMask).replace(/\D/g, "");
    const visibleSuffix = line.slice(lastMask + 1).replace(/\D/g, "");
    if (visiblePrefix.length + visibleSuffix.length < 4) return false;
    return (!visiblePrefix || expectedDigits.startsWith(visiblePrefix)) &&
      (!visibleSuffix || expectedDigits.endsWith(visibleSuffix));
  });
}

const RECEIPT_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

type ParsedReceiptTimestamp = {
  receiptDate: string | null;
  receiptTime: string | null;
  receiptDateTime: string | null;
};

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** Parse a supported receipt date/time without retaining the raw OCR response. */
function parseReceiptTimestamp(
  text: string,
  tenantTimezone: string,
): ParsedReceiptTimestamp {
  const normalized = text.replace(/[|]/g, " ").replace(/\s+/g, " ").trim();
  const monthPattern =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[\s,.\-]+(20\d{2})\b/i;
  const numericPattern = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2})\b/;
  const monthMatch = monthPattern.exec(normalized);
  const numericMatch = monthMatch ? null : numericPattern.exec(normalized);
  const dateMatch = monthMatch ?? numericMatch;
  if (!dateMatch) {
    return { receiptDate: null, receiptTime: null, receiptDateTime: null };
  }

  const year = Number(dateMatch[3]);
  const month = monthMatch
    ? RECEIPT_MONTHS[dateMatch[1].toLowerCase().slice(0, 3)]
    : Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const receiptDate = `${year}-${twoDigits(month)}-${twoDigits(day)}`;
  const dateIndex = dateMatch.index ?? 0;
  const nearby = normalized.slice(
    Math.max(0, dateIndex - 40),
    dateIndex + dateMatch[0].length + 100,
  );
  const timePattern =
    /\b(\d{1,2})\s*[:;.]\s*(\d{2})(?:\s*[:;.]\s*\d{2})?\s*([ap](?:\s*\.?\s*m\.?)?|[ap])\b/i;
  const timeMatch = timePattern.exec(nearby);
  if (!timeMatch) {
    return { receiptDate, receiptTime: null, receiptDateTime: null };
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3].toLowerCase().replace(/[^apm]/g, "");
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return { receiptDate, receiptTime: null, receiptDateTime: null };
  }
  if (meridiem.startsWith("p") && hour !== 12) hour += 12;
  if (meridiem.startsWith("a") && hour === 12) hour = 0;
  const receiptTime = `${twoDigits(hour)}:${twoDigits(minute)}`;

  try {
    const local = Temporal.PlainDateTime.from(
      `${receiptDate}T${receiptTime}:00`,
    );
    const receiptDateTime = local.toZonedDateTime(tenantTimezone, {
      disambiguation: "reject",
    }).toInstant().toString();
    return { receiptDate, receiptTime, receiptDateTime };
  } catch {
    return { receiptDate: null, receiptTime: null, receiptDateTime: null };
  }
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}

export function buildSafeReceiptExtraction(options: {
  vision: VisionTextResult;
  image: InspectedReceiptImage;
  expectedAmount: number;
  currency: string;
  payment?: ReceiptPaymentContext;
  timing: ReceiptTimingContext;
}): {
  extractedData: SafeReceiptExtraction;
  paymentReference: string | null;
  flags: string[];
  autoApprove: boolean;
} {
  const expectedAmount = Number(options.expectedAmount);
  const currency = options.currency.trim().toUpperCase();
  if (
    !Number.isFinite(expectedAmount) || expectedAmount <= 0 ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    throw new Error("Expected payment details are invalid.");
  }

  const amounts = extractAmounts(options.vision.text);
  const paymentMethod = options.payment?.paymentMethod.trim().toLowerCase() ??
    "";
  const submittedReference = options.payment?.submittedReference.trim() ?? "";
  const matchedSubmittedReference = options.payment
    ? expectedReferenceInText(
      options.vision.text,
      submittedReference,
      paymentMethod,
    )
    : null;
  const paymentReference = matchedSubmittedReference ??
    extractPaymentReference(options.vision.text) ?? null;
  const amountMatched = amounts.some((amount) =>
    Math.abs(amount - expectedAmount) <= 0.01
  );
  const paymentWindowMinutes = options.timing.paymentWindowMinutes ??
    RECEIPT_PAYMENT_WINDOW_MINUTES;
  const earlyToleranceMinutes = options.timing.earlyToleranceMinutes ??
    RECEIPT_EARLY_TOLERANCE_MINUTES;
  if (
    !Number.isInteger(paymentWindowMinutes) || paymentWindowMinutes < 1 ||
    paymentWindowMinutes > 60 || !Number.isInteger(earlyToleranceMinutes) ||
    earlyToleranceMinutes < 0 || earlyToleranceMinutes > 10
  ) {
    throw new Error("Receipt payment window is invalid.");
  }
  let bookingStarted: Temporal.Instant;
  try {
    bookingStarted = Temporal.Instant.from(options.timing.bookingStartedAt);
    // Validate the IANA timezone even when no receipt timestamp was detected.
    bookingStarted.toZonedDateTimeISO(options.timing.tenantTimezone);
  } catch {
    throw new Error("Receipt timing context is invalid.");
  }
  const parsedTimestamp = parseReceiptTimestamp(
    options.vision.text,
    options.timing.tenantTimezone,
  );
  let ageMinutes: number | null = null;
  if (parsedTimestamp.receiptDateTime) {
    const receiptInstant = Temporal.Instant.from(
      parsedTimestamp.receiptDateTime,
    );
    ageMinutes = Math.round(
      ((receiptInstant.epochMilliseconds - bookingStarted.epochMilliseconds) /
        60_000) * 100,
    ) / 100;
  }
  const withinWindow = ageMinutes !== null &&
    ageMinutes >= -earlyToleranceMinutes &&
    ageMinutes <= paymentWindowMinutes;
  const flags: string[] = [];
  if (!options.vision.text.trim()) flags.push("ocr_text_not_detected");
  if (amounts.length === 0) flags.push("amount_not_detected");
  else if (!amountMatched) flags.push("amount_mismatch");
  if (!paymentReference) flags.push("payment_reference_not_detected");
  if (
    options.vision.confidence !== null && options.vision.confidence < 0.5
  ) {
    flags.push("low_ocr_confidence");
  }
  if (!parsedTimestamp.receiptDate) flags.push("receipt_date_not_detected");
  if (!parsedTimestamp.receiptTime) flags.push("receipt_time_not_detected");
  if (ageMinutes !== null && ageMinutes < -earlyToleranceMinutes) {
    flags.push("receipt_time_before_booking");
  } else if (ageMinutes !== null && ageMinutes > paymentWindowMinutes) {
    flags.push("payment_window_expired");
  }

  let autoApprove = false;
  let evidenceScore = 0;
  if (options.payment) {
    const referenceMatched = Boolean(
      matchedSubmittedReference &&
        normalizeReference(matchedSubmittedReference) ===
          normalizeReference(submittedReference),
    );
    if (!referenceMatched) flags.push("payment_reference_mismatch");
    const methodAutoApprovalEnabled = paymentMethod === "gcash" ||
      (paymentMethod === "gotyme" &&
        options.payment.autoApprovalEnabled === true);
    const methodMatched = methodAutoApprovalEnabled && paymentMethodMatched(
      options.vision.text,
      paymentMethod,
    );
    if (!methodMatched) {
      flags.push(
        methodAutoApprovalEnabled
          ? "payment_method_unverified"
          : "automatic_method_unsupported",
      );
    }
    const gotymeDestinationBlock = paymentMethod === "gotyme"
      ? gotymeDestinationAccountBlock(options.vision.text)
      : null;
    const receiverMatched = paymentMethod === "gotyme"
      ? gotymeDestinationBlock !== null && gotymeReceiverNameMatched(
        gotymeDestinationBlock,
        options.payment.receiverName,
      ) && gotymeReceiverAccountMatched(
        gotymeDestinationBlock,
        options.payment.receiverReference,
      )
      : receiverReferenceMatched(
        options.vision.text,
        options.payment.receiverReference,
      ) || receiverNameMatched(
        options.vision.text,
        options.payment.receiverName,
      );
    if (!receiverMatched) flags.push("payment_receiver_unverified");
    // Google Vision TEXT_DETECTION does not guarantee word confidence values.
    // Missing confidence is neutral when the amount, customer-entered
    // reference, supported receipt markers, and configured receiver all match.
    // A confidence value that is present and low still requires human review.
    if (
      options.vision.confidence !== null && options.vision.confidence < 0.7
    ) {
      if (!flags.includes("low_ocr_confidence")) {
        flags.push("low_ocr_confidence");
      }
    }

    evidenceScore = roundConfidence(
      (amountMatched ? 0.25 : 0) +
        (referenceMatched ? 0.25 : 0) +
        (methodMatched ? 0.15 : 0) +
        (receiverMatched ? 0.15 : 0) +
        (withinWindow ? 0.2 : 0),
    );
    const effectiveConfidence = options.vision.confidence === null
      ? evidenceScore
      : roundConfidence(options.vision.confidence * 0.3 + evidenceScore * 0.7);
    autoApprove = flags.length === 0 && amountMatched && referenceMatched &&
      withinWindow && effectiveConfidence >= 0.9;
    if (autoApprove) flags.push("auto_approval_eligible");
    else flags.unshift("manual_review_required");
  } else {
    flags.unshift("manual_review_required");
  }

  const detected: SafeReceiptExtraction["detected"] = { amounts };
  if (paymentReference) detected.paymentReference = paymentReference;
  const effectiveConfidence = options.vision.confidence === null
    ? evidenceScore
    : roundConfidence(options.vision.confidence * 0.3 + evidenceScore * 0.7);
  return {
    paymentReference,
    flags,
    autoApprove,
    extractedData: {
      schemaVersion: 2,
      provider: "google_vision",
      feature: "DOCUMENT_TEXT_DETECTION",
      ocrCharacterCount: options.vision.text.length,
      file: {
        mimeType: options.image.mimeType,
        sizeBytes: options.image.sizeBytes,
      },
      detected,
      comparison: { expectedAmount, currency, amountMatched },
      timing: {
        ...parsedTimestamp,
        bookingStartedAt: bookingStarted.toString(),
        tenantTimezone: options.timing.tenantTimezone,
        ageMinutes,
        allowedWindowMinutes: paymentWindowMinutes,
        earlyToleranceMinutes,
        withinWindow,
      },
      confidence: {
        vision: options.vision.confidence,
        evidence: evidenceScore,
        effective: effectiveConfidence,
        source: options.vision.confidence === null
          ? "evidence_only"
          : "google_vision_plus_evidence",
      },
    },
  };
}
