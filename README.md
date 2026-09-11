# Pickle Street Tugbok

Premium blue, green, and cool-gray booking website for the existing protected multi-tenant platform. The venue photo supplied by the owner is used on the welcome panel.

## Venue setup

Open `login.html` and use an existing authorized platform-owner account. No sample credentials or owner memberships were created. The platform owner can assign this venue's owner and staff through the existing protected account-management controls.

Configure the venue inside the dashboard:

1. Add courts with their names, photos, opening/closing hours, regular price bands, minimum duration, and booking notice/horizon.
2. Set business details and the blue/green/gray brand colors.
3. Add payment methods, receiving accounts, and QR images.
4. Review and publish the venue's own refund/reschedule policy.
5. Set platform billing, remittance destination, booking email preferences, and Open Play fees if needed.
6. Complete server readiness checks and initial activation. Booking is closed until readiness passes.

**Cloudflare deployment:** https://picklestreet.pages.dev is the public website. The Pages hostname is registered as this tenant's primary domain. Customer bookings remain closed until the venue setup above is completed. The earlier Sites preview remains separate and owner-private.

## Tenant boundary

- Supabase project: `neqvrwtofiolcuxewdze`
- Slug: `pickle-street-tugbok`
- ID: `f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a`
- Primary registered host: `picklestreet.pages.dev`
- Previous preview host (retained): `pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site`
- Sites project: `appgprj_6a9e19f834388191bb865dd4ca9ffa10`

Only this new tenant and its domain were provisioned using existing protected platform procedures. The provisioning transaction compared existing tenant, domain, and court rows before committing and rolled back on any difference. No shared schema, policies, functions, other tenant rows, or Paddle Rage remote repository were modified. `operations/live-verification.json` records the read-only bootstrap and cross-tenant rejection check.

`operations/provision-pickle-street.sql` records the one-time executed transaction; it is an audit artifact, not a repeatable installation script. The original standalone Supabase scripts and `feature-preview/` are reference material only. They must never be deployed or applied to the shared project. Legacy setup/deployment entry points have been disabled. The original Paddle Rage Git remote was removed from this independent working copy.

## Implemented shared-platform features

Customer court/date availability; regular and event checkout where server enabled; private booking recovery; full payment and receipt submission/review; balance-payment links; manager bookings and archives; court/hours/tier settings; account permissions; protected rescheduling and additional-payment holds; rain-refund reporting and settlement; remittances; booking reports; Open Play sessions, registrations, check-in, payment review, and separate reporting.

All amounts, availability, account authorization, and activation remain server-authoritative. Public pages never switch to privileged manager data when an owner is remembered. Browser writes cannot use legacy direct-table calls. Business settings and policies use revision checks. A higher-price reschedule holds the requested time while preserving the original confirmed booking until settlement.

## Feature parity limits

This is **not yet a complete Paddle Rage feature port**. Its host applications, host deposits/deadline forfeiture, authoritative game queues and cross-device live boards, guest grouped-reschedule requests/review, payment reassignment, and advanced demand/availability exports need further protected platform work. Those interfaces are not published as working features. Browser-local substitutes would not provide equivalent persistence or accounting. Grouped checkout stays gated by the server's advertised capability; the inspected bootstrap advertised no atomic multi-session capability.

## Build and validation

`npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run build`, `npm run dev`.

For Cloudflare updates, run `npm run deploy:cloudflare`. The deployment script is fixed to the `picklestreet` Pages project. `operations/register-pages-domain.sql` records the tenant-only routing update; `operations/cloudflare-security.json` records the additive widget domain update, with existing domains/settings preserved. `operations/cloudflare-release-verification.json` verifies the public pages, source-file exclusions, and Supabase tenant boundary. Password recovery redirects to the exact `https://picklestreet.pages.dev/login.html` address; the shared default Site URL and existing redirect entries were preserved.

`tools/site-files.cjs` is the release allowlist. Only those files enter `dist/`; no reference application, backend source, environment file, operations script, or standalone worker is served. The local server uses the same allowlist. The Sites packaging helper packages `dist/` and metadata after the exact source commit is pushed.

Checks cover syntax for every shipped script (including inline page code), local asset links, wrong-host and wrong-tenant rejection, public-versus-manager data access, account identity, request headers, settings/policy revisions, Open Play accounting/recovery, balance rules, and reschedule pricing/deadlines. Live validation was read-only; no production customer booking or payment was created. Authenticated end-to-end setup/payment testing, visual browser QA, and a supported WebMCP contract check have not been completed. The optional date-selection WebMCP tool is feature-detected and does not reserve a court.
