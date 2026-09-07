# Receipt preview and supplied logo release

Released 2026-09-07 to https://picklestreet.pages.dev/.
Deployment: https://fc9d1674.picklestreet.pages.dev/.

## Receipt diagnosis and fix

Both existing Pickle Street receipt records had stored images in the private
`tenant-private` bucket. The deployed manager response deliberately removes
`storage_path` and exposes `image_available` instead. The frontend checked the
withheld path, so it never requested a protected image and incorrectly reported
that no receipt had been uploaded.

The frontend now respects the availability flag, requests the existing staff-only
signer by verification ID, and distinguishes absent evidence from loading errors.
Reload receipt image refreshes booking details and obtains a new short-lived URL.
Selection and close guards clear previous images and discard stale image events.
An expected verification ID guards against switching receipt records during a
refresh; same-ID replacements are not a versioned snapshot contract.

The existing signer, database, storage permissions, receipt records, payment
statuses, and other tenants were not modified. No new receipt uploads or payment
verification mutations were used for this release.

## Logo

The original `logopickle.jpg` is published unchanged and used for customer,
booking-management, login, dashboard, loading, footer, and browser-icon branding.
The complete portrait crest is contained without cropping. Public social-image
metadata uses the same logo. Existing editable brand settings remain supported.

## Validation

- 92 automated tests passed, including the sanitized manager projection, private
  signing, missing evidence, image failures, stale responses, close, and reload.
- Site checks passed; the build contains only 28 allowlisted public files.
- Both existing receipt images loaded successfully in the live signed-in admin.
- Reload receipt image succeeded; dashboard browser errors were empty.
- Anonymous, wrong-tenant, and foreign-origin signer requests were denied without
  returning image links (401, 403, 403).
- Live logo bytes matched the supplied file exactly; public and admin logos were
  visually/DOM checked.
- Cloudflare release verification passed, including private-source exclusion and
  tenant-origin isolation.

Private images should continue to use authenticated, short-lived viewing URLs.
An image-loading failure should offer a reload without asking the customer to
pay again or claiming their upload is absent.
