import assert from "node:assert/strict";
import { detectReceiptText } from "../_shared/receipt-verification.ts";

function visionReply(text: string): Response {
  return new Response(JSON.stringify({
    responses: [{
      fullTextAnnotation: {
        text,
        pages: [{ blocks: [{ paragraphs: [{ words: [{ confidence: 0.96 }] }] }] }],
      },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

Deno.test("Vision uses document mode by default and permits a strict text-mode retry", async () => {
  const modes: string[] = [];
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    modes.push(body.requests[0].features[0].type);
    return visionReply("Amount 320.00\nTotal Amount Sent P320.00");
  };
  const bytes = new Uint8Array([1, 2, 3]);
  const primary = await detectReceiptText({ bytes, apiKey: "test", fetcher });
  const alternate = await detectReceiptText({
    bytes,
    apiKey: "test",
    fetcher,
    feature: "TEXT_DETECTION",
  });
  assert.equal(primary.text, alternate.text);
  assert.equal(primary.confidence, 0.96);
  assert.deepEqual(modes, ["DOCUMENT_TEXT_DETECTION", "TEXT_DETECTION"]);
});
