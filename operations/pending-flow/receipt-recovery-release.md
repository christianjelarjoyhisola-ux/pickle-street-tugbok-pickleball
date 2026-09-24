# Receipt recovery — September 24, 2026

Approval labels and staff review status mapping are intentionally unchanged.

GCash and MariBank can retry a failed reading using full-image text-mode OCR and visual row ordering. Each candidate must pass the complete existing verifier independently. Partial readings are never combined. Conflicting observed references or amounts prevent recovery; an optional OCR failure retains the original diagnostics. No name alias or expected booking value is inserted into OCR evidence.

MariBank destination extraction is bounded to its recipient block, excludes sender accounts and fee labels, and supports an exact configured QR destination token. “Realtime” alone does not establish completion. The retired Maya exception for undated Completed/Processing screens is removed; those uploads stay pending. Migration 039 corrects only the matching legacy Maya instructions.

Payment settings reject masked expected receiving names with a visible validation message. Server-side receipt verification also refuses masked expected names. Existing per-attempt receiver/settings snapshots remain in use. Checkout and balance-payment guidance identify the sending app.

Validation: 283 frontend/booking tests, 180 receipt tests, edge entrypoint type check, production build, and a rolled-back guidance migration. New tests cover anonymized audited receipt structures, visual row reconstruction, lost masks, missing totals, pending payments, wrong amounts, conflicting references, sender/destination confusion, and failed optional OCR. Existing duplicate-reference, tenant, timing, and booking checks remain in place.

The regression inputs are transcribed receipt structures and simulated OCR responses. They are not fresh Google Vision runs of all 16 private audit images. Recovery only approves when the actual new OCR reading passes; receipts still unreadable or lacking completion evidence continue to need review. No historical customer receipt is automatically retried or re-approved by this release. Private audit images are excluded from Git and the public build.

Deployment scope: named `picklestreet-receipts` edge function, migration 039, and the existing Pickle Street Cloudflare Pages project. No reservation SQL, slot allocation, approval labels, or weather-credit behavior changes.
