import assert from "node:assert/strict";
import {
  canonicalSourceProvider,
  SOURCE_ROUTE_TENANT_ID,
  SOURCE_ROUTE_TENANT_SLUG,
  type SourceRouteInput,
  verifySourceRoute,
} from "./source-routes.ts";
// Synthetic text, merchant identity, references and QR token only. These are not transfers.
const NAME = "TEST VENUE ONLY";
const MOBILE = "09170000001";
const QR = "SYNTHETICQR123456";
const receipts = {
  gcash: {
    reference: "1234567890123",
    text: `GCash Receipt
Sent to
${NAME}
${MOBILE}
Sent via GCash
Amount: PHP 215.00
Total Amount Sent: PHP 215.00
Ref No. 1234567890123 Sep 08, 2026 10:05 AM`,
  },
  bdopay: {
    reference: "BN2026090811999999",
    text: `Sent!
PHP 215.00
Sep 08, 2026 10:05 AM
Amount
PHP 215.00
Service Fee
PHP 0.00
Send Money via InstaPay
To
${NAME}
G-XCHANGE, INC. / GCASH
${QR}
From
SYNTHETIC SENDER
•••• •••• 9999
Invoice number
661119
Reference no.
BN-20260908-11999999`,
  },
  maya: {
    reference: "A1B2C3D4E5F6",
    text: `10:07
Sent money via
- ₱215.00
InstaPay
Sep 8, 2026, 10:05 am
You may confirm the status of your transaction with your recipient.
Share payment
Account type
G-Xchange Inc. / GCash
Account number
${MOBILE}
Account name
${NAME}
Transfer Fee
₱10.00
Reference ID
A1B2 C3D4 E5F6
InstaPay Ref. No
7654321
maya
Get help`,
  },
  bpi: {
    reference: "1624507073888",
    text: `Transfer successful!
Tuesday, Sep 08, 2026, 10:05:00 AM (GMT +8)
Confirmation No. 1624507073888
Transaction Ref. No. 123789
Sent via BPI
Transfer to
GCash/G-Xchange
${NAME} (QR Code)
XXXXXXXXXXXX456
Transfer amount
PHP 215.00
Fee
PHP 0.00
Transfer from
SAVINGS ACCOUNT
XXXXXX9999
Transfer service
InstaPay`,
  },
  gotyme: {
    reference: "GTY202609080001",
    text: `GoTyme Bank
Transfer successful
To
${NAME}
GCash / G-Xchange
Mobile number ${MOBILE}
Amount PHP 215.00
Transaction ID GTY202609080001
InstaPay Ref No 7654321
Sep 08, 2026 10:05 AM
InstaPay`,
  },
  maribank: {
    reference: "MB202609080002",
    text: `MariBank
Money sent
Recipient
${NAME}
GCash
Account number ${MOBILE}
Amount PHP 215.00
Reference No MB202609080002
InstaPay Reference No 7654321
2026-09-08 10:05 AM
via InstaPay`,
  },
};
type Provider = keyof typeof receipts;
function fixture(provider: Provider): SourceRouteInput {
  const receipt = receipts[provider];
  return {
    vision: { text: receipt.text, confidence: 0.99 },
    image: { mimeType: "image/png", sizeBytes: 2048 },
    expectedAmount: 215,
    currency: "PHP",
    payment: {
      paymentMethod: provider,
      submittedReference: receipt.reference,
      receiverName: NAME,
      receiverReference: MOBILE,
    },
    timing: {
      bookingStartedAt: "2026-09-08T02:00:00Z",
      tenantTimezone: "Asia/Manila",
    },
    route: {
      tenantId: SOURCE_ROUTE_TENANT_ID,
      tenantSlug: SOURCE_ROUTE_TENANT_SLUG,
      sourceProvider: provider,
      destinationProvider: provider === "maya" ? "maya" : "gcash",
      destinationMethodCode: provider === "maya" ? "maya" : "gcash",
      enabled: true,
      autoApprovalEnabled: true,
      gcashQrAlias: NAME,
      gcashQrToken: QR,
    },
  };
}
for (const provider of Object.keys(receipts) as Provider[]) {
  Deno.test(`${provider} synthetic source->GCash full evidence preserves safe-v2 contract`, () => {
    const r = verifySourceRoute(fixture(provider));
    assert.equal(r.autoApprove, true, JSON.stringify(r.flags));
    assert.deepEqual(r.flags, ["auto_approval_eligible"]);
    assert.equal(r.paymentReference, receipts[provider].reference);
    assert.equal(r.extractedData.confidence.effective, 0.99);
    assert.equal(
      r.extractedData.detected.route.routeId,
      provider === "maya" ? "maya_configured_receiver" : `${provider}_to_gcash`,
    );
    assert.equal(r.extractedData.comparison.amountMatched, true);
    assert.equal(r.extractedData.timing.allowedWindowMinutes, 10);
    assert.equal(
      r.extractedData.timing.receiptDateTime,
      "2026-09-08T02:05:00Z",
    );
    assert.deepEqual(
      Object.keys(r.extractedData).sort(),
      [
        "schemaVersion",
        "provider",
        "feature",
        "ocrCharacterCount",
        "file",
        "detected",
        "comparison",
        "timing",
        "confidence",
      ].sort(),
    );
    assert.ok(
      !JSON.stringify(r.extractedData).includes(receipts[provider].text),
    );
  });
  Deno.test(`${provider} does not replace missing or low native confidence with matching fields`, () => {
    for (const confidence of [null, 0.89, NaN, Infinity, -1, 1.01]) {
      const f = fixture(provider);
      f.vision.confidence = confidence;
      const r = verifySourceRoute(f);
      assert.equal(r.autoApprove, false, JSON.stringify(r.flags));
      assert.ok(r.extractedData.confidence.effective < 0.9);
    }
  });
  Deno.test(`${provider} keeps non-success states pending`, () => {
    for (
      const state of [
        "Failed",
        "Pending",
        "Processing",
        "Scheduled",
        "Reversed",
        "Refunded",
        "Cancelled",
      ]
    ) {
      const f = fixture(provider);
      f.vision.text += "\n" + state;
      assert.equal(verifySourceRoute(f).autoApprove, false);
    }
  });
  Deno.test(`${provider} binds protected account, amount, source, and tenant`, () => {
    for (
      const mutate of [(f: SourceRouteInput) => {
        f.payment.receiverReference = "09990000002";
        f.route.gcashQrToken = "DIFFERENTTOKEN999";
      }, (f: SourceRouteInput) => {
        f.expectedAmount = 216;
      }, (f: SourceRouteInput) => {
        f.route.tenantId = "10000000-0000-4000-8000-000000000000";
      }, (f: SourceRouteInput) => {
        f.route.enabled = false;
      }, (f: SourceRouteInput) => {
        f.route.autoApprovalEnabled = false;
      }, (f: SourceRouteInput) => {
        f.route.destinationMethodCode = provider === "maya" ? "gcash" : "maya";
      }, (f: SourceRouteInput) => {
        f.payment.submittedReference = "9999999999999";
      }]
    ) {
      const f = fixture(provider);
      mutate(f);
      assert.equal(verifySourceRoute(f).autoApprove, false);
    }
  });
  Deno.test(`${provider} never dispatches another source as fallback`, () => {
    for (const other of Object.keys(receipts) as Provider[]) {
      if (other === provider) continue;
      const f = fixture(provider);
      f.vision.text = receipts[other].text;
      assert.equal(
        verifySourceRoute(f).autoApprove,
        false,
        provider + " accepted " + other,
      );
    }
  });
}
Deno.test("bdo, bdo_pay and bdopay resolve only the BDO Pay source route", () => {
  for (const alias of ["bdo", "bdo_pay", "bdopay"]) {
    const f = fixture("bdopay");
    f.route.sourceProvider = alias;
    f.payment.paymentMethod = alias;
    const r = verifySourceRoute(f);
    assert.equal(r.autoApprove, true, JSON.stringify(r.flags));
    assert.equal(r.extractedData.detected.route.sourceProvider, "bdopay");
  }
  assert.equal(canonicalSourceProvider("pnb"), null);
  assert.equal(canonicalSourceProvider("unknown"), null);
});
Deno.test("BDO/BPI require private venue QR receipt alias and token with no account-number fallback", () => {
  for (const provider of ["bdopay", "bpi"] as const) {
    for (const key of ["gcashQrAlias", "gcashQrToken"] as const) {
      const f = fixture(provider);
      delete f.route[key];
      const r = verifySourceRoute(f);
      assert.equal(r.autoApprove, false);
      assert.ok(r.flags.includes("qr_receipt_identity_unconfigured"));
    }
  }
});
Deno.test("principal excludes fee and detects contradictory receipt amounts", () => {
  const f = fixture("maya");
  f.vision.text = f.vision.text.replace("- ₱215.00", "- ₱205.00");
  assert.equal(verifySourceRoute(f).autoApprove, false);
  const g = fixture("gcash");
  g.vision.text = g.vision.text.replace(
    "Amount: PHP 215.00",
    "Amount: PHP 200.00",
  );
  assert.equal(verifySourceRoute(g).autoApprove, false);
  const h = fixture("bdopay");
  h.vision.text = h.vision.text.replaceAll("PHP 215.00", "PHP 205.00").replace(
    "Service Fee\nPHP 0.00",
    "Service Fee\nPHP 215.00",
  );
  assert.equal(verifySourceRoute(h).autoApprove, false);
});
Deno.test("primary customer input cannot synthesize missing labeled reference", () => {
  for (const provider of Object.keys(receipts) as Provider[]) {
    const f = fixture(provider);
    f.vision.text = f.vision.text.replace(
      /(?:Ref No\.|Reference No|Reference no\.|Reference ID|Transaction ID|Confirmation No\.)[^\n]*/gi,
      "",
    );
    assert.equal(verifySourceRoute(f).autoApprove, false, provider);
  }
});
Deno.test("all observed secondary reference identities reach durable SQL deduplication", () => {
  for (
    const [provider, kind, value] of [
      ["maya", "maya_instapay", "7654321"],
      ["gotyme", "instapay", "7654321"],
      ["maribank", "instapay", "7654321"],
      ["bdopay", "bdopay_invoice", "661119"],
      ["bpi", "bpi_transaction", "123789"],
    ] as const
  ) {
    const r = verifySourceRoute(fixture(provider));
    assert.deepEqual(r.extractedData.detected.route.secondaryReferences, [{
      kind,
      value,
    }]);
    assert.equal("dedupeKeys" in r.extractedData.detected.route, false);
  }
});
Deno.test("removing a secondary reference stays pending even with matching primary", () => {
  for (
    const provider of ["maya", "gotyme", "maribank", "bdopay", "bpi"] as const
  ) {
    const f = fixture(provider);
    f.vision.text = f.vision.text.replace(
      /(?:InstaPay Ref(?:erence)?\.? No\.?|Invoice number|Transaction Ref\. No\.)[\s\S]*?(?=\n[A-Za-z]|$)/gi,
      "",
    );
    assert.equal(verifySourceRoute(f).autoApprove, false, provider);
  }
});
Deno.test("ten-minute bounds are inclusive and the status-bar clock cannot replace transaction time", () => {
  for (
    const [time, passed] of [["10:10 am", true], ["10:11 am", false]] as const
  ) {
    const f = fixture("maya");
    f.vision.text = f.vision.text.replace("10:05 am", time);
    assert.equal(verifySourceRoute(f).autoApprove, passed);
  }
  const f = fixture("maya");
  f.vision.text = f.vision.text.replace("Sep 8, 2026, 10:05 am", "Sep 8, 2026");
  assert.equal(verifySourceRoute(f).autoApprove, false);
});
Deno.test("sender account does not satisfy wrong receiver and masked bank accounts remain pending", () => {
  for (const provider of ["gcash", "maya", "gotyme", "maribank"] as const) {
    const f = fixture(provider);
    f.vision.text = f.vision.text.replace(MOBILE, "09990000002") +
      "\nSender\n" + NAME + "\n" + MOBILE;
    assert.equal(verifySourceRoute(f).autoApprove, false, provider);
  }
  for (const provider of ["gotyme", "maribank"] as const) {
    const f = fixture(provider);
    f.vision.text = f.vision.text.replace(MOBILE, "0917***0001");
    assert.equal(verifySourceRoute(f).autoApprove, false, provider);
  }
});
Deno.test("native confidence threshold cannot be raised by complete matching evidence", () => {
  for (const provider of Object.keys(receipts) as Provider[]) {
    for (
      const [confidence, expected] of [[0.9, true], [0.899999, false]] as const
    ) {
      const f = fixture(provider);
      f.vision.confidence = confidence;
      assert.equal(verifySourceRoute(f).autoApprove, expected, provider);
    }
  }
});
Deno.test("foreign currency and invalid payment cents stay pending", () => {
  for (const provider of Object.keys(receipts) as Provider[]) {
    for (
      const mutate of [(f: SourceRouteInput) => {
        f.currency = "USD";
      }, (f: SourceRouteInput) => {
        f.vision.text += "\nUSD 215.00";
      }, (f: SourceRouteInput) => {
        f.expectedAmount = 215.001;
      }, (f: SourceRouteInput) => {
        f.expectedAmount = NaN;
      }]
    ) {
      const f = fixture(provider);
      mutate(f);
      assert.equal(verifySourceRoute(f).autoApprove, false, provider);
    }
  }
});
Deno.test("duplicate conflicting primary or secondary labels remain pending", () => {
  const extras = {
    gcash: "Ref No. 9999999999999",
    bdopay: "Reference no.\nBN-20260908-99888888",
    maya: "Reference ID\nF6E5 D4C3 B2A1",
    bpi: "Confirmation No. 1624507073999",
    gotyme: "Transaction ID GTY202609080099",
    maribank: "Reference No MB202609080099",
  };
  for (const provider of Object.keys(receipts) as Provider[]) {
    const f = fixture(provider);
    f.vision.text += "\n" + extras[provider];
    assert.equal(
      verifySourceRoute(f).autoApprove,
      false,
      provider + " primary",
    );
  }
  const railExtras = {
    bdopay: "Invoice number\n991118",
    maya: "InstaPay Ref. No\n7654322",
    bpi: "Transaction Ref. No. 123788",
    gotyme: "InstaPay Ref No 7654322",
    maribank: "InstaPay Reference No 7654322",
  };
  for (
    const provider of Object.keys(railExtras) as (keyof typeof railExtras)[]
  ) {
    const f = fixture(provider);
    f.vision.text += "\n" + railExtras[provider];
    assert.equal(
      verifySourceRoute(f).autoApprove,
      false,
      provider + " secondary",
    );
  }
});
Deno.test("timing uses the original absolute start across Manila midnight", () => {
  const f = fixture("maya");
  f.timing.bookingStartedAt = "2026-09-07T15:58:00Z";
  f.vision.text = f.vision.text.replace(
    "Sep 8, 2026, 10:05 am",
    "Sep 8, 2026, 12:05 am",
  );
  const r = verifySourceRoute(f);
  assert.equal(r.autoApprove, true, JSON.stringify(r.flags));
  assert.equal(r.extractedData.timing.ageMinutes, 7);
});
Deno.test("impossible calendar dates and wrong server timezone cannot pass timing checks", () => {
  const f = fixture("maya");
  f.vision.text = f.vision.text.replace(
    "Sep 8, 2026, 10:05 am",
    "Feb 30, 2026, 10:05 am",
  );
  assert.equal(verifySourceRoute(f).autoApprove, false);
  const g = fixture("maya");
  g.timing.tenantTimezone = "UTC";
  assert.equal(verifySourceRoute(g).autoApprove, false);
});

for (const provider of Object.keys(receipts) as Provider[]) {
 Deno.test(provider+' receipt-only checkout reads a high-confidence reference',()=>{
  const f=fixture(provider);f.payment.submittedReference='';
  const result=verifySourceRoute(f);
  assert.equal(result.autoApprove,true,JSON.stringify(result.flags));
  assert.equal(result.paymentReference,receipts[provider].reference);
 });
 Deno.test(provider+' unreadable receipt-only reference remains pending',()=>{
  const f=fixture(provider);f.payment.submittedReference='';f.vision.text='Unreadable image';
  assert.equal(verifySourceRoute(f).autoApprove,false);
 });
}

Deno.test("Maya account type is optional while account and both references remain required",()=>{
 for(const type of ["G-Xchange Inc. / GCash","Maya Philippines",""]){
  const f=fixture("maya");f.payment.submittedReference="";
  f.vision.text=f.vision.text.replace("Account type\nG-Xchange Inc. / GCash",type?"Account type\n"+type:"");
  const r=verifySourceRoute(f);assert.equal(r.autoApprove,true,JSON.stringify(r.flags));
 }
 for(const remove of ["Account number\n"+MOBILE,"Reference ID\nA1B2 C3D4 E5F6","InstaPay Ref. No\n7654321"]){
  const f=fixture("maya");f.payment.submittedReference="";f.vision.text=f.vision.text.replace(remove,"");
  assert.equal(verifySourceRoute(f).autoApprove,false);
 }
});
