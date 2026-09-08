// Public routing identity only. No privileged credentials belong here.
(function configurePickleStreet(global) {
  'use strict';
  const productionHosts = Object.freeze(['picklestreetcourt.com','picklestreet.pages.dev','pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site']);
  const developmentHosts = Object.freeze(['localhost','127.0.0.1','::1']);
  const currentHost = String(global.location?.hostname || '').toLowerCase();
  if (![...productionHosts,...developmentHosts].includes(currentHost)) throw new Error('This website is not registered for the current address.');
  const config = Object.freeze({
    tenantSlug:'pickle-street-tugbok', productionHosts, developmentHosts,
    supabaseUrl:'https://neqvrwtofiolcuxewdze.supabase.co',
    supabasePublishableKey:'sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr',
    schemaVersion:'multi-tenant-v1', authEnabled:true, backendEnabled:true,
    publicBookingEnabled:true, refundReschedulePolicyEnabled:true,
    eventBookingEnabled:true, openPlayEnabled:true, hostPortalEnabled:false,
    adminOpenPlayEnabled:false,
    rainResolutionMode:'reschedule_only',
    receiptReviewMode:'auto_pending',
    manualReceiptReviewEnabled:true,
    receiptPaymentWindowMinutes:15,
    sharedGcashPaymentsEnabled:true,
    onboardingLocked:false,
    // Pickle Street bookings do not use a CAPTCHA.
    turnstileSiteKey:'',
  });
  Object.defineProperty(global,'PB_TENANT_CONFIG',{value:config,enumerable:true,writable:false,configurable:false});
})(window);
