import {
  detectReceiptImageContentType,
  googleVisionConfidence,
  googleVisionConfidenceDetails,
  googleVisionLayoutText,
  googleVisionOcr,
  receiptImageDimensions,
  receiptImageSafeToDecode,
} from "./google-vision.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("detects supported receipt image signatures", () => {
  assertEquals(
    detectReceiptImageContentType(new Uint8Array([0xff, 0xd8, 0xff, 0x00])),
    "image/jpeg",
    "JPEG signature",
  );
  assertEquals(
    detectReceiptImageContentType(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
    "image/png",
    "PNG signature",
  );
  assertEquals(
    detectReceiptImageContentType(
      new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46,
        0,
        0,
        0,
        0,
        0x57,
        0x45,
        0x42,
        0x50,
      ]),
    ),
    "image/webp",
    "WebP signature",
  );
  assertEquals(
    detectReceiptImageContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    null,
    "non-image signature",
  );
});

Deno.test("reads declared dimensions and skips decompression bombs", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  png.set([0x00, 0x00, 0x0f, 0xa0], 16); // 4000
  png.set([0x00, 0x00, 0x0b, 0xb8], 20); // 3000
  const dimensions = receiptImageDimensions(png, "image/png");
  assertEquals(dimensions?.width, 4000, "PNG width");
  assertEquals(dimensions?.height, 3000, "PNG height");
  assert(receiptImageSafeToDecode(png, "image/png"), "12 MP PNG is safe");

  png.set([0x00, 0x01, 0x86, 0xa0], 16); // 100000
  assert(
    !receiptImageSafeToDecode(png, "image/png"),
    "extreme declared dimensions must not reach Image.decode",
  );

  const jpeg = new Uint8Array(21);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  jpeg.set([0x04, 0x38, 0x07, 0x80], 7); // 1080 x 1920
  const jpegDimensions = receiptImageDimensions(jpeg, "image/jpeg");
  assertEquals(jpegDimensions?.width, 1920, "JPEG width");
  assertEquals(jpegDimensions?.height, 1080, "JPEG height");
});

Deno.test("sends the Vision key in a header and builds one OCR request", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(
      JSON.stringify({
        responses: [{
          fullTextAnnotation: {
            text: "Paddle Rage receipt",
            pages: [{ confidence: 0.97 }],
          },
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await googleVisionOcr(
    "test-secret-key",
    "data:image/png;base64,QUJD",
    { fetcher },
  );

  assertEquals(
    requestedUrl,
    "https://vision.googleapis.com/v1/images:annotate",
    "Vision endpoint",
  );
  assert(
    !requestedUrl.includes("test-secret-key"),
    "key must not appear in URL",
  );
  const headers = new Headers(requestedInit?.headers);
  assertEquals(
    headers.get("x-goog-api-key"),
    "test-secret-key",
    "API key header",
  );
  const requestBody = JSON.parse(String(requestedInit?.body || "{}"));
  assertEquals(requestBody.requests.length, 1, "one image request");
  assertEquals(
    requestBody.requests[0].features[0].type,
    "DOCUMENT_TEXT_DETECTION",
    "OCR feature",
  );
  assertEquals(requestBody.requests[0].image.content, "QUJD", "base64 content");
  assertEquals(result.text, "Paddle Rage receipt", "OCR text");
  assertEquals(result.confidence, 0.97, "OCR confidence");
  assertEquals(result.confidenceSource, "native", "OCR confidence source");
});

Deno.test("surfaces a bounded Google Vision API error", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({ error: { message: "Cloud Vision API is disabled" } }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  let message = "";
  try {
    await googleVisionOcr("test-key", "QUJD", { fetcher });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("403"), "status should be included");
  assert(
    message.includes("Cloud Vision API is disabled"),
    "provider error should be included",
  );
  assert(
    !message.includes("test-key"),
    "API key must not be included in errors",
  );
});

Deno.test("averages nested OCR confidence when page confidence is absent", () => {
  const confidence = googleVisionConfidence({
    pages: [{
      blocks: [{ confidence: 0.8 }, { confidence: 0.6 }],
    }],
  }, "receipt");
  assertEquals(confidence, 0.7, "nested confidence average");
});

Deno.test("marks text-length confidence as heuristic, never native", () => {
  const result = googleVisionConfidenceDetails(
    { pages: [], text: "unused" },
    "A readable receipt-shaped OCR response longer than forty characters",
  );
  assertEquals(result.confidence, 0.9, "heuristic confidence");
  assertEquals(result.source, "heuristic", "heuristic provenance");
});

function visionWord(text: string, left: number, top: number, right: number) {
  return {
    boundingBox: {
      vertices: [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: top + 24 },
        { x: left, y: top + 24 },
      ],
    },
    symbols: [...text].map((character) => ({ text: character })),
  };
}

Deno.test("reconstructs two-column GCash fields into visual rows", async () => {
  const annotation = {
    text:
      "Amount\nTotal Amount Sent\nRef No. 0045 111 743324\n420.00\n₱420.00",
    pages: [{
      width: 900,
      height: 1600,
      confidence: 0.96,
      blocks: [{
        paragraphs: [{
          words: [
            visionWord("Amount", 70, 300, 190),
            visionWord("420.00", 650, 302, 790),
            visionWord("Total", 70, 390, 150),
            visionWord("Amount", 160, 390, 280),
            visionWord("Sent", 290, 390, 370),
            visionWord("₱420.00", 610, 392, 790),
            visionWord("Ref", 70, 490, 120),
            visionWord("No.", 130, 490, 180),
            visionWord("0045", 190, 492, 260),
            visionWord("111", 270, 492, 325),
            visionWord("743324", 335, 492, 440),
          ],
        }],
      }],
    }],
  };
  const fetcher = (async () =>
    new Response(JSON.stringify({ responses: [{ fullTextAnnotation: annotation }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  const result = await googleVisionOcr("test-key", "QUJD", { fetcher });
  assertEquals(result.text, annotation.text, "original OCR text is retained");
  assert(
    result.layoutText?.includes("Amount 420.00"),
    "first amount must be paired with its visual label",
  );
  assert(
    result.layoutText?.includes("Total Amount Sent ₱420.00"),
    "total amount must be paired with its visual label",
  );
  assertEquals(
    googleVisionLayoutText(annotation),
    result.layoutText,
    "pure layout reconstruction helper",
  );
});

Deno.test("layout reconstruction safely ignores words without geometry", () => {
  assertEquals(
    googleVisionLayoutText({
      pages: [{ blocks: [{ paragraphs: [{ words: [{ symbols: [{ text: "x" }] }] }] }] }],
    }),
    "",
    "missing boxes",
  );
});
