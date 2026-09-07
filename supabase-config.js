// =============================================
// SUPABASE CONFIGURATION
// Replace these with your actual project credentials.
// Find them at: Supabase Dashboard → Project Settings → API
// =============================================
// This frontend uses a tenant-scoped connection to the shared platform.
// The explicit backendEnabled flag prevents an unfinished platform from being
// activated merely by filling in a URL or key.
const PB_RUNTIME_CONFIG = window.PB_TENANT_CONFIG || {};
const PB_TENANT_SLUG = String(PB_RUNTIME_CONFIG.tenantSlug || '').trim().toLowerCase();
if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(PB_TENANT_SLUG)) {
  throw new Error('A valid configured tenant slug is required.');
}
const PB_AUTH_ENABLED = PB_RUNTIME_CONFIG.authEnabled === true;
const PB_BACKEND_ENABLED = PB_RUNTIME_CONFIG.backendEnabled === true;
const PB_REFUND_RESCHEDULE_POLICY_ENABLED =
  PB_RUNTIME_CONFIG.refundReschedulePolicyEnabled === true;
// The schema marker describes the contract; the rollout flag authorizes data
// access. Keeping both checks here prevents auth-only previews from touching
// production tenant tables or public booking RPCs.
const PB_PLATFORM_V1 = PB_BACKEND_ENABLED && PB_RUNTIME_CONFIG.schemaVersion === 'multi-tenant-v1';
const PB_SUPABASE_CONNECTION_ENABLED = PB_AUTH_ENABLED || PB_BACKEND_ENABLED;
const SUPABASE_URL = PB_SUPABASE_CONNECTION_ENABLED
  ? String(PB_RUNTIME_CONFIG.supabaseUrl || '')
  : 'https://YOUR_PLATFORM_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = PB_SUPABASE_CONNECTION_ENABLED
  ? String(PB_RUNTIME_CONFIG.supabasePublishableKey || '')
  : 'YOUR_PLATFORM_PUBLISHABLE_KEY';
const PB_SUPABASE_CREDENTIALS_CONFIGURED =
  !SUPABASE_URL.includes('YOUR_PLATFORM_PROJECT_REF') &&
  !SUPABASE_ANON_KEY.includes('YOUR_PLATFORM_PUBLISHABLE_KEY');
const PB_SUPABASE_AUTH_CONFIGURED =
  PB_AUTH_ENABLED && PB_SUPABASE_CREDENTIALS_CONFIGURED;
const PB_SUPABASE_CONFIGURED =
  PB_BACKEND_ENABLED && PB_SUPABASE_CREDENTIALS_CONFIGURED;
window.PB_SUPABASE_CONFIGURED = PB_SUPABASE_CONFIGURED;
window.PB_SUPABASE_AUTH_CONFIGURED = PB_SUPABASE_AUTH_CONFIGURED;
// The deploy-time switch is only a request to enable booking. The server must
// independently report that the tenant is ready (billing, payment destination,
// and tenant activation are configured) before the public UI can open checkout.
const PB_PUBLIC_BOOKING_REQUESTED =
  PB_RUNTIME_CONFIG.publicBookingEnabled === true && PB_PLATFORM_V1 && PB_SUPABASE_CONFIGURED;
window.PB_PUBLIC_BOOKING_ENABLED = false;
window.PB_PLATFORM_READINESS = null;
window.PB_PAYMENT_METHOD_CODES = Object.freeze(Object.create(null));
window.PB_PAYMENT_METHODS_BY_CODE = Object.freeze(Object.create(null));
window.PB_TENANT_SLUG = PB_TENANT_SLUG;
window.PB_PLATFORM_V1 = PB_PLATFORM_V1;
window.PB_REFUND_RESCHEDULE_POLICY_ENABLED = PB_REFUND_RESCHEDULE_POLICY_ENABLED;

const PB_REQUEST_TIMEOUT_MS = 45000;
const PB_PAGE_DATA_SCOPE = document.documentElement.dataset.pbDataScope || 'auth';
let _pbBusinessRevision = null;
let _pbPolicyRevision = null;
function _pbCaptureBusinessRevision(data) {
  const revision = data?.tenantRevision || data?.updatedAt || data?.settings?.updatedAt;
  if (revision) _pbBusinessRevision = revision;
  return data;
}
const PB_RECEIPT_TIMEOUT_MS = 90000;

async function _pbFetchWithTimeout(input, init = {}, timeoutMs = PB_REQUEST_TIMEOUT_MS) {
  const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (requestUrl.origin !== 'https://neqvrwtofiolcuxewdze.supabase.co') throw new Error('Unexpected booking service address.');
  if (requestUrl.pathname.startsWith('/rest/v1/') && !requestUrl.pathname.startsWith('/rest/v1/rpc/')) throw new Error('Direct table access is disabled for this website.');
  if (requestUrl.pathname.startsWith('/functions/v1/')) {
    if (requestUrl.searchParams.get('tenantSlug') !== PB_TENANT_SLUG) throw new Error('A venue-scoped request is required.');
    const headers = new Headers(init.headers || {});
    headers.set('X-Tenant-Slug', PB_TENANT_SLUG);
    init = {...init, headers};
  }
  if (requestUrl.pathname.startsWith('/rest/v1/rpc/')) {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const rpc = requestUrl.pathname.split('/').pop();
    const idOnlyManagerRpc = ['cancel_tenant_booking','reinstate_tenant_booking'].includes(rpc)
      && PB_PAGE_DATA_SCOPE === 'manager' && /^[0-9a-f-]{36}$/i.test(body.p_booking_id || '');
    const originBoundBlockRpc = ['manage_blocked_dates','get_blocked_date_access','set_blocked_date_access'].includes(rpc) && PB_PAGE_DATA_SCOPE === 'manager'
      && body.p_tenant_slug === PB_TENANT_SLUG;
    // These existing RPCs validate the actual request Origin and actor in SQL;
    // their published signatures intentionally omit the hostname parameter.
    if (!idOnlyManagerRpc && !originBoundBlockRpc &&
      (body.p_tenant_slug !== PB_TENANT_SLUG || body.p_hostname !== _pbTenantHostname())) {
      throw new Error('A verified venue context is required.');
    }
  }

  const supportsAbort = typeof AbortController === 'function';
  const controller = supportsAbort && !init.signal ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('The request timed out. Please check your connection and try again.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(input, controller ? { ...init, signal: controller.signal } : init),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Keep Supabase Auth in the selected browser scope. Session storage is used
// unless the user explicitly chooses "Keep me logged in".
const PB_AUTH_REMEMBER_KEY = 'pickle-street-tugbok-remember';
const _pbAuthStorage = {
  getItem(key) {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  },
  setItem(key, value) {
    const remember = localStorage.getItem(PB_AUTH_REMEMBER_KEY) === '1';
    const target = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    target.setItem(key, value);
    other.removeItem(key);
  },
  removeItem(key) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};
// Initialize Supabase client (uses UMD global loaded from CDN). A bounded
// fetch prevents embedded browsers from leaving the booking button hanging.
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: (input, init) => _pbFetchWithTimeout(input, init) },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: _pbAuthStorage,
    storageKey: 'pickle-street-tugbok-auth',
  },
});

// Expose globally so HTML pages can use real-time subscriptions
window._supabase = _sb;

const PB_IS_LOCAL_HOST = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const PB_DATA_MODE_KEY = `pb_data_mode:${PB_TENANT_SLUG}`;

function _pbTenantHostname() {
  return PB_IS_LOCAL_HOST
    ? String(PB_RUNTIME_CONFIG.productionHosts?.[0] || window.location.hostname)
    : window.location.hostname;
}

// Production and development both use the shared backend. Browser-local demo
// data and sample credentials are intentionally disabled for this tenant.
try { localStorage.removeItem(PB_DATA_MODE_KEY); } catch (_) {}
window.PB_USE_LOCAL_DATA = false;

const PB_FAST_CACHE_MS = {
  courts: 60000,
  settings: 30000,
  blockedDates: 30000,
  bookings: 3500,
};
const _pbFastCache = new Map();

function _pbClone(value) {
  if (value == null) return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch(_) {}
  try { return JSON.parse(JSON.stringify(value)); } catch(_) { return value; }
}

function _pbCacheKey(scope, params = {}) {
  const suffix = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join('&');
  return suffix ? `${scope}:${suffix}` : scope;
}

async function _pbCached(scope, params, ttlMs, loader) {
  const key = _pbCacheKey(scope, params);
  const hit = _pbFastCache.get(key);
  const now = Date.now();
  if (hit?.promise) return _pbClone(await hit.promise);
  if (hit && now - hit.at < ttlMs) return _pbClone(hit.value);

  const promise = Promise.resolve()
    .then(loader)
    .then(value => {
      _pbFastCache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch(err => {
      _pbFastCache.delete(key);
      throw err;
    });
  _pbFastCache.set(key, { at: now, promise });
  return _pbClone(await promise);
}

function _pbClearFastCache(scopes = []) {
  const list = Array.isArray(scopes) ? scopes.filter(Boolean) : [scopes].filter(Boolean);
  if (list.length === 0) { _pbFastCache.clear(); return; }
  for (const key of [..._pbFastCache.keys()]) {
    if (list.some(scope => key === scope || key.startsWith(`${scope}:`))) _pbFastCache.delete(key);
  }
}

async function _pbPlatformBootstrap() {
  return _pbCached('platformBootstrap', {}, PB_FAST_CACHE_MS.settings, async () => {
    const { data, error } = await _sb.rpc('get_public_tenant_bootstrap', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
    });
    if (error) throw error;
    if (!data?.tenant || data.tenant.slug !== PB_TENANT_SLUG || data.tenant.id !== 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' || !Array.isArray(data?.courts)) {
      throw new Error('This booking website is not configured for the current domain.');
    }
    const readiness = data?.readiness && typeof data.readiness === 'object'
      ? data.readiness
      : {};
    window.PB_PLATFORM_READINESS = Object.freeze({ ...readiness });
    window.PB_PUBLIC_BOOKING_ENABLED =
      PB_PUBLIC_BOOKING_REQUESTED && readiness.publicBookingEnabled === true && Boolean(String(PB_RUNTIME_CONFIG.turnstileSiteKey || '').trim());
    return data;
  });
}

async function _pbPlatformAvailability(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  return _pbCached('platformAvailability', { date }, PB_FAST_CACHE_MS.bookings, async () => {
    const { data, error } = await _sb.rpc('get_public_availability', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_date: date,
    });
    if (error) throw error;
    if (!data || data.tenantSlug !== PB_TENANT_SLUG) {
      throw new Error('Availability is not configured for the current domain.');
    }
    _pbRememberPlatformBlockedHours(data);
    return data;
  });
}

function _pbClockHour(value, endOfDay = false) {
  const match = /^(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute !== 0) return null;
  if (endOfDay && hour === 0) return 24;
  return hour;
}

function _pbPlatformCourtToLegacy(court, { publicPublished = false } = {}) {
  const regular = court?.pricingConfig?.regular || {};
  const bands = Array.isArray(regular.bands) ? regular.bands : [];
  const rateSchedule = bands.map(band => ({
    from: _pbClockHour(band.start),
    to: String(band.end) === '24:00' ? 24 : _pbClockHour(band.end, true),
    rate: Number(band.hourlyRate),
  })).filter(band => Number.isInteger(band.from) && Number.isInteger(band.to) && band.to > band.from && Number.isFinite(band.rate) && band.rate > 0);
  const surface = String(court?.publicConfig?.surface || '').trim();
  const suppliedStatus = String(court?.status || '').toLowerCase();
  const status = ['active', 'inactive', 'maintenance'].includes(suppliedStatus)
    ? suppliedStatus
    // The public bootstrap publishes only bookable courts, but older versions
    // of its DTO omitted status. Keep the manager path fail-closed while
    // recognizing a court returned by that trusted public projection as active.
    : publicPublished ? 'active' : 'inactive';
  return {
    id: court.id,
    slug: court.slug,
    name: court.name,
    desc: court.description || '',
    rate: Number(rateSchedule[0]?.rate || 0),
    status,
    blocked: status === 'maintenance',
    sortOrder: Number(court.sortOrder || 0),
    surface,
    feats: surface ? [surface] : [],
    photo: court?.publicConfig?.photoUrl || '',
    rateSchedule,
    opensAt: court.opensAt,
    closesAt: court.closesAt,
    currency: String(court.currency || '').trim(),
    pricingConfig: court.pricingConfig || {},
    publicConfig: court.publicConfig || {},
  };
}

function _pbPublicPlatformCourtToLegacy(court) {
  return _pbPlatformCourtToLegacy(court, { publicPublished: true });
}

function _pbPlatformRawCourtToLegacy(row) {
  return _pbPlatformCourtToLegacy({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    sortOrder: row.sort_order,
    opensAt: String(row.opens_at || '').slice(0, 5),
    closesAt: String(row.closes_at || '').slice(0, 5),
    currency: row.currency,
    pricingConfig: row.pricing_config || {},
    publicConfig: row.public_config || {},
  });
}

async function _pbAuthenticatedSession() {
  const { data } = await _sb.auth.getSession();
  return data?.session || null;
}

function _pbZonedHour(timestamp, timeZone) {
  if (!timestamp) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'Asia/Manila',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    return Number.isInteger(hour) ? hour : null;
  } catch (_) {
    return null;
  }
}

function _pbPlatformRescheduleEventToLegacy(event) {
  const row = event && typeof event === 'object' ? event : {};
  const email = row.email && typeof row.email === 'object'
    ? row.email
    : row.notification && typeof row.notification === 'object'
      ? row.notification
      : {};
  return {
    id: row.id || row.eventId || row.event_id || null,
    reasonCode: row.reasonCode || row.reason_code || '',
    publicReason: row.publicReason || row.public_reason || '',
    internalNote: row.internalNote || row.internal_note || '',
    oldStartsAt: row.oldStartsAt || row.old_starts_at || '',
    oldEndsAt: row.oldEndsAt || row.old_ends_at || '',
    newStartsAt: row.newStartsAt || row.new_starts_at || '',
    newEndsAt: row.newEndsAt || row.new_ends_at || '',
    rescheduledAt: row.rescheduledAt || row.rescheduled_at || row.createdAt || row.created_at || '',
    rescheduledBy: row.rescheduledBy || row.rescheduled_by || row.actorName || row.actor_name || row.actorEmail || row.actor_email || '',
    notifyCustomer: row.notifyCustomer ?? row.notify_customer ?? false,
    emailStatus: row.emailStatus || row.email_status || email.status || '',
    emailSentAt: row.emailSentAt || row.email_sent_at || email.sentAt || email.sent_at || '',
    emailDeliveryId: row.emailDeliveryId || row.email_delivery_id || row.emailProviderReference || row.email_provider_reference || email.deliveryId || email.delivery_id || email.providerReference || email.provider_reference || null,
    emailErrorCode: row.emailErrorCode || row.email_error_code || row.emailLastErrorCode || row.email_last_error_code || email.errorCode || email.error_code || '',
    emailAttemptCount: Number(row.emailAttemptCount ?? row.email_attempt_count ?? email.attemptCount ?? email.attempt_count ?? 0),
  };
}

function _pbPlatformRescheduleEmailToLegacy(email) {
  const row = email && typeof email === 'object' ? email : {};
  return {
    status: String(row.status || ''),
    deliveryId: row.deliveryId || row.delivery_id || row.providerReference || row.provider_reference || null,
    errorCode: row.errorCode || row.error_code || '',
    sentAt: row.sentAt || row.sent_at || '',
    attemptCount: Number(row.attemptCount ?? row.attempt_count ?? 0),
  };
}

function _pbWeatherRefundNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function _pbWeatherRefundExpectedAmount(basisAmount, refundPercent) {
  if (!Number.isFinite(basisAmount) || !Number.isFinite(refundPercent)) return null;
  return Math.round(basisAmount * refundPercent) / 100;
}

function _pbWeatherRefundAmountMatches(actualAmount, expectedAmount) {
  return Number.isFinite(actualAmount) &&
    Number.isFinite(expectedAmount) &&
    Math.abs(actualAmount - expectedAmount) < 0.011;
}

function _pbNormalizeWeatherRefund(value, { kind = 'summary' } = {}) {
  const source = value && typeof value === 'object'
    ? (value.incident && typeof value.incident === 'object'
      ? value.incident
      : value.preview && typeof value.preview === 'object'
        ? value.preview
        : value.weatherRefund && typeof value.weatherRefund === 'object'
          ? value.weatherRefund
          : value)
    : null;
  if (!source) return null;
  const notes = source.notes && typeof source.notes === 'object' ? source.notes : {};
  const actors = source.actors && typeof source.actors === 'object' ? source.actors : {};
  const timestamps = source.timestamps && typeof source.timestamps === 'object' ? source.timestamps : {};
  const payout = source.payout && typeof source.payout === 'object' ? source.payout : {};
  const status = String(source.status || '').trim().toLowerCase();
  const payoutStatus = String(source.payoutStatus || source.payout_status || payout.status || '').trim().toLowerCase();
  const grossPaidAmount = _pbWeatherRefundNumber(
    source.grossPaidAmount,
    source.gross_paid_amount,
    source.paidAmount,
    source.paid_amount,
  );
  const normalized = {
    id: source.id || source.incidentId || source.incident_id || null,
    bookingReference: String(source.bookingReference || source.booking_reference || source.reference || '').trim(),
    courtId: source.courtId || source.court_id || null,
    courtName: String(source.courtName || source.court_name || '').trim(),
    bookingStartsAt: source.bookingStartsAt || source.booking_starts_at || '',
    bookingEndsAt: source.bookingEndsAt || source.booking_ends_at || '',
    actualPlayStartedAt: source.actualPlayStartedAt || source.actual_play_started_at || '',
    rainStoppedPlayAt: source.rainStoppedPlayAt || source.rain_stopped_play_at || '',
    elapsedSeconds: _pbWeatherRefundNumber(source.elapsedSeconds, source.elapsed_seconds),
    elapsedMinutes: _pbWeatherRefundNumber(source.elapsedMinutes, source.elapsed_minutes),
    refundPercent: _pbWeatherRefundNumber(source.refundPercent, source.refund_percent),
    paidAmount: grossPaidAmount,
    grossPaidAmount,
    courtRentalAmount: _pbWeatherRefundNumber(
      source.courtRentalAmount,
      source.court_rental_amount,
    ),
    equipmentRentalAmount: _pbWeatherRefundNumber(
      source.equipmentRentalAmount,
      source.equipment_rental_amount,
    ),
    platformBookingFeeAmount: _pbWeatherRefundNumber(
      source.platformBookingFeeAmount,
      source.platform_booking_fee_amount,
      source.serviceFeeAmount,
      source.service_fee_amount,
    ),
    refundableBasisAmount: _pbWeatherRefundNumber(
      source.refundableBasisAmount,
      source.refundable_basis_amount,
    ),
    calculationBasis: String(
      source.calculationBasis || source.calculation_basis || '',
    ).trim().toLowerCase(),
    refundAmount: _pbWeatherRefundNumber(source.refundAmount, source.refund_amount),
    ruleVersion: String(source.ruleVersion || source.rule_version || '').trim(),
    currency: String(source.currency || 'PHP').trim().toUpperCase(),
    status,
    payoutStatus,
    reportNote: String(source.reportNote || source.report_note || notes.report || '').trim(),
    decisionNote: String(source.decisionNote || source.decision_note || notes.decision || '').trim(),
    payoutNote: String(source.payoutNote || source.payout_note || payout.note || notes.payout || '').trim(),
    reportedBy: source.reportedBy || source.reported_by || actors.reportedBy || actors.reported_by || null,
    decidedBy: source.decidedBy || source.decided_by || actors.decidedBy || actors.decided_by || null,
    payoutSentBy: source.payoutSentBy || source.payout_sent_by || payout.sentBy || payout.sent_by || actors.payoutSentBy || null,
    reportedAt: source.reportedAt || source.reported_at || timestamps.reportedAt || timestamps.reported_at || '',
    decidedAt: source.decidedAt || source.decided_at || source.reviewedAt || source.reviewed_at || timestamps.decidedAt || timestamps.reviewedAt || '',
    payoutSentAt: source.payoutSentAt || source.payout_sent_at || payout.sentAt || payout.sent_at || timestamps.payoutSentAt || '',
    payoutReference: String(source.payoutReference || source.payout_reference || payout.reference || '').trim(),
    payoutMethod: String(source.payoutMethod || source.payout_method || payout.method || '').trim(),
    source: String(source.source || source.reportSource || source.report_source || 'staff_manual').trim().toLowerCase(),
    playerClaimId: source.playerClaimId || source.player_claim_id || null,
    proofAvailable: source.proofAvailable === true || source.proof_available === true,
    playerReportedAt: source.playerReportedAt || source.player_reported_at || '',
    scheduledPlayStartedAt: source.scheduledPlayStartedAt || source.scheduled_play_started_at || source.bookingStartsAt || source.booking_starts_at || '',
    actualPlayStartOverridden: source.actualPlayStartOverridden === true || source.actual_play_start_overridden === true,
  };
  const validStatus = ['reported', 'approved', 'rejected'].includes(normalized.status);
  const publicSummary = kind === 'summary';
  const validPayoutStatus = (
    publicSummary
      ? ['awaiting_approval', 'pending', 'sent', 'not_required']
      : ['pending', 'sent', 'not_required']
  ).includes(normalized.payoutStatus);
  const validMoney = [normalized.grossPaidAmount, normalized.refundAmount]
    .every(amount => Number.isFinite(amount) && amount >= 0);
  const splitValues = [
    normalized.courtRentalAmount,
    normalized.equipmentRentalAmount,
    normalized.platformBookingFeeAmount,
    normalized.refundableBasisAmount,
  ];
  const hasCompleteSplit = splitValues.every(amount => Number.isFinite(amount) && amount >= 0);
  const splitAddsToGross = hasCompleteSplit &&
    Math.abs(
      normalized.courtRentalAmount +
      normalized.equipmentRentalAmount +
      normalized.platformBookingFeeAmount -
      normalized.grossPaidAmount
    ) < 0.011;
  const currentRule = normalized.ruleVersion === 'rain-v3';
  const legacyRule = ['rain-v1', 'rain-v2'].includes(normalized.ruleVersion);
  const validBasis = currentRule
    ? normalized.calculationBasis === 'court-rental-v1' &&
      hasCompleteSplit &&
      splitAddsToGross &&
      Math.abs(normalized.refundableBasisAmount - normalized.courtRentalAmount) < 0.011
    : legacyRule &&
      normalized.calculationBasis === 'gross-paid-legacy' &&
      hasCompleteSplit &&
      splitAddsToGross &&
      Math.abs(normalized.refundableBasisAmount - normalized.grossPaidAmount) < 0.011;
  const validRuleVersion = currentRule || legacyRule;
  const expectedRefundAmount = _pbWeatherRefundExpectedAmount(
    normalized.refundableBasisAmount,
    normalized.refundPercent,
  );
  const validAccounting = validMoney && validBasis && validRuleVersion &&
    normalized.currency === 'PHP' &&
    _pbWeatherRefundAmountMatches(normalized.refundAmount, expectedRefundAmount);
  const validCalculation = Number.isFinite(normalized.elapsedMinutes) && normalized.elapsedMinutes >= 0 &&
    Number.isFinite(normalized.refundPercent) && normalized.refundPercent >= 0 && normalized.refundPercent <= 100 &&
    validAccounting;
  const validDate = timestamp => Boolean(timestamp) && !Number.isNaN(new Date(timestamp).getTime());
  const payoutSentAtValid = validDate(normalized.payoutSentAt);
  const payoutLifecycleValid = normalized.status === 'reported'
    ? normalized.payoutStatus === (publicSummary ? 'awaiting_approval' : 'pending') &&
      !normalized.payoutSentAt
    : normalized.status === 'rejected'
      ? normalized.payoutStatus === 'not_required' && !normalized.payoutSentAt
      : normalized.status === 'approved' && normalized.refundAmount === 0
        ? normalized.payoutStatus === 'not_required' && !normalized.payoutSentAt
        : normalized.status === 'approved' && normalized.refundAmount > 0
          ? (normalized.payoutStatus === 'pending' && !normalized.payoutSentAt) ||
            (normalized.payoutStatus === 'sent' && payoutSentAtValid)
          : false;
  const validSummary = validStatus && validPayoutStatus &&
    Number.isFinite(normalized.refundPercent) && normalized.refundPercent >= 0 && normalized.refundPercent <= 100 &&
    validAccounting && payoutLifecycleValid;
  const validIncident = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(normalized.id || '')) &&
    Boolean(normalized.bookingReference) && validStatus && validPayoutStatus && validCalculation && payoutLifecycleValid &&
    validDate(normalized.bookingStartsAt) && validDate(normalized.bookingEndsAt) &&
    validDate(normalized.actualPlayStartedAt) && validDate(normalized.rainStoppedPlayAt) &&
    validDate(normalized.reportedAt) &&
    (!['approved', 'rejected'].includes(normalized.status) || validDate(normalized.decidedAt)) &&
    (normalized.payoutStatus !== 'sent' || payoutSentAtValid);
  if (kind === 'preview') {
    return validCalculation && normalized.ruleVersion === 'rain-v3' ? normalized : null;
  }
  if (kind === 'incident') return validIncident ? normalized : null;
  return validSummary ? normalized : null;
}

function _pbNormalizePlayerRainPayoutDestination(value) {
  const source = value && typeof value === 'object' ? value : null;
  if (!source) return null;
  const destination = {
    method: String(source.method || '').trim().toLowerCase(),
    accountName: String(source.accountName || source.account_name || '').trim(),
    mobileNumber: String(source.mobileNumber || source.mobile_number || '').trim(),
    collectedAt: source.collectedAt || source.collected_at || '',
  };
  const collectedAt = new Date(destination.collectedAt || '');
  return destination.method === 'gcash' &&
    destination.accountName.length >= 2 && destination.accountName.length <= 100 &&
    /^\+639\d{9}$/.test(destination.mobileNumber) &&
    !Number.isNaN(collectedAt.getTime())
    ? destination
    : null;
}

function _pbPlayerRainExpectedPercent(elapsedSeconds) {
  if (!Number.isInteger(elapsedSeconds) || elapsedSeconds < 1) return null;
  if (elapsedSeconds <= 900) return 75;
  if (elapsedSeconds <= 1800) return 50;
  if (elapsedSeconds <= 2700) return 25;
  return 0;
}

function _pbPlayerRainStartPolicyAccepted(claim, idempotent = false) {
  if (!claim || typeof claim !== 'object') return false;
  return (
    claim.ruleVersion === 'rain-v3' &&
    claim.calculationBasis === 'court-rental-v1'
  ) || (
    idempotent === true &&
    claim.ruleVersion === 'rain-v2' &&
    claim.calculationBasis === 'gross-paid-legacy'
  );
}

function _pbNormalizePlayerRainClaim(value, { kind = 'full' } = {}) {
  const source = value && typeof value === 'object'
    ? (value.claim && typeof value.claim === 'object' ? value.claim : value)
    : null;
  if (!source || !['full', 'booking-summary'].includes(kind)) return null;
  const number = (...values) => _pbWeatherRefundNumber(...values);
  const elapsedSeconds = number(source.elapsedSeconds, source.elapsed_seconds);
  const grossPaidAmount = number(
    source.grossPaidAmount,
    source.gross_paid_amount,
    source.paidAmount,
    source.paid_amount,
  );
  const claim = {
    id: String(source.id || source.claimId || source.claim_id || '').trim(),
    status: String(source.status || '').trim().toLowerCase(),
    bookingReference: String(source.bookingReference || source.booking_reference || '').trim().toUpperCase(),
    bookingId: source.bookingId || source.booking_id || null,
    courtId: source.courtId || source.court_id || null,
    courtName: String(source.courtName || source.court_name || '').trim(),
    customerName: String(source.customerName || source.customer_name || '').trim(),
    customerEmail: String(source.customerEmail || source.customer_email || '').trim(),
    customerPhone: String(source.customerPhone || source.customer_phone || '').trim(),
    accessMethod: String(source.accessMethod || source.access_method || '').trim(),
    bookingDate: String(source.bookingDate || source.booking_date || '').trim(),
    bookingStartsAt: source.bookingStartsAt || source.booking_starts_at || '',
    bookingEndsAt: source.bookingEndsAt || source.booking_ends_at || '',
    rainReportedAt: source.rainReportedAt || source.rain_reported_at || '',
    proofDueAt: source.proofDueAt || source.proof_due_at || '',
    submittedAt: source.submittedAt || source.submitted_at || '',
    decidedAt: source.decidedAt || source.decided_at || '',
    elapsedSeconds,
    elapsedMinutes: Number.isInteger(elapsedSeconds)
      ? (kind === 'booking-summary'
        ? Math.round(elapsedSeconds / 6) / 10
        : Math.round((elapsedSeconds / 60) * 100) / 100)
      : null,
    ruleVersion: String(source.ruleVersion || source.rule_version || '').trim(),
    refundPercent: number(source.refundPercent, source.refund_percent),
    paidAmount: grossPaidAmount,
    grossPaidAmount,
    courtRentalAmount: number(
      source.courtRentalAmount,
      source.court_rental_amount,
    ),
    equipmentRentalAmount: number(
      source.equipmentRentalAmount,
      source.equipment_rental_amount,
    ),
    platformBookingFeeAmount: number(
      source.platformBookingFeeAmount,
      source.platform_booking_fee_amount,
      source.serviceFeeAmount,
      source.service_fee_amount,
    ),
    refundableBasisAmount: number(
      source.refundableBasisAmount,
      source.refundable_basis_amount,
    ),
    calculationBasis: String(
      source.calculationBasis || source.calculation_basis || '',
    ).trim().toLowerCase(),
    estimatedRefundAmount: number(source.estimatedRefundAmount, source.estimated_refund_amount),
    refundAmount: number(source.refundAmount, source.refund_amount),
    currency: String(source.currency || 'PHP').trim().toUpperCase(),
    proofAvailable: source.proofAvailable === true || source.proof_available === true,
    reportNote: String(source.reportNote || source.report_note || '').trim(),
    decisionNote: String(source.decisionNote || source.decision_note || '').trim(),
    playStartOverrideReason: String(source.playStartOverrideReason || source.play_start_override_reason || '').trim(),
    actualPlayStartedAt: source.actualPlayStartedAt || source.actual_play_started_at || '',
    scheduledPlayStartedAt: source.scheduledPlayStartedAt || source.scheduled_play_started_at || source.bookingStartsAt || source.booking_starts_at || '',
    actualPlayStartOverridden: source.actualPlayStartOverridden === true || source.actual_play_start_overridden === true,
    incidentId: source.incidentId || source.incident_id || null,
    payoutStatus: String(
      source.payoutStatus || source.payout_status || '',
    ).trim().toLowerCase(),
    payoutSentAt: source.payoutSentAt || source.payout_sent_at || '',
    payoutDestination: _pbNormalizePlayerRainPayoutDestination(
      source.payoutDestination || source.payout_destination
    ),
    createdAt: source.createdAt || source.created_at || '',
    updatedAt: source.updatedAt || source.updated_at || '',
  };
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validId = uuidPattern.test(claim.id);
  const validStatus = ['awaiting_proof', 'submitted', 'approved', 'rejected', 'expired'].includes(claim.status);
  const validDate = timestamp => Boolean(timestamp) && !Number.isNaN(new Date(timestamp).getTime());
  const splitValues = [
    claim.courtRentalAmount,
    claim.equipmentRentalAmount,
    claim.platformBookingFeeAmount,
    claim.refundableBasisAmount,
  ];
  const hasCompleteSplit = splitValues.every(amount => Number.isFinite(amount) && amount >= 0);
  const splitAddsToGross = hasCompleteSplit &&
    Math.abs(
      claim.courtRentalAmount +
      claim.equipmentRentalAmount +
      claim.platformBookingFeeAmount -
      claim.grossPaidAmount
    ) < 0.011;
  const currentRule = claim.ruleVersion === 'rain-v3';
  const legacyRule = claim.ruleVersion === 'rain-v2';
  const validBasis = currentRule
    ? claim.calculationBasis === 'court-rental-v1' &&
      hasCompleteSplit &&
      splitAddsToGross &&
      Math.abs(claim.refundableBasisAmount - claim.courtRentalAmount) < 0.011
    : legacyRule &&
      claim.calculationBasis === 'gross-paid-legacy' &&
      hasCompleteSplit &&
      Math.abs(claim.refundableBasisAmount - claim.grossPaidAmount) < 0.011;
  const expectedRefundAmount = _pbWeatherRefundExpectedAmount(
    claim.refundableBasisAmount,
    claim.refundPercent,
  );
  const payoutSentAtValid = validDate(claim.payoutSentAt);
  const expectedPercent = _pbPlayerRainExpectedPercent(claim.elapsedSeconds);
  const preDecision = ['awaiting_proof', 'submitted', 'expired', 'rejected'].includes(claim.status);
  const estimateMatches = _pbWeatherRefundAmountMatches(
    claim.estimatedRefundAmount,
    expectedRefundAmount,
  );
  const finalMatches = _pbWeatherRefundAmountMatches(
    claim.refundAmount,
    expectedRefundAmount,
  );
  const preDecisionMoneyValid = preDecision &&
    estimateMatches &&
    claim.refundAmount === null &&
    !claim.payoutStatus &&
    !claim.payoutSentAt;
  const approvedPayoutValid = claim.status === 'approved' && finalMatches &&
    (claim.refundAmount === 0
      ? claim.payoutStatus === 'not_required' && !claim.payoutSentAt
      : claim.refundAmount > 0 &&
        ((claim.payoutStatus === 'pending' && !claim.payoutSentAt) ||
          (claim.payoutStatus === 'sent' && payoutSentAtValid)));
  const submittedAtValid = validDate(claim.submittedAt);
  const decidedAtValid = validDate(claim.decidedAt);
  const workflowDatesValid = ['awaiting_proof', 'expired'].includes(claim.status)
    ? !claim.submittedAt && !claim.decidedAt
    : claim.status === 'submitted'
      ? submittedAtValid && !claim.decidedAt
      : claim.status === 'rejected' || claim.status === 'approved'
        ? submittedAtValid && decidedAtValid
        : false;
  const validCalculation = Number.isFinite(claim.elapsedMinutes) && claim.elapsedMinutes > 0 &&
    Number.isInteger(claim.elapsedSeconds) && claim.elapsedSeconds > 0 &&
    claim.refundPercent === expectedPercent &&
    Number.isFinite(claim.grossPaidAmount) && claim.grossPaidAmount >= 0 &&
    validBasis && (currentRule || legacyRule) &&
    (preDecisionMoneyValid || approvedPayoutValid) &&
    workflowDatesValid &&
    claim.currency === 'PHP';
  const bookingIdentityValid = kind === 'booking-summary' ||
    (claim.bookingReference &&
      validDate(claim.bookingStartsAt) &&
      validDate(claim.bookingEndsAt));
  const approvedIncidentValid = claim.status !== 'approved' ||
    kind === 'booking-summary' ||
    uuidPattern.test(String(claim.incidentId || ''));
  const rawPayoutDestination = source.payoutDestination || source.payout_destination || null;
  const payoutDestinationValid = !rawPayoutDestination || Boolean(claim.payoutDestination);
  let nestedIncidentValid = true;
  const nestedIncidentSource = source.incident && typeof source.incident === 'object'
    ? source.incident
    : null;
  if (nestedIncidentSource) {
    const incident = _pbNormalizeWeatherRefund(nestedIncidentSource, { kind: 'incident' });
    nestedIncidentValid = Boolean(incident) &&
      String(incident.id || '').toLowerCase() === String(claim.incidentId || '').toLowerCase() &&
      incident.ruleVersion === claim.ruleVersion &&
      incident.refundPercent === claim.refundPercent &&
      _pbWeatherRefundAmountMatches(incident.grossPaidAmount, claim.grossPaidAmount) &&
      _pbWeatherRefundAmountMatches(incident.courtRentalAmount, claim.courtRentalAmount) &&
      _pbWeatherRefundAmountMatches(incident.equipmentRentalAmount, claim.equipmentRentalAmount) &&
      _pbWeatherRefundAmountMatches(incident.platformBookingFeeAmount, claim.platformBookingFeeAmount) &&
      _pbWeatherRefundAmountMatches(incident.refundableBasisAmount, claim.refundableBasisAmount) &&
      incident.calculationBasis === claim.calculationBasis &&
      _pbWeatherRefundAmountMatches(incident.refundAmount, claim.refundAmount) &&
      incident.currency === claim.currency;
  }
  if (claim.status === 'approved') claim.estimatedRefundAmount = null;
  return validId && validStatus && bookingIdentityValid && approvedIncidentValid &&
    validDate(claim.rainReportedAt) && validDate(claim.proofDueAt) &&
    payoutDestinationValid && nestedIncidentValid && validCalculation
    ? claim
    : null;
}

function _pbNormalizePublicBookingStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const booking = { ...value };
  const rawWeatherRefund = value.weatherRefund || value.weather_refund || null;
  const rawPlayerClaim = value.playerRainClaim || value.player_rain_claim ||
    value.rainClaim || value.rain_claim || null;
  delete booking.weather_refund;
  delete booking.player_rain_claim;
  delete booking.rainClaim;
  delete booking.rain_claim;
  if (rawWeatherRefund) {
    const weatherRefund = _pbNormalizeWeatherRefund(rawWeatherRefund, { kind: 'summary' });
    if (weatherRefund) booking.weatherRefund = weatherRefund;
    else return null;
  }
  if (rawPlayerClaim) {
    const playerRainClaim = _pbNormalizePlayerRainClaim(rawPlayerClaim, {
      kind: 'booking-summary',
    });
    if (playerRainClaim) booking.playerRainClaim = playerRainClaim;
    else return null;
  }
  return booking;
}

function _pbWeatherRefundIdempotencyKey() {
  if (!window.crypto?.randomUUID) {
    throw new Error('This browser cannot create a secure refund request. Please update it and try again.');
  }
  return window.crypto.randomUUID();
}

async function _pbManageWeatherRefund(action, payload = {}) {
  if (!PB_PLATFORM_V1) throw new Error('Rain refunds require the protected tenant platform.');
  if (!await _pbAuthenticatedSession()) {
    const error = new Error('Your session is no longer available. Please sign in again.');
    error.code = 'AUTHENTICATION_REQUIRED';
    throw error;
  }
  const result = await _invokeEdgeFunction(
    `manage-weather-refund?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
    {
      action: String(action || ''),
      tenantSlug: PB_TENANT_SLUG,
      ...payload,
    },
    { preferDirect: true },
  );
  if (!result?.ok) {
    const message = result?.error?.message || result?.message || 'The rain refund service returned an invalid response.';
    const error = new Error(message);
    error.code = result?.error?.code || null;
    throw error;
  }
  return result;
}

function _pbPlatformRescheduleOptionToLegacy(option) {
  const row = option && typeof option === 'object' ? option : {};
  const startsAt = row.startsAt || row.starts_at || '';
  const endsAt = row.endsAt || row.ends_at || '';
  const startTime = String(row.startTime || row.start_time || String(startsAt).slice(11, 16));
  const endTime = String(row.endTime || row.end_time || String(endsAt).slice(11, 16));
  const unavailableReason = String(row.unavailableReason || row.unavailable_reason || '');
  const prices = {};
  for (const [key, snake] of Object.entries({courtSubtotalAmount:'court_subtotal_amount',newSubtotalAmount:'new_subtotal_amount',newTotalAmount:'new_total_amount',originalTotalAmount:'original_total_amount',amountPaid:'amount_paid',additionalAmount:'additional_amount'})) {
    const value = row[key] ?? row[snake];
    if (row.available !== false && !unavailableReason && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('The new schedule price could not be verified. Refresh before rescheduling.');
    prices[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  const paymentRequired = row.paymentRequired ?? row.payment_required;
  if (row.available !== false && !unavailableReason && (typeof paymentRequired !== 'boolean' || paymentRequired !== (prices.additionalAmount > 0))) throw new Error('The new schedule payment requirement could not be verified.');
  return {
    startsAt,
    endsAt,
    startTime,
    endTime,
    label: String(row.label || `${startTime} - ${endTime}`),
    available: row.available !== false && !unavailableReason,
    unavailableReason,
    ...prices,
    paymentRequired: paymentRequired === true,
  };
}

async function _pbPlatformBookingResponseToLegacy(row) {
  if (!row || typeof row !== 'object') return null;
  const bootstrap = await _pbPlatformBootstrap();
  const courts = (bootstrap?.courts || []).map(_pbPublicPlatformCourtToLegacy);
  return _pbPlatformBookingToLegacy(
    row,
    new Map(courts.map(court => [String(court.id), court])),
    bootstrap?.tenant?.timezone || 'Asia/Manila',
  );
}

function _pbPlatformBookingToLegacy(row, courtMap, timeZone) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const lastReschedule = metadata.lastReschedule && typeof metadata.lastReschedule === 'object'
    ? metadata.lastReschedule
    : {};
  const bookingSlots = Array.isArray(row.booking_slots)
    ? [...row.booking_slots]
    : Array.isArray(row.bookingSlots)
      ? [...row.bookingSlots]
      : [];
  const startsAt = row.starts_at || row.startsAt;
  const endsAt = row.ends_at || row.endsAt;
  const slots = bookingSlots
    .filter(slot => ['held', 'confirmed'].includes(slot.status))
    .map(slot => _pbZonedHour(slot.starts_at || slot.startsAt, timeZone))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  const fallbackStart = _pbZonedHour(startsAt, timeZone);
  const calculatedDuration = Math.round((new Date(endsAt) - new Date(startsAt)) / 3600000);
  const declaredDuration = Number(row.durationHours ?? row.duration_hours ?? row.duration);
  const duration = Number.isFinite(calculatedDuration) && calculatedDuration > 0
    ? calculatedDuration
    : Number.isFinite(declaredDuration) && declaredDuration > 0
      ? declaredDuration
      : 1;
  if (!slots.length && Number.isInteger(fallbackStart)) {
    for (let index = 0; index < duration; index++) slots.push((fallbackStart + index) % 24);
  }
  const rawStatus = row.status;
  const status = {
    pending_payment: 'verifying',
    payment_review: 'pending',
    confirmed: 'confirmed',
    cancelled: 'cancelled',
    completed: 'completed',
    expired: 'forfeited',
  }[rawStatus] || rawStatus;
  const rawPaymentStatus = row.payment_status || row.paymentStatus;
  const paymentStatus = {
    unpaid: 'unpaid',
    pending: 'for_verification',
    partial: 'downpayment_paid',
    paid: 'paid',
    refunded: 'refunded',
    rejected: 'rejected',
  }[rawPaymentStatus] || rawPaymentStatus;
  const courtId = row.court_id || row.courtId;
  const court = courtMap.get(String(courtId));
  const receipts = Array.isArray(row.receipt_verifications)
    ? [...row.receipt_verifications].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    : Array.isArray(row.receiptVerifications)
      ? [...row.receiptVerifications].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    : [];
  const receipt = receipts[0] || null;
  const paymentSessions = Array.isArray(row.payment_sessions)
    ? [...row.payment_sessions].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    : Array.isArray(row.paymentSessions)
      ? [...row.paymentSessions].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    : [];
  const paymentSession = paymentSessions[0] || null;
  const rawPaymentPayload = paymentSession?.provider_payload || paymentSession?.providerPayload;
  const paymentPayload = rawPaymentPayload && typeof rawPaymentPayload === 'object'
    ? rawPaymentPayload
    : {};
  const rawRescheduleEvents = Array.isArray(row.booking_reschedule_events)
    ? row.booking_reschedule_events
    : Array.isArray(row.rescheduleEvents)
      ? row.rescheduleEvents
      : Array.isArray(row.reschedule_events)
        ? row.reschedule_events
        : [];
  const rescheduleEvents = rawRescheduleEvents
    .map(_pbPlatformRescheduleEventToLegacy)
    .sort((a, b) => String(b.rescheduledAt || '').localeCompare(String(a.rescheduledAt || '')));
  const balanceRequests = Array.isArray(row.booking_balance_requests)
    ? [...row.booking_balance_requests]
    : Array.isArray(row.bookingBalanceRequests)
      ? [...row.bookingBalanceRequests]
      : [];
  const balanceRequest = balanceRequests
    .sort((a, b) => String(b.created_at || b.createdAt || '').localeCompare(String(a.created_at || a.createdAt || '')))[0] || null;
  const acceptedBalanceAmount = Number(balanceRequest?.accepted_amount ?? balanceRequest?.acceptedAmount);
  const mappedDownpayment = Number.isFinite(acceptedBalanceAmount) && acceptedBalanceAmount > 0
    ? acceptedBalanceAmount
    : metadata.fullPaymentOnly
      ? Number(row.total_amount ?? row.totalAmount ?? row.total ?? 0)
      : null;
  const rawWeatherRefund = row.weatherRefund
    || row.weather_refund
    || row.weather_refund_incident
    || (Array.isArray(row.weather_refund_incidents) ? row.weather_refund_incidents[0] : null)
    || (Array.isArray(row.weatherRefundIncidents) ? row.weatherRefundIncidents[0] : null);
  const subtotalAmount = Number(
    row.subtotal_amount ?? row.subtotalAmount ?? row.courtFee ?? 0,
  );
  const rawEquipmentRentalAmount = Number(
    metadata.equipmentRentalFeeAmount ?? metadata.equipment_rental_fee_amount ?? 0,
  );
  const equipmentRentalAmount = Number.isFinite(rawEquipmentRentalAmount)
    ? Math.max(0, rawEquipmentRentalAmount)
    : 0;
  const storedCourtRentalAmount = Number(
    metadata.courtSubtotalAmount ??
    metadata.court_subtotal_amount ??
    (subtotalAmount - equipmentRentalAmount),
  );
  const courtRentalAmount = Number.isFinite(storedCourtRentalAmount)
    ? Math.max(0, storedCourtRentalAmount)
    : Math.max(0, subtotalAmount - equipmentRentalAmount);
  const platformBookingFeeAmount = Number(
    row.service_fee_amount ?? row.serviceFeeAmount ?? row.serviceFee ?? 0,
  );
  return {
    id: row.id,
    ref: row.reference || row.ref || row.bookingReference,
    groupRef: row.groupRef || row.group_ref || row.bookingGroupRef || row.booking_group_ref || null,
    fullName: row.customer_name || row.customerName || row.fullName,
    contactNumber: row.customer_phone || row.customerPhone || row.contactNumber,
    email: row.customer_email || row.customerEmail || row.email,
    courtId,
    courtName: court?.name || row.courtName || row.court_name || 'Court',
    date: row.local_booking_date || row.localBookingDate || String(startsAt || '').slice(0, 10),
    slots,
    startTime: slots.length ? _fmtBookingHour(slots[0]) : '',
    endTime: slots.length ? _fmtBookingHour(slots[slots.length - 1] + 1) : '',
    timeLabel: _bookingSlotsTimeLabel(slots),
    duration,
    rate: subtotalAmount / duration,
    total: Number(row.total_amount ?? row.totalAmount ?? row.total ?? 0),
    courtFee: subtotalAmount,
    courtRentalAmount,
    equipmentRentalAmount,
    platformBookingFeeAmount: Number.isFinite(platformBookingFeeAmount)
      ? Math.max(0, platformBookingFeeAmount)
      : 0,
    serviceFee: platformBookingFeeAmount,
    downpayment: mappedDownpayment,
    bookingType: row.booking_type || row.bookingType || 'regular',
    eventType: metadata.eventType || null,
    eventGuestCount: Number(row.guest_count || row.guestCount || 1),
    eventSetupNotes: metadata.notes || null,
    paymentMethod: (() => {
      const code = String(metadata.paymentMethod || paymentPayload.paymentMethod || '').toLowerCase();
      return code === 'bdo' ? 'bdopay' : (code || null);
    })(),
    gcashRef: receipt?.payment_reference || paymentPayload.submittedReference || null,
    paymentStatus,
    receiptVerificationId: receipt?.id || null,
    // The source image stays private. This sentinel only tells the dashboard
    // that an authenticated, short-lived viewing URL can be requested.
    receiptImageUrl: receipt?.storage_path ? 'protected' : null,
    receiptStatus: receipt?.status || 'none',
    receiptFlags: receipt?.flags || [],
    receiptExtracted: receipt?.extracted_data || null,
    receiptConfidence: receipt?.confidence == null ? null : Number(receipt.confidence),
    receiptVerifiedAt: receipt?.reviewed_at || receipt?.verified_at || null,
    receiptExpectedAmount: receipt?.expected_amount == null ? null : Number(receipt.expected_amount),
    receiptBalanceRequestId: receipt?.balance_request_id || null,
    balanceRequestId: balanceRequest?.id || null,
    balanceRequestType: balanceRequest?.request_type || balanceRequest?.requestType || null,
    balanceRequestStatus: balanceRequest?.status || null,
    balanceAcceptedAmount: balanceRequest ? Number(balanceRequest.accepted_amount ?? balanceRequest.acceptedAmount ?? 0) : null,
    remainingBalance: balanceRequest ? Number(balanceRequest.remaining_amount ?? balanceRequest.remainingAmount ?? 0) : null,
    balanceDeadlineAt: balanceRequest?.deadline_at || balanceRequest?.deadlineAt || null,
    balanceSettledAt: balanceRequest?.settled_at || balanceRequest?.settledAt || null,
    status,
    platformStatus: rawStatus,
    startsAt,
    endsAt,
    archivedAt: row.archived_at || row.archivedAt || null,
    archivedBy: row.archived_by || row.archivedBy || null,
    archiveReason: row.archive_reason || row.archiveReason || null,
    expiresAt: row.expires_at || row.expiresAt || null,
    createdAt: row.created_at || row.createdAt,
    lastRescheduleEventId: lastReschedule.eventId || lastReschedule.event_id || null,
    rescheduleEvents,
    weatherRefund: _pbNormalizeWeatherRefund(rawWeatherRefund, { kind:'summary' }),
  };
}

function _pbPlatformSettingsToLegacy(bootstrap) {
  const settings = { ...(bootstrap?.settings || {}) };
  const tenant = bootstrap?.tenant && typeof bootstrap.tenant === 'object' ? bootstrap.tenant : {};
  const business = bootstrap?.business && typeof bootstrap.business === 'object'
    ? bootstrap.business
    : {};
  const branding = business.branding && typeof business.branding === 'object'
    ? business.branding
    : tenant.branding && typeof tenant.branding === 'object'
      ? tenant.branding
      : {};
  const contact = tenant.contact && typeof tenant.contact === 'object' ? tenant.contact : {};
  const publicConfig = tenant.publicConfig && typeof tenant.publicConfig === 'object' ? tenant.publicConfig : {};
  const publicBusiness = Object.freeze({
    displayName: String(business.displayName || tenant.displayName || tenant.name || '').trim(),
    contactPhone: String(business.contactPhone || tenant.contactPhone || contact.phone || '').trim(),
    facebookUrl: String(business.facebookUrl || tenant.facebookUrl || publicConfig.facebookUrl || '').trim(),
    tagline: String(business.tagline || tenant.tagline || publicConfig.tagline || '').trim(),
    eventBookingEnabled: business.eventBookingEnabled === true || tenant.eventBookingEnabled === true,
    branding: Object.freeze({
      primaryColor: String(branding.primaryColor || '').trim(),
      secondaryColor: String(branding.secondaryColor || '').trim(),
      accentColor: String(branding.accentColor || '').trim(),
      logoUrl: String(branding.logoUrl || '').trim(),
      socialImageUrl: String(branding.socialImageUrl || branding.shareImageUrl || '').trim(),
    }),
  });
  window.PB_TENANT_BUSINESS = publicBusiness;
  settings.business_display_name = publicBusiness.displayName;
  settings.business_contact_phone = publicBusiness.contactPhone;
  settings.business_facebook_url = publicBusiness.facebookUrl;
  settings.business_tagline = publicBusiness.tagline;
  settings.business_branding = JSON.stringify(publicBusiness.branding);
  settings.event_booking_enabled = publicBusiness.eventBookingEnabled ? '1' : '0';
  const bookingFee = bootstrap?.bookingFee || bootstrap?.billing || null;
  if (bookingFee && typeof bookingFee === 'object') {
    const amount = Number(bookingFee.amount ?? bookingFee.feeAmount);
    const mode = String(bookingFee.mode ?? bookingFee.feeMode ?? '');
    if (Number.isFinite(amount) && amount >= 0) settings.maintenance_fee = String(amount);
    if (mode) {
      settings.fee_type = mode === 'fixed_per_booking' ? 'flat' : 'per_hour';
    }
  }
  // Court hours and pricing are court-scoped on the tenant platform. Never
  // project the first court into legacy global settings: doing so makes every
  // other court silently inherit the wrong schedule and enables destructive
  // bulk writes from the old settings UI.
  const paymentMode = settings['booking.payment_mode'] || bootstrap?.tenant?.publicConfig?.paymentAcceptanceMode;
  if (paymentMode) settings.payment_acceptance_mode = paymentMode;

  // Payment options are opt-in on the public platform. Missing destination
  // settings must never render placeholder accounts as payable methods.
  const paymentConfigs = Array.isArray(bootstrap?.paymentMethods) ? bootstrap.paymentMethods : [];
  const supportedUiCodes = new Set(['cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb']);
  const paymentCodeAliases = Object.create(null);
  const paymentMethodsByCode = Object.create(null);
  const ambiguousUiCodes = new Set();
  for (const method of paymentConfigs) {
    const backendCode = String(method.code || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(backendCode)) continue;
    const uiCode = backendCode === 'bdo' ? 'bdopay' : backendCode;
    const dto = Object.freeze({
      code: backendCode,
      uiCode,
      displayName: String(method.displayName || backendCode).trim(),
      accountName: String(method.accountName || '').trim(),
      accountReference: String(method.accountReference || '').trim(),
      qrImageUrl: String(method.qrImageUrl || '').trim(),
      instructions: String(method.instructions || '').trim(),
    });
    paymentMethodsByCode[backendCode] = dto;
    if (!supportedUiCodes.has(uiCode)) continue;
    if (paymentCodeAliases[uiCode] && paymentCodeAliases[uiCode] !== backendCode) {
      ambiguousUiCodes.add(uiCode);
      continue;
    }
    paymentCodeAliases[uiCode] = backendCode;
  }
  for (const uiCode of ambiguousUiCodes) delete paymentCodeAliases[uiCode];
  window.PB_PAYMENT_METHOD_CODES = Object.freeze(paymentCodeAliases);
  window.PB_PAYMENT_METHODS_BY_CODE = Object.freeze(paymentMethodsByCode);
  // The platform bootstrap is authoritative even when it returns no methods.
  // Falling back to legacy browser settings here could expose a stale or
  // placeholder destination while the server has checkout closed.
  const publicMethods = PB_PLATFORM_V1
    ? Object.keys(paymentCodeAliases)
    : Array.isArray(settings['payment.public_methods'])
      ? settings['payment.public_methods'].map(value => String(value).toLowerCase())
      : ['cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb']
        .filter(method => settings[`payment_method_${method}`] === '1');
  for (const method of ['cash', 'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb']) {
    settings[`payment_method_${method}`] = publicMethods.includes(method) ? '1' : '0';
  }
  const configFor = code => paymentMethodsByCode[paymentCodeAliases[code] || code];
  const gcash = configFor('gcash');
  const gotyme = configFor('gotyme');
  const pnb = configFor('pnb');
  if (gcash) {
    settings.gcash_merchant_number = gcash.accountReference || '';
    settings.gcash_merchant_name = gcash.accountName || '';
    settings.gcash_qr_image = gcash.qrImageUrl || '';
  }
  if (gotyme) {
    settings.gotyme_merchant_number = gotyme.accountReference || '';
    settings.gotyme_merchant_name = gotyme.accountName || '';
    settings.gotyme_qr_image = gotyme.qrImageUrl || '';
  }
  if (pnb) {
    settings.pnb_merchant_number = pnb.accountReference || '';
    settings.pnb_merchant_name = pnb.accountName || '';
    settings.pnb_qr_image = pnb.qrImageUrl || '';
  }
  return settings;
}

function _pbNormalizeTenantActivationSettings(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const venue = raw.venue && typeof raw.venue === 'object' ? raw.venue : {};
  const tenant = raw.tenant && typeof raw.tenant === 'object' ? raw.tenant : {};
  const billing = raw.platformBilling && typeof raw.platformBilling === 'object'
    ? raw.platformBilling
    : raw.billing && typeof raw.billing === 'object'
      ? raw.billing
      : null;
  const openPlayServiceFee = raw.openPlayServiceFee && typeof raw.openPlayServiceFee === 'object'
    ? raw.openPlayServiceFee
    : raw.openPlayBilling && typeof raw.openPlayBilling === 'object'
      ? raw.openPlayBilling
      : raw.openPlay && typeof raw.openPlay === 'object'
        ? raw.openPlay
        : null;
  const readiness = raw.readiness && typeof raw.readiness === 'object'
    ? { ...raw.readiness }
    : { publicBookingEnabled: false, blockingReasons: ['server_readiness_unavailable'] };
  const paymentMethods = Array.isArray(raw.paymentMethods) ? raw.paymentMethods : [];
  return {
    tenant: {
      id: tenant.id || '',
      slug: tenant.slug || PB_TENANT_SLUG,
      name: tenant.name || '',
      contactEmail: tenant.contactEmail || venue.contactEmail || '',
      replyToEmail: venue.replyToEmail || tenant.replyToEmail || '',
      emailEnabled: venue.emailEnabled === true,
      publicBookingRequested: venue.publicBookingEnabled === true ||
        readiness.requestedPublicBookingEnabled === true,
    },
    permissions: raw.permissions && typeof raw.permissions === 'object'
      ? { ...raw.permissions }
      : {},
    setupStatus: String(raw.setupStatus || 'setup_required'),
    business: raw.business && typeof raw.business === 'object' ? { ...raw.business } : {},
    billing: billing ? {
      feeMode: String(billing.feeMode || ''),
      feeAmount: Number(billing.feeAmount),
      isConfigured: billing.isConfigured === true,
    } : null,
    openPlayServiceFee: openPlayServiceFee ? {
      feeMode: String(openPlayServiceFee.feeMode || openPlayServiceFee.mode || 'fixed_per_player'),
      feeAmount: Number(
        openPlayServiceFee.feeAmount ??
        openPlayServiceFee.amount ??
        openPlayServiceFee.serviceFeePerPerson ??
        openPlayServiceFee.service_fee_per_person ??
        0
      ),
      isConfigured: typeof openPlayServiceFee.isConfigured === 'boolean'
        ? openPlayServiceFee.isConfigured
        : openPlayServiceFee.configured === true ||
        Number.isFinite(Number(
          openPlayServiceFee.feeAmount ??
          openPlayServiceFee.amount ??
          openPlayServiceFee.serviceFeePerPerson ??
          openPlayServiceFee.service_fee_per_person
        )),
    } : null,
    paymentMethods: paymentMethods.map(method => ({
      code: String(method.methodCode || method.code || '').toLowerCase(),
      displayName: method.displayName || method.methodCode || method.code || '',
      accountName: method.accountName || '',
      accountReference: method.accountNumber || method.accountReference || '',
      qrImageUrl: method.qrUrl || method.qrImageUrl || '',
      instructions: method.instructions || '',
      isActive: method.isActive === true,
      sortOrder: Number(method.sortOrder || 0),
    })).filter(method => method.code),
    readiness,
  };
}

function _pbLocalIntervalHours(startsAt, endsAt, targetDate) {
  const startText = String(startsAt || '');
  const endText = String(endsAt || '');
  const startDate = startText.slice(0, 10);
  const endDate = endText.slice(0, 10);
  if (startDate !== targetDate) return [];
  const startHour = Number(startText.slice(11, 13));
  let endHour = Number(endText.slice(11, 13));
  if (endDate > startDate && endHour === 0) endHour = 24;
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || endHour <= startHour) return [];
  return Array.from({ length: endHour - startHour }, (_, index) => startHour + index);
}

const _pbPlatformBlockedHoursByDate = new Map();

function _pbPlatformBlockLabel(value) {
  const label = String(value || '').trim().toLowerCase();
  if (label === 'private event') return 'private';
  if (['reserved', 'maintenance', 'closed', 'blocked'].includes(label)) return label;
  return 'reserved';
}

function _pbRememberPlatformBlockedHours(availability) {
  const date = String(availability?.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const rules = [];
  for (const block of (availability.blockedDates || [])) {
    let slots = _pbLocalIntervalHours(block.startsAt, block.endsAt, date);
    if (!block.startsAt && !block.endsAt) {
      slots = Array.from({ length: 24 }, (_, hour) => hour);
    }
    if (!slots.length) continue;
    rules.push(Object.freeze({
      enabled: true,
      mode: 'specific',
      dates: Object.freeze([date]),
      courtId: block.courtId == null ? null : String(block.courtId),
      slots: Object.freeze([...slots]),
      label: _pbPlatformBlockLabel(block.label),
    }));
  }
  _pbPlatformBlockedHoursByDate.set(date, Object.freeze(rules));
}

function _pbPlatformBlockedRuleFor(date, hour, courtId = null) {
  const rules = _pbPlatformBlockedHoursByDate.get(String(date || '')) || [];
  const targetHour = Number(hour);
  const targetCourt = courtId == null ? null : String(courtId);
  return rules.find(rule =>
    (rule.courtId == null || rule.courtId === targetCourt) &&
    rule.slots.includes(targetHour)
  ) || null;
}

window.PB_PLATFORM_BLOCKED_RULE_FOR = _pbPlatformBlockedRuleFor;

function _pbPlatformAvailabilityToLegacyBookings(availability, bootstrap) {
  if (!availability) return [];
  const date = availability.date;
  const courts = Array.isArray(availability.courts) ? availability.courts : [];
  const courtConfig = new Map((bootstrap?.courts || []).map(court => [String(court.id), court]));
  const rows = [];

  for (const court of courts) {
    for (const interval of (court.unavailable || [])) {
      const slots = _pbLocalIntervalHours(interval.startsAt, interval.endsAt, date);
      if (!slots.length) continue;
      rows.push({
        ref: `availability-${court.id}-${interval.startsAt}`,
        courtId: court.id,
        courtName: court.name,
        date,
        slots,
        status: 'confirmed',
        paymentStatus: 'paid',
        createdAt: null,
      });
    }
  }

  for (const block of (availability.blockedDates || [])) {
    const targetCourts = block.courtId
      ? courts.filter(court => String(court.id) === String(block.courtId))
      : courts;
    for (const court of targetCourts) {
      const config = courtConfig.get(String(court.id)) || {};
      let slots = _pbLocalIntervalHours(block.startsAt, block.endsAt, date);
      if (!block.startsAt && !block.endsAt) {
        const open = _pbClockHour(config.opensAt);
        const close = String(config.closesAt || '').startsWith('00:00')
          ? 24
          : _pbClockHour(config.closesAt, true);
        slots = Number.isInteger(open) && Number.isInteger(close) && close > open
          ? Array.from({ length: close - open }, (_, index) => open + index)
          : [];
      }
      if (!slots.length) continue;
      rows.push({
        ref: `closure-${court.id}-${date}-${slots[0]}`,
        courtId: court.id,
        courtName: court.name,
        date,
        slots,
        status: 'maintenance',
        paymentStatus: 'unpaid',
        publicLabel: block.label || 'Unavailable',
        createdAt: null,
      });
    }
  }
  return rows;
}

function _safeJsonParse(v) {
  try { return JSON.parse(v); } catch(_) { return null; }
}

function _pbApiErrorMessage(payload, rawText = '', fallback = 'Request failed') {
  if (payload?.error && typeof payload.error === 'object' && payload.error.message) {
    return String(payload.error.message);
  }
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  return String(rawText || fallback);
}

function _pbIsUnsupportedSettingsPatchError(error) {
  return /settings patch contains an unsupported field/i.test(_extractFnError(error, ''));
}

function _pbFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('Receipt screenshot is required.')); return; }
    if (typeof FileReader !== 'function') { reject(new Error('This browser cannot read the selected receipt.')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected receipt.'));
    reader.readAsDataURL(file);
  });
}

async function _pbPrepareReceiptImage(file) {
  if (!file) throw new Error('Receipt screenshot is required.');
  const maxReceiptBytes = 8 * 1024 * 1024;
  if (Number(file.size || 0) > maxReceiptBytes) throw new Error('The receipt image must be 8 MB or smaller.');
  const rawType = String(file.type || '').toLowerCase();
  const type = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
  const directlySupported = ['image/jpeg', 'image/png', 'image/webp'].includes(type);
  const targetBytes = 1250 * 1024;

  // Small normal screenshots should stay byte-for-byte unchanged. Normalize
  // the non-standard image/jpg MIME label because Storage expects image/jpeg.
  if (file.size <= targetBytes && directlySupported) {
    if (rawType === type) return file;
    try { return file.slice(0, file.size, type); } catch (_) { return file; }
  }

  // Reduce large phone screenshots before crossing a fragile embedded-browser
  // bridge. If the WebView cannot decode/canvas the image, retain the original
  // and let the multipart/Base64 transport fallback handle it.
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return file;
  let objectUrl = '';
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('The selected receipt image could not be decoded.'));
      el.src = objectUrl;
    });
    const maxDimension = 1800;
    const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);
    const encode = quality => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    let encoded = await encode(0.84);
    if (encoded?.size > targetBytes) encoded = await encode(0.72);
    const output = encoded?.size ? encoded : file;
    if (Number(output.size || 0) > maxReceiptBytes) throw new Error('The receipt image must be 8 MB or smaller.');
    return output;
  } catch (_) {
    return file;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile) {
  const imageBase64 = await _pbFileToDataUrl(imageFile);
  const fallbackPayload = {
    action: 'verify',
    bookingRef: String(payload?.bookingRef || ''),
    provider: String(payload?.provider || 'gcash'),
    contentType: imageFile?.type || payload?.contentType || 'image/jpeg',
    imageBase64,
    ...(payload?.bookingData ? { bookingData: payload.bookingData } : {}),
  };
  const res = await _pbFetchWithTimeout(fnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(fallbackPayload),
  }, PB_RECEIPT_TIMEOUT_MS);
  const txt = await res.text();
  const json = _safeJsonParse(txt);
  if (!res.ok) throw new Error(json?.error || txt || `HTTP ${res.status}`);
  if (!json) throw new Error('Receipt verification returned an invalid response.');
  return json;
}

function _extractFnError(err, fallback = 'Edge Function request failed') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (err.error_description) return String(err.error_description);
  if (err.error) return String(err.error);
  if (err.context) {
    const parsed = _safeJsonParse(err.context);
    if (parsed?.error) return String(parsed.error);
    if (typeof err.context === 'string') return err.context;
  }
  try { return JSON.stringify(err); } catch(_) { return fallback; }
}

async function _invokePaymentSessionFallback(payload) {
  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/create-payment-session`;
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

  let res;
  try {
    res = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Edge Function endpoint (${fnUrl}). ${_extractFnError(networkErr, 'Network error')}`);
  }

  const txt = await res.text();
  const json = _safeJsonParse(txt);
  if (!res.ok) {
    const reason = json?.error || txt || `HTTP ${res.status}`;
    throw new Error(`Edge Function HTTP ${res.status}: ${reason}`);
  }
  if (!json || json.ok !== true || !json.checkoutUrl) {
    throw new Error(`Invalid Edge Function response: ${txt || 'empty body'}`);
  }
  return json;
}

async function _invokeEdgeFunction(name, payload = {}, { allowFailure = false, preferDirect = false } = {}) {
  const endpoint = String(name).split('?')[0];
  const guestEndpoint = ['create-booking','booking-status','cancel-booking','balance-payment-status','player-rain-report'].includes(endpoint);
  if (PB_PLATFORM_V1 && payload.tenantSlug !== PB_TENANT_SLUG) throw new Error('A venue-scoped request is required.');
  if (guestEndpoint) preferDirect = true;
  let data = null;
  let error = null;
  if (!preferDirect) {
    try {
      ({ data, error } = await _sb.functions.invoke(name, { body: payload }));
    } catch (invokeErr) {
      error = invokeErr;
    }
    if (!error && data) return data;
  }

  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${name}`;
  const sess = guestEndpoint ? null : await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

  try {
    const res = await _pbFetchWithTimeout(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    const json = _safeJsonParse(txt) || {};
    if (!res.ok) {
      const failure = new Error(_pbApiErrorMessage(json, txt, `HTTP ${res.status}`));
      failure.code = json?.error?.code || null;
      failure.httpStatus = res.status;
      throw failure;
    }
    return json;
  } catch (fallbackErr) {
    const fallbackReason = _extractFnError(fallbackErr, 'Fallback call failed');
    const reason = error ? `${_extractFnError(error, 'Function invoke failed')}. ${fallbackReason}` : fallbackReason;
    if (allowFailure) return { ok: false, error: reason };
    const failure = new Error(reason);
    failure.code = fallbackErr?.code || null;
    failure.httpStatus = fallbackErr?.httpStatus || null;
    throw failure;
  }
}

async function _authRestHeaders(extra = {}) {
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
    ...extra,
  };
}

function _bookingEmailPayload(b) {
  const items = Array.isArray(b.items) && b.items.length
    ? b.items
    : Array.isArray(b.groupItems) && b.groupItems.length
      ? b.groupItems
      : [];
  return {
    bookingRef: b.displayRef || b.ref,
    email: b.email,
    fullName: b.fullName,
    courtName: b.courtName,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    duration: b.duration,
    total: b.total,
    downpayment: b.paymentStatus === 'paid' ? Number(b.total || 0) : (b.downpayment || Math.round((b.total || 0) * 0.5)),
    hostBooking: !!b.hostBooking,
    balanceDueAt: b.balanceDueAt || null,
    remainingBalance: b.paymentStatus === 'paid' ? 0 : Math.max(0, Number(b.total || 0) - Number(b.downpayment || 0)),
    contactNumber: b.contactNumber,
    bookingItems: items.map(item => ({
      courtName: item.courtName,
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      duration: item.duration,
      total: item.total,
      downpayment: item.downpayment,
    })),
  };
}

function _telegramBookingPayload(b, extras = {}) {
  return {
    bookingRef: b.ref,
    fullName: b.fullName,
    contactNumber: b.contactNumber,
    courtName: b.courtName,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    duration: b.duration,
    total: b.total,
    downpayment: b.downpayment || Math.round((b.total || 0) * 0.5),
    paymentMethod: b.paymentMethod,
    paymentStatus: b.paymentStatus,
    bookingStatus: b.status,
    gcashRef: b.gcashRef || null,
    ...extras,
  };
}

// =============================================
// ROW ↔ JS OBJECT MAPPING
// SQL uses snake_case; JS objects use camelCase
// =============================================
const PB_DIGITAL_PAYMENT_METHODS = ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb'];

function normalizePaymentKey(value, fallback = '') {
  return String(value || fallback || '').toLowerCase().trim();
}

function receivedAccountForBooking(b = {}) {
  const explicit = normalizePaymentKey(b.receivedAccount || b.received_account);
  if (explicit) return explicit;

  const method = normalizePaymentKey(b.paymentMethod || b.payment_method, 'cash');
  return method;
}

function _fmtBookingHour(h) {
  const hour = Number(h);
  if (!Number.isFinite(hour)) return '';
  const normalized = ((hour % 24) + 24) % 24;
  const labelHour = normalized % 12 || 12;
  const suffix = normalized < 12 ? 'AM' : 'PM';
  return `${labelHour}:00 ${suffix}`;
}

function _bookingSlotsTimeLabel(slots, fallbackStart = '', fallbackEnd = '') {
  const sorted = [...(slots || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallbackStart && fallbackEnd ? `${fallbackStart} - ${fallbackEnd}` : '';
  const groups = [];
  sorted.forEach(h => {
    const last = groups[groups.length - 1];
    if (last && h === last.end) last.end = h + 1;
    else groups.push({ start: h, end: h + 1 });
  });
  return groups.map(g => `${_fmtBookingHour(g.start)} - ${_fmtBookingHour(g.end)}`).join(', ');
}

function rowToBooking(r) {
  const slots = r.slots || [];
  return {
    ref:           r.ref,
    groupRef:      r.booking_group_ref || null,
    fullName:      r.full_name,
    contactNumber: r.contact_number,
    email:         r.email,
    courtId:       r.court_id,
    courtName:     r.court_name,
    date:          r.date,
    slots,
    startTime:     r.start_time,
    endTime:       r.end_time,
    timeLabel:     _bookingSlotsTimeLabel(slots, r.start_time, r.end_time),
    duration:      r.duration,
    rate:          r.rate,
    total:         r.total,
    paymentMethod: r.payment_method,
    receivedAccount: receivedAccountForBooking(r),
    paymentFlow:   r.payment_flow || null,
    paymentStatus: r.payment_status || 'unpaid',
    paymentProvider: r.payment_provider || null,
    paymentSessionId: r.payment_session_id || null,
    paymentCheckoutUrl: r.payment_checkout_url || null,
    paidAt:        r.paid_at || null,
    gcashRef:      r.gcash_ref || null,
    downpayment:   r.downpayment || null,
    bookingType:   r.booking_type || 'regular',
    eventType:     r.event_type || null,
    eventGuestCount: r.event_guest_count != null ? Number(r.event_guest_count) : null,
    eventSetupNotes: r.event_setup_notes || null,
    balanceDueAt:  r.balance_due_at || null,
    forfeitedAt:   r.forfeited_at || null,
    forfeitureReason: r.forfeiture_reason || null,
    hostBooking:   !!r.host_booking,
    hostUserId:    r.host_user_id || null,
    hostName:      r.host_name || null,
    hostEmail:     r.host_email || null,
    createdVia:    r.created_via || 'customer',
    createdByUserId: r.created_by_user_id || null,
    createdByRole:   r.created_by_role || null,
    createdByName:   r.created_by_name || null,
    createdByEmail:  r.created_by_email || null,
    receiptStatus:     r.receipt_status || 'none',
    receiptFlags:      r.receipt_flags || [],
    receiptExtracted:  r.receipt_extracted || null,
    receiptConfidence: r.receipt_confidence != null ? Number(r.receipt_confidence) : null,
    receiptImageUrl:   r.receipt_image_url || null,
    receiptVerifiedAt: r.receipt_verified_at || null,
    billedAt:      r.billed_at || null,
    weeklyFeeId:   r.weekly_fee_id || null,
    confirmationEmailId: r.confirmation_email_id || null,
    confirmationEmailSentAt: r.confirmation_email_sent_at || null,
    confirmationEmailLastEvent: r.confirmation_email_last_event || null,
    status:        r.status,
    createdAt:     r.created_at,
  };
}

function archivePayloadToBooking(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return Object.prototype.hasOwnProperty.call(payload, 'full_name') || Object.prototype.hasOwnProperty.call(payload, 'court_id')
    ? rowToBooking(payload)
    : payload;
}

function rowToDeletedBookingArchive(r) {
  return {
    id: r.id,
    bookingRef: r.booking_ref,
    source: r.source,
    originalBooking: archivePayloadToBooking(r.original_booking),
    originalBookingRow: r.original_booking || null,
    recoveredBooking: archivePayloadToBooking(r.recovered_booking),
    recoveredBookingRow: r.recovered_booking || null,
    recoveryStatus: r.recovery_status,
    recoveredFrom: r.recovered_from,
    notes: r.notes,
    voidedFeeAmount: r.voided_fee_amount,
    voidReason: r.void_reason,
    voidedAt: r.voided_at,
    voidedBy: r.voided_by,
    deletedAt: r.deleted_at,
    archivedAt: r.archived_at,
    restoredAt: r.restored_at,
    restoredBy: r.restored_by,
    createdAt: r.created_at,
  };
}

const PB_RESERVATION_HOLD_MINUTES = 15;

function bookingHoldsSlotForConflict(b) {
  if (!b || b.status === 'cancelled' || b.status === 'forfeited') return false;
  if (b.status !== 'verifying') return true;

  const created = b.created_at || b.createdAt;
  if (!created) return true;

  const createdMs = new Date(created).getTime();
  if (!Number.isFinite(createdMs)) return true;

  return (Date.now() - createdMs) < PB_RESERVATION_HOLD_MINUTES * 60 * 1000;
}

function hasSlotConflict(existingBookings, booking) {
  const requested = new Set((booking.slots || []).map(Number));
  if (requested.size === 0) return false;

  return (existingBookings || [])
    .filter(bookingHoldsSlotForConflict)
    .flatMap(b => b.slots || [])
    .some(slot => requested.has(Number(slot)));
}

function bookingToRow(b) {
  return {
    ref:            b.ref,
    booking_group_ref: b.groupRef || null,
    full_name:      b.fullName,
    contact_number: b.contactNumber,
    email:          b.email,
    court_id:       b.courtId,
    court_name:     b.courtName,
    date:           b.date,
    slots:          b.slots,
    start_time:     b.startTime,
    end_time:       b.endTime,
    duration:       b.duration,
    rate:           b.rate,
    total:          b.total,
    payment_method: b.paymentMethod,
    received_account: receivedAccountForBooking(b),
    payment_flow:   b.paymentFlow || null,
    payment_status: b.paymentStatus || 'unpaid',
    payment_provider: b.paymentProvider || null,
    payment_session_id: b.paymentSessionId || null,
    payment_checkout_url: b.paymentCheckoutUrl || null,
    paid_at:        b.paidAt || null,
    gcash_ref:      b.gcashRef || null,
    downpayment:    b.downpayment || null,
    booking_type:   b.bookingType || 'regular',
    event_type:     b.eventType || null,
    event_guest_count: b.eventGuestCount || null,
    event_setup_notes: b.eventSetupNotes || null,
    host_booking:   !!b.hostBooking,
    host_user_id:   b.hostUserId || null,
    host_name:      b.hostName || null,
    host_email:     b.hostEmail || null,
    created_via:    b.createdVia || 'customer',
    created_by_user_id: b.createdByUserId || null,
    created_by_role:    b.createdByRole || null,
    created_by_name:    b.createdByName || null,
    created_by_email:   b.createdByEmail || null,
    status:         b.status,
    created_at:     b.createdAt,
  };
}

function withoutOptionalBookingColumns(row) {
  const copy = { ...row };
  delete copy.host_booking;
  delete copy.host_user_id;
  delete copy.host_name;
  delete copy.host_email;
  delete copy.created_via;
  delete copy.created_by_user_id;
  delete copy.created_by_role;
  delete copy.created_by_name;
  delete copy.created_by_email;
  return copy;
}

function isMissingOptionalBookingColumnError(error) {
  return /host_booking|host_user_id|host_name|host_email|created_via|created_by_user_id|created_by_role|created_by_name|created_by_email/i.test(error?.message || '');
}

function rowToCourt(r) {
  return {
    id:           r.id,
    name:         r.name,
    desc:         r.description,
    rate:         r.rate,
    blocked:      r.blocked,
    feats:        r.feats || [],
    photo:        r.photo || '',
    rateSchedule: r.rate_schedule || null,
  };
}

function courtToRow(c) {
  return {
    id:            c.id,
    name:          c.name,
    description:   c.desc,
    rate:          c.rate,
    blocked:       c.blocked,
    feats:         c.feats || [],
    photo:         c.photo || null,
    rate_schedule: c.rateSchedule || null,
  };
}

function rowToAccount(r) {
  return {
    id:        r.id,
    username:  r.username,
    role:      r.role,
    status:    r.status || 'active',
    fullName:  r.full_name,
    email:     r.email,
    createdAt: r.created_at,
  };
}

function _remittanceProofUpload(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error('Choose a valid receipt image.');
  const mimeType = match[1].toLowerCase();
  const binary = atob(match[2].replace(/\s/g, ''));
  if (!binary.length) throw new Error('The receipt image is empty.');
  if (binary.length > 5 * 1024 * 1024) throw new Error('Receipt image must be 5 MB or smaller.');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const extByType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  if (!extByType[mimeType]) {
    throw new Error('Receipt must be a JPG, PNG, or WebP image.');
  }
  return { bytes, mimeType, extension: extByType[mimeType] };
}

function _remittanceIdempotencyKey(prefix = 'remit') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function rowToHostFinanceAccount(r = {}) {
  const id = r.id || r.host_user_id || r.hostUserId || null;
  return {
    id,
    fullName:  r.full_name ?? r.fullName ?? '',
    email:     r.email ?? '',
    role:      'host',
    status:    r.status || 'active',
    createdAt: r.created_at ?? r.createdAt ?? null,
  };
}

function accountToRow(a) {
  return {
    id:         a.id,
    username:   a.username,
    role:       a.role,
    status:     a.status || 'active',
    full_name:  a.fullName,
    email:      a.email,
    created_at: a.createdAt,
  };
}

// =============================================
// DB — Async Data Layer (replaces localStorage)
// =============================================
const PB_REFUND_RESCHEDULE_POLICY_KEY = 'refund_reschedule_policy';

function _pbApprovedRefundPolicyForWrite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('The refund and reschedule policy must be a policy object.');
  }

  const version = String(input.version || '').trim();
  const title = String(input.title || '').trim();
  const intro = String(input.intro || '').trim();
  const content = String(input.content || '').replace(/\r\n?/g, '\n').trim();

  if (input.ownerApproved !== true) {
    throw new Error('The court owner must explicitly approve the exact policy terms before publication.');
  }
  if (!/^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(version) ||
      /setup|required|unapproved|draft/i.test(version)) {
    throw new Error('Enter a published policy version using 3–120 letters, numbers, dots, underscores, colons, or hyphens.');
  }
  if (title.length < 3 || title.length > 180) {
    throw new Error('Enter a policy title between 3 and 180 characters.');
  }
  if (intro.length < 10 || intro.length > 1200) {
    throw new Error('Enter a policy introduction between 10 and 1,200 characters.');
  }
  if (content.length < 20 || content.length > 30000) {
    throw new Error('Enter the exact policy terms between 20 and 30,000 characters.');
  }

  return { version, title, intro, content, ownerApproved: true };
}

window.DB = {

  async getResolvedTenantId() {
    if (!PB_PLATFORM_V1) return null;
    const bootstrap = await _pbPlatformBootstrap();
    const tenantId = String(bootstrap?.tenant?.id || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new Error('The booking website could not verify its tenant identity.');
    }
    return tenantId;
  },

  // ---- COURTS ----
  async getCourts() {
    if (PB_PLATFORM_V1) {
      return _pbCached('courts', {}, PB_FAST_CACHE_MS.courts, async () => {
        const session = await _pbAuthenticatedSession();
        const dashboardSession = window.Auth?.getSession?.() || {};
        const membershipRole = String(dashboardSession.membershipRole || '').toLowerCase();
        const canManageTenant = dashboardSession.role === 'owner' || ['owner', 'admin'].includes(membershipRole);
        if (session && canManageTenant && PB_PAGE_DATA_SCOPE === 'manager') {
          const { data, error } = await _sb.rpc('get_tenant_courts_for_manager', {
            p_tenant_slug: PB_TENANT_SLUG,
            p_hostname: _pbTenantHostname(),
          });
          if (error) throw error;
          return (data || []).map(_pbPlatformRawCourtToLegacy);
        }
        const bootstrap = await _pbPlatformBootstrap();
        return bootstrap.courts.map(_pbPublicPlatformCourtToLegacy);
      });
    }
    return _pbCached('courts', {}, PB_FAST_CACHE_MS.courts, async () => {
      const { data, error } = await _sb.from('courts').select('*').order('id');
      if (error) { console.error('getCourts:', error); return []; }
      return data.map(rowToCourt);
    });
  },

  async saveCourt(court) {
    if (PB_PLATFORM_V1) {
      if (!await _pbAuthenticatedSession()) throw new Error('Your session is no longer available. Please sign in again.');
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(court.id || ''));
      const existing = isUuid
        ? (await this.getCourts()).find(candidate => String(candidate.id) === String(court.id)) || null
        : null;
      const bands = Array.isArray(court.rateSchedule) && court.rateSchedule.length
        ? court.rateSchedule
        : [];
      if (!bands.length) throw new Error('At least one regular rate band is required.');
      const suppliedRegular = court.pricingConfig?.regular || existing?.pricingConfig?.regular || {};
      const minimumHours = suppliedRegular.minimumHours;
      if (!Number.isInteger(minimumHours) || minimumHours < 1 || minimumHours > 18) {
        throw new Error('Regular booking minimum hours must be configured from 1 to 18.');
      }
      const suppliedPublic = court.publicConfig || existing?.publicConfig || {};
      const minimumLeadMinutes = suppliedPublic.minimumLeadMinutes;
      const maximumAdvanceDays = suppliedPublic.maximumAdvanceDays;
      if (!Number.isInteger(minimumLeadMinutes) || minimumLeadMinutes < 0 || minimumLeadMinutes > 10080) {
        throw new Error('Minimum booking notice must be configured from 0 to 10080 minutes.');
      }
      if (!Number.isInteger(maximumAdvanceDays) || maximumAdvanceDays < 0 || maximumAdvanceDays > 730) {
        throw new Error('Booking horizon must be configured from 0 to 730 days.');
      }
      const pricingConfig = {
        ...(existing?.pricingConfig || court.pricingConfig || {}),
        regular: {
          ...(existing?.pricingConfig?.regular || court.pricingConfig?.regular || {}),
          // The protected receipt workflow verifies the immutable full booking
          // total. Do not advertise or persist a downpayment mode that the
          // server cannot safely reconcile yet.
          fullPaymentRequired: true,
          minimumHours,
          bands: bands.map(band => ({
            start: `${String(Number(band.from)).padStart(2, '0')}:00`,
            end: Number(band.to) === 24 ? '24:00' : `${String(Number(band.to)).padStart(2, '0')}:00`,
            hourlyRate: Number(band.rate),
          })),
        },
        event: {
          ...(existing?.pricingConfig?.event || court.pricingConfig?.event || {}),
          ...(court.pricingConfig?.event || {}),
          fullPaymentRequired: true,
        },
      };
      const status = String(court.status || existing?.status || (court.blocked ? 'maintenance' : 'inactive')).toLowerCase();
      if (!['active', 'inactive', 'maintenance'].includes(status)) throw new Error('The court status is invalid.');
      const sortOrder = Number(court.sortOrder ?? existing?.sortOrder ?? 0);
      if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) throw new Error('The court display order is invalid.');
      const opensAt = String(court.opensAt || existing?.opensAt || '').slice(0, 5);
      const closesAt = String(court.closesAt || existing?.closesAt || '').slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(opensAt) || !/^\d{2}:\d{2}$/.test(closesAt)) {
        throw new Error('Valid court opening and closing times are required.');
      }
      const surface = String(court.surface || court.publicConfig?.surface || court.feats?.[0] || '').trim();
      const patch = {
        slug: existing?.slug || court.slug || String(court.name || 'court')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        name: court.name,
        description: court.desc || null,
        status,
        sortOrder,
        opensAt,
        closesAt,
        currency: existing?.currency || court.currency || 'PHP',
        pricingConfig,
        publicConfig: {
          ...(existing?.publicConfig || court.publicConfig || {}),
          minimumLeadMinutes,
          maximumAdvanceDays,
          photoUrl: court.photo || null,
          surface: surface || null,
          eventPackageEnabled: pricingConfig.event?.enabled === true,
        },
      };
      const { error } = await _sb.rpc('manage_tenant_court', {
        p_tenant_slug: PB_TENANT_SLUG,
        p_hostname: _pbTenantHostname(),
        p_action: 'save',
        p_court_id: isUuid ? court.id : null,
        p_patch: patch,
      });
      if (error) throw error;
      _pbClearFastCache(['courts', 'settings', 'platformBootstrap']);
      return;
    }
    const { error } = await _sb.from('courts').upsert(courtToRow(court));
    if (error) { console.error('saveCourt:', error); throw error; }
    _pbClearFastCache(['courts']);
  },

  async saveSharedCourtSchedule({ opensAt, closesAt, rateSchedule }) {
    if (!PB_PLATFORM_V1) throw new Error('Shared court schedules require the protected platform backend.');
    if (!await _pbAuthenticatedSession()) throw new Error('Your session is no longer available. Please sign in again.');
    const open = String(opensAt || '').slice(0, 5);
    const close = String(closesAt || '').slice(0, 5);
    if (!/^\d{2}:00$/.test(open) || !/^\d{2}:00$/.test(close)) {
      throw new Error('Shared court hours must use whole-hour times.');
    }
    const bands = (Array.isArray(rateSchedule) ? rateSchedule : []).map(band => ({
      start: `${String(Number(band.from)).padStart(2, '0')}:00`,
      end: Number(band.to) === 24 ? '24:00' : `${String(Number(band.to)).padStart(2, '0')}:00`,
      hourlyRate: Number(band.rate),
    }));
    if (!bands.length) throw new Error('At least one shared pricing tier is required.');
    const { data, error } = await _sb.rpc('apply_shared_tenant_court_schedule', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_opens_at: open,
      p_closes_at: close,
      p_bands: bands,
    });
    if (error) throw new Error(_extractFnError(error, 'The shared court schedule was not saved'));
    _pbClearFastCache(['courts', 'settings', 'platformBootstrap', 'platformAvailability']);
    return data;
  },

  async deleteCourt(id) {
    if (PB_PLATFORM_V1) {
      if (!await _pbAuthenticatedSession()) throw new Error('Your session is no longer available. Please sign in again.');
      const { error } = await _sb.rpc('manage_tenant_court', {
        p_tenant_slug: PB_TENANT_SLUG,
        p_hostname: _pbTenantHostname(),
        p_action: 'delete',
        p_court_id: id,
        p_patch: {},
      });
      if (error) throw error;
      _pbClearFastCache(['courts', 'settings', 'platformBootstrap']);
      return;
    }
    const { error } = await _sb.from('courts').delete().eq('id', id);
    if (error) console.error('deleteCourt:', error);
    _pbClearFastCache(['courts']);
  },

  // ---- BOOKINGS ----
  async getBookings(filters = {}) {
    const opts = filters || {};
    if (PB_PLATFORM_V1) {
      return _pbCached('bookings', opts, PB_FAST_CACHE_MS.bookings, async () => {
        if (PB_PAGE_DATA_SCOPE !== 'manager' || opts.publicAvailability === true) {
          if (!opts.date) return [];
          const [availability, bootstrap] = await Promise.all([
            _pbPlatformAvailability(opts.date),
            _pbPlatformBootstrap(),
          ]);
          return _pbPlatformAvailabilityToLegacyBookings(availability, bootstrap)
            .filter(row => !opts.courtId || String(row.courtId) === String(opts.courtId));
        }

        const session = await _pbAuthenticatedSession();
        if (!session) {
          if (!opts.date) return [];
          const [availability, bootstrap] = await Promise.all([
            _pbPlatformAvailability(opts.date),
            _pbPlatformBootstrap(),
          ]);
          return _pbPlatformAvailabilityToLegacyBookings(availability, bootstrap)
            .filter(row => !opts.courtId || String(row.courtId) === String(opts.courtId));
        }

        const request = _invokeEdgeFunction(
          `tenant-manager-data?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
          {
            action: 'list-bookings',
            tenantSlug: PB_TENANT_SLUG,
            filters: {
              ...(opts.date ? { date: opts.date } : {}),
              ...(opts.courtId ? { courtId: String(opts.courtId) } : {}),
              activeOnly: opts.activeOnly === true,
              archiveState: 'active',
              limit: 500,
            },
          },
          { preferDirect: true }
        );
        const [result, courts, bootstrap] = await Promise.all([
          request,
          this.getCourts(),
          _pbPlatformBootstrap(),
        ]);
        if (!result?.ok || !Array.isArray(result.bookings)) {
          throw new Error('The tenant booking list could not be loaded.');
        }
        const courtMap = new Map(courts.map(court => [String(court.id), court]));
        return result.bookings.map(row => _pbPlatformBookingToLegacy(
          row,
          courtMap,
          bootstrap?.tenant?.timezone || 'Asia/Manila'
        ));
      });
    }
    return _pbCached('bookings', opts, PB_FAST_CACHE_MS.bookings, async () => {
      let query = _sb.from('bookings').select('*').order('created_at', { ascending: false });
      if (opts.date) query = query.eq('date', opts.date);
      if (opts.courtId) query = query.eq('court_id', String(opts.courtId));
      if (opts.hostUserId) query = query.eq('host_user_id', String(opts.hostUserId));
      if (opts.activeOnly) query = query.neq('status', 'cancelled').neq('status', 'forfeited');
      const { data, error } = await query;
      if (error) {
        console.error('getBookings:', error);
        // Host history is an authenticated, identity-scoped view. Surface an
        // RLS/schema failure instead of presenting it as an empty history.
        if (opts.hostUserId) throw error;
        return [];
      }
      return data.map(rowToBooking);
    });
  },

  async addBooking(booking) {
    if (PB_PLATFORM_V1) {
      const error = new Error('Direct booking writes are disabled. Use the protected booking service.');
      error.code = 'PLATFORM_BOOKING_API_REQUIRED';
      throw error;
    }
    // Check for slot conflicts before inserting
    const { data: existing } = await _sb
      .from('bookings')
      .select('ref, status, slots, created_at')
      .eq('court_id', booking.courtId)
      .eq('date', booking.date)
      .neq('status', 'cancelled')
      .neq('status', 'forfeited');

    if (hasSlotConflict(existing, booking)) {
      throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
    }

    const row = bookingToRow(booking);
    let { error } = await _sb.from('bookings').insert(row);
    if (error && isMissingOptionalBookingColumnError(error) && !booking.hostBooking) {
      ({ error } = await _sb.from('bookings').insert(withoutOptionalBookingColumns(row)));
    }
    if (error) { console.error('addBooking:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async getBookingByRef(ref) {
    if (PB_PLATFORM_V1 && PB_PAGE_DATA_SCOPE !== 'manager') return null;
    if (PB_PLATFORM_V1) {
      const session = await _pbAuthenticatedSession();
      if (!session) return null;
      const result = await _invokeEdgeFunction(
        `tenant-manager-data?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
        {
          action: 'get-booking',
          tenantSlug: PB_TENANT_SLUG,
          bookingReference: String(ref || '').toUpperCase(),
        },
        { preferDirect: true }
      );
      if (!result?.ok) throw new Error('The tenant booking could not be loaded.');
      if (!result.booking) return null;
      const [courts, bootstrap] = await Promise.all([this.getCourts(), _pbPlatformBootstrap()]);
      return _pbPlatformBookingToLegacy(
        result.booking,
        new Map(courts.map(court => [String(court.id), court])),
        bootstrap?.tenant?.timezone || 'Asia/Manila'
      );
    }
    const { data, error } = await _sb.from('bookings').select('*').eq('ref', ref).single();
    if (error) { console.error('getBookingByRef:', error); return null; }
    return rowToBooking(data);
  },

  async getWeatherRefund(bookingReference) {
    const reference = String(bookingReference || '').trim().toUpperCase();
    if (!reference) throw new Error('Booking reference is required.');
    try {
      const result = await _pbManageWeatherRefund('get', { bookingReference: reference });
      return _pbNormalizeWeatherRefund(result.incident, { kind:'incident' });
    } catch (error) {
      if (error?.code === 'WEATHER_REFUND_NOT_FOUND' || error?.httpStatus === 404) return null;
      throw error;
    }
  },

  async listPlayerRainClaims(filters = {}) {
    const input = filters && typeof filters === 'object' ? filters : {};
    const status = String(input.status || '').trim().toLowerCase();
    const bookingDate = String(input.bookingDate || '').trim();
    const beforeReportedAt = String(input.beforeReportedAt || '').trim();
    const beforeClaimId = String(input.beforeClaimId || '').trim();
    const limit = Math.max(1,Math.min(250,Number(input.limit) || 250));
    if (status && !['awaiting_proof','submitted','approved','rejected','expired'].includes(status)) {
      throw new Error('Choose a valid player rain-report status.');
    }
    if (bookingDate && !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
      throw new Error('Choose a valid booking date.');
    }
    if (beforeReportedAt && Number.isNaN(new Date(beforeReportedAt).getTime())) {
      throw new Error('The player rain-report cursor timestamp is invalid.');
    }
    if (beforeClaimId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(beforeClaimId)) {
      throw new Error('The player rain-report cursor ID is invalid.');
    }
    if (Boolean(beforeReportedAt) !== Boolean(beforeClaimId)) {
      throw new Error('Both player rain-report cursor fields are required.');
    }
    const result = await _pbManageWeatherRefund('list-player-claims', {
      filters: {
        ...(status ? { status } : {}),
        ...(bookingDate ? { bookingDate } : {}),
        ...(beforeReportedAt ? { beforeReportedAt } : {}),
        ...(beforeClaimId ? { beforeClaimId } : {}),
        limit,
      },
    });
    if (!Array.isArray(result.claims) || !result.page || typeof result.page !== 'object') {
      throw new Error('Player rain reports are temporarily unavailable.');
    }
    const claims = result.claims.map(_pbNormalizePlayerRainClaim).filter(Boolean);
    if (claims.length !== result.claims.length) {
      throw new Error('A player rain report could not be verified. Please refresh and try again.');
    }
    const page = result.page;
    const count = Number(page.count ?? page.returnedCount ?? claims.length);
    const returnedCount = Number(page.returnedCount ?? count);
    const totalCount = Number(page.totalCount);
    if (!Number.isInteger(count) || count < 0 || !Number.isInteger(returnedCount) || returnedCount < 0 ||
        count !== claims.length || returnedCount !== claims.length ||
        !Number.isInteger(totalCount) || totalCount < claims.length) {
      throw new Error('The player rain-report list totals are invalid. Please refresh and try again.');
    }
    const rawNext = page.nextCursor && typeof page.nextCursor === 'object' ? page.nextCursor : null;
    const nextCursor = rawNext
      ? {
          beforeReportedAt:String(rawNext.beforeReportedAt || '').trim(),
          beforeClaimId:String(rawNext.beforeClaimId || '').trim(),
        }
      : null;
    if (rawNext && (!nextCursor.beforeReportedAt ||
        Number.isNaN(new Date(nextCursor.beforeReportedAt).getTime()) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nextCursor.beforeClaimId))) {
      throw new Error('The player rain-report list cursor is invalid. Please refresh and try again.');
    }
    return {
      claims,
      page: {
        limit:Number(page.limit || limit),
        count,
        returnedCount,
        totalCount,
        nextCursor,
      },
    };
  },

  async listAllPlayerRainClaims(filters = {}) {
    const input = filters && typeof filters === 'object' ? { ...filters } : {};
    delete input.beforeReportedAt;
    delete input.beforeClaimId;
    const claims = [];
    const claimIds = new Set();
    const cursorKeys = new Set();
    let cursor = null;
    let totalCount = null;
    for (let pageIndex = 0; pageIndex < 1000; pageIndex += 1) {
      const pageResult = await this.listPlayerRainClaims({
        ...input,
        limit:250,
        ...(cursor || {}),
      });
      totalCount = Number(pageResult.page.totalCount);
      pageResult.claims.forEach(claim => {
        if (!claimIds.has(claim.id)) {
          claimIds.add(claim.id);
          claims.push(claim);
        }
      });
      cursor = pageResult.page.nextCursor;
      if (!cursor) {
        if (Number.isFinite(totalCount) && totalCount > claims.length) {
          throw new Error('The player rain-report list ended before every record was loaded.');
        }
        return {
          claims,
          page:{ totalCount:totalCount ?? claims.length,count:claims.length,nextCursor:null },
        };
      }
      const cursorKey = `${cursor.beforeReportedAt}|${cursor.beforeClaimId}`;
      if (cursorKeys.has(cursorKey)) {
        throw new Error('The player rain-report list returned a repeated cursor.');
      }
      cursorKeys.add(cursorKey);
    }
    throw new Error('The player rain-report list is too large to load safely.');
  },

  async getPlayerRainClaim(claimId) {
    const requestedId = String(claimId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestedId)) {
      throw new Error('The player rain report could not be verified.');
    }
    const result = await _pbManageWeatherRefund('get-player-claim', {
      claimId: requestedId,
    });
    const claim = _pbNormalizePlayerRainClaim(result.claim);
    if (!claim || claim.id.toLowerCase() !== requestedId) {
      throw new Error('The player rain report could not be verified.');
    }
    return claim;
  },

  async getPlayerRainProof(claimId) {
    const result = await _pbManageWeatherRefund('get-player-proof', {
      claimId: String(claimId || '').trim(),
    });
    const signedUrl = String(result.signedUrl || '').trim();
    let url = null;
    try { url = new URL(signedUrl); } catch (_) {}
    if (!url || url.protocol !== 'https:' || url.username || url.password ||
        String(result.claimId || '').trim().toLowerCase() !== String(claimId || '').trim().toLowerCase()) {
      throw new Error('The private court photo is temporarily unavailable.');
    }
    return {
      claimId: String(result.claimId),
      signedUrl,
      expiresIn: Number(result.expiresIn || 300),
    };
  },

  async approvePlayerRainClaim(claimId, {
    decisionNote = '',
    actualPlayStartedAtOverride = '',
    playStartOverrideReason = '',
    idempotencyKey = '',
  } = {}) {
    const override = String(actualPlayStartedAtOverride || '').trim();
    const overrideReason = String(playStartOverrideReason || '').trim();
    if (override && !overrideReason) {
      throw new Error('Enter the verified play-start correction reason.');
    }
    const result = await _pbManageWeatherRefund('approve-player-claim', {
      claimId: String(claimId || '').trim(),
      ...(String(decisionNote || '').trim() ? { decisionNote: String(decisionNote).trim() } : {}),
      ...(override ? {
        actualPlayStartedAtOverride: override,
        playStartOverrideReason: overrideReason,
      } : {}),
      idempotencyKey: String(idempotencyKey || '') || _pbWeatherRefundIdempotencyKey(),
    });
    const claim = _pbNormalizePlayerRainClaim(result.claim);
    const incident = _pbNormalizeWeatherRefund(result.incident, { kind:'incident' });
    if (!claim || !incident) throw new Error('The approved rain report returned an invalid response.');
    _pbClearFastCache(['bookings']);
    return { claim, incident, idempotent: result.idempotent === true };
  },

  async rejectPlayerRainClaim(claimId, {
    decisionNote = '',
    idempotencyKey = '',
  } = {}) {
    const note = String(decisionNote || '').trim();
    if (!note) throw new Error('Enter a reason before rejecting this player report.');
    const result = await _pbManageWeatherRefund('reject-player-claim', {
      claimId: String(claimId || '').trim(),
      decisionNote: note,
      idempotencyKey: String(idempotencyKey || '') || _pbWeatherRefundIdempotencyKey(),
    });
    const claim = _pbNormalizePlayerRainClaim(result.claim);
    if (!claim) throw new Error('The rejected rain report returned an invalid response.');
    _pbClearFastCache(['bookings']);
    return { claim, idempotent: result.idempotent === true };
  },

  async listWeatherRefunds(filters = {}) {
    const input = filters && typeof filters === 'object' ? filters : {};
    const status = String(input.status || '').trim().toLowerCase();
    const payoutStatus = String(input.payoutStatus || '').trim().toLowerCase();
    const bookingDate = String(input.bookingDate || '').trim();
    const beforeReportedAt = String(input.beforeReportedAt || '').trim();
    const beforeIncidentId = String(input.beforeIncidentId || '').trim();
    const limit = Math.max(1, Math.min(250, Number(input.limit) || 250));
    if (status && !['reported', 'approved', 'rejected'].includes(status)) {
      throw new Error('Choose a valid rain refund status.');
    }
    if (payoutStatus && !['pending', 'sent', 'not_required'].includes(payoutStatus)) {
      throw new Error('Choose a valid rain refund payout status.');
    }
    if (bookingDate && !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
      throw new Error('Choose a valid booking date.');
    }
    if (beforeReportedAt && Number.isNaN(new Date(beforeReportedAt).getTime())) {
      throw new Error('The rain refund cursor timestamp is invalid.');
    }
    if (beforeIncidentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(beforeIncidentId)) {
      throw new Error('The rain refund cursor ID is invalid.');
    }
    if (Boolean(beforeReportedAt) !== Boolean(beforeIncidentId)) {
      throw new Error('Both rain refund cursor fields are required.');
    }
    const result = await _pbManageWeatherRefund('list', {
      filters: {
        ...(status ? { status } : {}),
        ...(payoutStatus ? { payoutStatus } : {}),
        ...(bookingDate ? { bookingDate } : {}),
        ...(beforeReportedAt ? { beforeReportedAt } : {}),
        ...(beforeIncidentId ? { beforeIncidentId } : {}),
        limit,
      },
    });
    if (!Array.isArray(result.incidents) || !result.page || typeof result.page !== 'object') {
      throw new Error('The rain refund list response is incomplete. Please refresh and try again.');
    }
    const rawPage = result.page;
    const totalCountValue = Number(rawPage.totalCount ?? rawPage.total_count);
    const countValue = Number(rawPage.count ?? result.incidents.length);
    if (!Number.isInteger(totalCountValue) || totalCountValue < 0 ||
        !Number.isInteger(countValue) || countValue < 0 ||
        countValue !== result.incidents.length || totalCountValue < countValue) {
      throw new Error('The rain refund list totals are invalid. Please refresh and try again.');
    }
    const rawNext = rawPage.nextCursor && typeof rawPage.nextCursor === 'object'
      ? rawPage.nextCursor
      : null;
    const nextCursor = rawNext
      ? {
          beforeReportedAt: String(rawNext.beforeReportedAt || rawNext.reportedAt || '').trim(),
          beforeIncidentId: String(rawNext.beforeIncidentId || rawNext.incidentId || '').trim(),
        }
      : null;
    if (rawPage.nextCursor && (!nextCursor?.beforeReportedAt || !nextCursor?.beforeIncidentId ||
        Number.isNaN(new Date(nextCursor.beforeReportedAt).getTime()) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nextCursor.beforeIncidentId))) {
      throw new Error('The rain refund list cursor is invalid. Please refresh and try again.');
    }
    const incidents = result.incidents
      .map(incident => _pbNormalizeWeatherRefund(incident, { kind:'incident' }))
      .filter(Boolean);
    if (incidents.length !== result.incidents.length || incidents.some(incident =>
      !incident.id || !incident.bookingReference ||
      !['reported', 'approved', 'rejected'].includes(incident.status) ||
      !['pending', 'sent', 'not_required'].includes(incident.payoutStatus))) {
      throw new Error('A rain refund record could not be verified. Please refresh and try again.');
    }
    return {
      incidents,
      page: {
        limit: Number(rawPage.limit || limit),
        count: countValue,
        totalCount: totalCountValue,
        nextCursor: nextCursor?.beforeReportedAt && nextCursor?.beforeIncidentId ? nextCursor : null,
      },
    };
  },

  async listAllWeatherRefunds(filters = {}) {
    const input = filters && typeof filters === 'object' ? { ...filters } : {};
    delete input.beforeReportedAt;
    delete input.beforeIncidentId;
    const incidents = [];
    const incidentKeys = new Set();
    const cursorKeys = new Set();
    let cursor = null;
    let totalCount = null;
    for (let pageIndex = 0; pageIndex < 1000; pageIndex += 1) {
      const pageResult = await this.listWeatherRefunds({
        ...input,
        limit:250,
        ...(cursor || {}),
      });
      if (Number.isFinite(Number(pageResult.page?.totalCount))) {
        totalCount = Number(pageResult.page.totalCount);
      }
      pageResult.incidents.forEach(incident => {
        const key = String(incident.id || `${incident.bookingReference}:${incident.reportedAt}`);
        if (!key || incidentKeys.has(key)) return;
        incidentKeys.add(key);
        incidents.push(incident);
      });
      cursor = pageResult.page?.nextCursor || null;
      if (!cursor) {
        if (totalCount !== null && totalCount > incidents.length) {
          throw new Error('The rain refund list ended before every record was loaded. Please refresh and try again.');
        }
        return {
          incidents,
          page: { totalCount:totalCount ?? incidents.length, count:incidents.length, nextCursor:null },
        };
      }
      const cursorKey = `${cursor.beforeReportedAt}|${cursor.beforeIncidentId}`;
      if (cursorKeys.has(cursorKey)) {
        throw new Error('The rain refund list returned a repeated cursor. Please refresh and try again.');
      }
      cursorKeys.add(cursorKey);
    }
    throw new Error('The rain refund list is too large to load safely in one report.');
  },

  async previewWeatherRefund({
    bookingReference,
    actualPlayStartedAt,
    rainStoppedPlayAt,
  } = {}) {
    const result = await _pbManageWeatherRefund('preview', {
      bookingReference: String(bookingReference || '').trim().toUpperCase(),
      actualPlayStartedAt: String(actualPlayStartedAt || ''),
      rainStoppedPlayAt: String(rainStoppedPlayAt || ''),
    });
    const preview = _pbNormalizeWeatherRefund(result.preview, { kind:'preview' });
    if (!preview) throw new Error('The rain refund preview returned an invalid response.');
    return preview;
  },

  async reportWeatherRefund({
    bookingReference,
    actualPlayStartedAt,
    rainStoppedPlayAt,
    reportNote = '',
    idempotencyKey = '',
  } = {}) {
    const result = await _pbManageWeatherRefund('report', {
      bookingReference: String(bookingReference || '').trim().toUpperCase(),
      actualPlayStartedAt: String(actualPlayStartedAt || ''),
      rainStoppedPlayAt: String(rainStoppedPlayAt || ''),
      ...(String(reportNote || '').trim() ? { reportNote: String(reportNote).trim() } : {}),
      idempotencyKey: String(idempotencyKey || '') || _pbWeatherRefundIdempotencyKey(),
    });
    const incident = _pbNormalizeWeatherRefund(result.incident, { kind:'incident' });
    if (!incident) throw new Error('The rain interruption report returned an invalid response.');
    _pbClearFastCache(['bookings']);
    return incident;
  },

  async approveWeatherRefund(incidentId, { decisionNote = '', idempotencyKey = '' } = {}) {
    const result = await _pbManageWeatherRefund('approve', {
      incidentId: String(incidentId || ''),
      ...(String(decisionNote || '').trim() ? { decisionNote: String(decisionNote).trim() } : {}),
      idempotencyKey: String(idempotencyKey || '') || _pbWeatherRefundIdempotencyKey(),
    });
    const incident = _pbNormalizeWeatherRefund(result.incident, { kind:'incident' });
    if (!incident) throw new Error('The approved rain refund returned an invalid response.');
    _pbClearFastCache(['bookings']);
    return incident;
  },

  async rejectWeatherRefund(incidentId, { decisionNote = '', idempotencyKey = '' } = {}) {
    const note = String(decisionNote || '').trim();
    if (!note) throw new Error('Enter a reason before rejecting this rain interruption report.');
    const result = await _pbManageWeatherRefund('reject', {
      incidentId: String(incidentId || ''),
      decisionNote: note,
      idempotencyKey: String(idempotencyKey || '') || _pbWeatherRefundIdempotencyKey(),
    });
    const incident = _pbNormalizeWeatherRefund(result.incident, { kind:'incident' });
    if (!incident) throw new Error('The rejected rain refund returned an invalid response.');
    _pbClearFastCache(['bookings']);
    return incident;
  },

  async markWeatherRefundPayoutSent(incidentId, {
    payoutReference,
    payoutMethod = '',
    payoutNote = '',
    idempotencyKey = '',
  } = {}) {
    const reference = String(payoutReference || '').trim();
    if (!reference) throw new Error('Enter the settlement reference before confirming.');
    const result = await _pbManageWeatherRefund('mark-payout-sent', {
      incidentId: String(incidentId || ''),
      payoutReference: reference,
      ...(String(payoutMethod || '').trim() ? { payoutMethod: String(payoutMethod).trim() } : {}),
      ...(String(payoutNote || '').trim() ? { payoutNote: String(payoutNote).trim() } : {}),
      idempotencyKey: String(idempotencyKey || '') || _pbWeatherRefundIdempotencyKey(),
    });
    const incident = _pbNormalizeWeatherRefund(result.incident, { kind:'incident' });
    if (!incident) throw new Error('The payout confirmation returned an invalid response.');
    _pbClearFastCache(['bookings']);
    return incident;
  },

  async previewBookingReschedule(ref, bookingDate) {
    if (!PB_PLATFORM_V1) {
      const error = new Error('Protected reschedule preview is unavailable in legacy mode.');
      error.code = 'PLATFORM_RESCHEDULE_REQUIRED';
      throw error;
    }
    const result = await _invokeEdgeFunction(
      `reschedule-booking?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'preview',
        tenantSlug: PB_TENANT_SLUG,
        bookingReference: String(ref || '').toUpperCase(),
        bookingDate: String(bookingDate || ''),
      },
      { preferDirect: true },
    );
    if (!result?.ok || !result.booking) {
      throw new Error(result?.message || result?.error || 'Available reschedule times could not be loaded.');
    }
    return {
      ...result,
      booking: await _pbPlatformBookingResponseToLegacy(result.booking),
      options: Array.isArray(result.options)
        ? result.options.map(_pbPlatformRescheduleOptionToLegacy)
        : [],
      policies: result.policies && typeof result.policies === 'object'
        ? result.policies
        : {},
    };
  },

  async rescheduleBooking(ref, change = {}) {
    if (!PB_PLATFORM_V1) {
      const error = new Error('Protected rescheduling is unavailable in legacy mode.');
      error.code = 'PLATFORM_RESCHEDULE_REQUIRED';
      throw error;
    }
    const result = await _invokeEdgeFunction(
      `reschedule-booking?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'reschedule',
        tenantSlug: PB_TENANT_SLUG,
        bookingReference: String(ref || '').toUpperCase(),
        newDate: String(change.newDate || ''),
        newStartTime: String(change.newStartTime || ''),
        reasonCode: String(change.reasonCode || ''),
        publicReason: String(change.publicReason || ''),
        internalNote: String(change.internalNote || ''),
        notifyCustomer: change.notifyCustomer === true,
        idempotencyKey: String(change.idempotencyKey || ''),
        deadlineAt: change.deadlineAt || null,
      },
      { preferDirect: true },
    );
    if (!result?.ok || !result.booking) {
      throw new Error(result?.message || result?.error || 'The booking could not be rescheduled.');
    }
    _pbClearFastCache(['bookings', 'platformAvailability']);
    if (result.paymentRequired === true) {
      const balance = result.balanceRequest;
      if (!/^[0-9a-f-]{36}$/i.test(balance?.id || '') ||
          !['awaiting_payment','payment_review','settled','expired','cancelled'].includes(balance?.status) ||
          !Number.isFinite(balance?.remainingAmount) || balance.remainingAmount <= 0 ||
          !Number.isFinite(new Date(balance.deadlineAt || '').getTime()) ||
          !Number.isFinite(result.price?.additionalAmount) || result.price.additionalAmount <= 0 ||
          !Number.isFinite(result.price?.newTotalAmount) || result.price.newTotalAmount <= 0) {
        throw new Error('The payment response could not be verified. Refresh this booking before trying again.');
      }
      return {...result, booking:await _pbPlatformBookingResponseToLegacy(result.booking), event:null, email:null};
    }
    if (!result.event) throw new Error('The schedule response could not be verified. Refresh this booking before trying again.');
    const email = _pbPlatformRescheduleEmailToLegacy(result.email);
    return {
      ...result,
      booking: await _pbPlatformBookingResponseToLegacy(result.booking),
      event: {
        ..._pbPlatformRescheduleEventToLegacy(result.event),
        emailStatus: email.status,
        emailSentAt: email.sentAt,
        emailDeliveryId: email.deliveryId,
        emailErrorCode: email.errorCode,
        emailAttemptCount: email.attemptCount,
      },
      email,
    };
  },

  async resendBookingRescheduleEmail(ref, eventId) {
    if (!PB_PLATFORM_V1) {
      const error = new Error('Protected reschedule email delivery is unavailable in legacy mode.');
      error.code = 'PLATFORM_RESCHEDULE_REQUIRED';
      throw error;
    }
    const result = await _invokeEdgeFunction(
      `reschedule-booking?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'resend',
        tenantSlug: PB_TENANT_SLUG,
        bookingReference: String(ref || '').toUpperCase(),
        eventId: String(eventId || ''),
      },
      { preferDirect: true },
    );
    if (!result?.ok || !result.event) {
      throw new Error(result?.message || result?.error || 'The reschedule email could not be resent.');
    }
    _pbClearFastCache(['bookings']);
    const email = _pbPlatformRescheduleEmailToLegacy(result.email);
    return {
      ...result,
      event: {
        ..._pbPlatformRescheduleEventToLegacy(result.event),
        emailStatus: email.status,
        emailSentAt: email.sentAt,
        emailDeliveryId: email.deliveryId,
        emailErrorCode: email.errorCode,
        emailAttemptCount: email.attemptCount,
      },
      email,
    };
  },

  async updateBooking(ref, updates) {
    if (PB_PLATFORM_V1) {
      const booking = await this.getBookingByRef(ref);
      if (!booking?.id) throw new Error('Booking not found or no longer accessible.');
      const nextStatus = String(updates?.status || '').toLowerCase();
      const nextPayment = String(updates?.paymentStatus || '').toLowerCase();
      const decision = ['confirmed', 'paid'].includes(nextStatus) || ['paid', 'downpayment_paid'].includes(nextPayment)
        ? 'approve'
        : ['rejected'].includes(nextStatus) || nextPayment === 'rejected'
          ? 'reject'
          : null;
      if (decision && booking.receiptVerificationId) {
        const reviewNote = String(updates?.reviewNote || updates?.forfeitureReason || '').trim();
        const data = await _invokeEdgeFunction(
          `review-payment-receipt?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
          {
            tenantSlug: PB_TENANT_SLUG,
            verificationId: booking.receiptVerificationId,
            decision,
            note: reviewNote || null,
          },
          { preferDirect: true }
        );
        if (!data?.ok) throw new Error(data?.message || data?.error || 'Receipt review failed.');
        _pbClearFastCache(['bookings', 'platformAvailability']);
        return data;
      }
      if (['cancelled', 'forfeited', 'expired'].includes(nextStatus)) {
        const { data, error } = await _sb.rpc('cancel_tenant_booking', {
          p_booking_id: booking.id,
          p_reason: String(updates?.forfeitureReason || updates?.reason || 'Cancelled by dashboard operator'),
        });
        if (error) throw error;
        _pbClearFastCache(['bookings', 'platformAvailability']);
        return data;
      }
      const error = new Error('This booking change is not supported by the protected platform workflow.');
      error.code = 'PLATFORM_BOOKING_CHANGE_NOT_SUPPORTED';
      throw error;
    }
    // Map only the fields provided (camelCase → snake_case)
    const row = {};
    if (updates.status    !== undefined) row.status = updates.status;
    if (updates.groupRef  !== undefined) row.booking_group_ref = updates.groupRef;
    if (updates.fullName  !== undefined) row.full_name = updates.fullName;
    if (updates.contactNumber !== undefined) row.contact_number = updates.contactNumber;
    if (updates.email     !== undefined) row.email = updates.email;
    if (updates.total     !== undefined) row.total = updates.total;
    if (updates.paymentMethod !== undefined) row.payment_method = updates.paymentMethod;
    if (updates.receivedAccount !== undefined) row.received_account = receivedAccountForBooking(updates);
    else if (updates.paymentMethod !== undefined) row.received_account = receivedAccountForBooking(updates);
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.paymentFlow !== undefined) row.payment_flow = updates.paymentFlow;
    if (updates.paymentProvider !== undefined) row.payment_provider = updates.paymentProvider;
    if (updates.paymentSessionId !== undefined) row.payment_session_id = updates.paymentSessionId;
    if (updates.paymentCheckoutUrl !== undefined) row.payment_checkout_url = updates.paymentCheckoutUrl;
    if (updates.paidAt !== undefined) row.paid_at = updates.paidAt;
    if (updates.gcashRef !== undefined) row.gcash_ref = updates.gcashRef;
    if (updates.downpayment !== undefined) row.downpayment = updates.downpayment;
    if (updates.bookingType !== undefined) row.booking_type = updates.bookingType;
    if (updates.eventType !== undefined) row.event_type = updates.eventType;
    if (updates.eventGuestCount !== undefined) row.event_guest_count = updates.eventGuestCount;
    if (updates.eventSetupNotes !== undefined) row.event_setup_notes = updates.eventSetupNotes;
    if (updates.balanceDueAt !== undefined) row.balance_due_at = updates.balanceDueAt;
    if (updates.forfeitedAt !== undefined) row.forfeited_at = updates.forfeitedAt;
    if (updates.forfeitureReason !== undefined) row.forfeiture_reason = updates.forfeitureReason;
    if (updates.hostBooking !== undefined) row.host_booking = !!updates.hostBooking;
    if (updates.hostUserId !== undefined) row.host_user_id = updates.hostUserId;
    if (updates.hostName !== undefined) row.host_name = updates.hostName;
    if (updates.hostEmail !== undefined) row.host_email = updates.hostEmail;
    if (updates.createdVia !== undefined) row.created_via = updates.createdVia;
    if (updates.createdByUserId !== undefined) row.created_by_user_id = updates.createdByUserId;
    if (updates.createdByRole !== undefined) row.created_by_role = updates.createdByRole;
    if (updates.createdByName !== undefined) row.created_by_name = updates.createdByName;
    if (updates.createdByEmail !== undefined) row.created_by_email = updates.createdByEmail;
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.startTime !== undefined) row.start_time = updates.startTime;
    if (updates.endTime !== undefined) row.end_time = updates.endTime;
    if (updates.duration !== undefined) row.duration = updates.duration;
    if (updates.slots !== undefined) row.slots = updates.slots;
    if (updates.billedAt !== undefined) row.billed_at = updates.billedAt;
    if (updates.weeklyFeeId !== undefined) row.weekly_fee_id = updates.weeklyFeeId;
    if (updates.confirmationEmailId !== undefined) row.confirmation_email_id = updates.confirmationEmailId;
    if (updates.confirmationEmailSentAt !== undefined) row.confirmation_email_sent_at = updates.confirmationEmailSentAt;
    if (updates.confirmationEmailLastEvent !== undefined) row.confirmation_email_last_event = updates.confirmationEmailLastEvent;
    let { data, error } = await _sb.from('bookings').update(row).eq('ref', ref).select('ref');
    if (error && isMissingOptionalBookingColumnError(error) && !updates.hostBooking && updates.createdVia !== 'host') {
      ({ data, error } = await _sb.from('bookings').update(withoutOptionalBookingColumns(row)).eq('ref', ref).select('ref'));
    }
    if (error) { console.error('updateBooking:', error); throw error; }
    if (!Array.isArray(data) || data.length === 0) {
      const denied = new Error(`Booking ${ref} was not updated. It may have expired or this account does not have permission to change it.`);
      denied.code = 'BOOKING_UPDATE_NOT_ALLOWED';
      console.error('updateBooking:', denied);
      throw denied;
    }
    _pbClearFastCache(['bookings']);
  },

  async restoreCancelledBooking(ref, reason) {
    const booking = await this.getBookingByRef(ref);
    if (!booking?.id) throw new Error('Booking not found or no longer accessible.');
    const restorationReason = String(reason || '').trim();
    if (restorationReason.length < 3 || restorationReason.length > 500) {
      throw new Error('Enter a restoration reason between 3 and 500 characters.');
    }
    if (PB_PLATFORM_V1) {
      const { data, error } = await _sb.rpc('reinstate_tenant_booking', {
        p_booking_id: booking.id,
        p_reason: restorationReason,
      });
      if (error) {
        const message = String(error.message || '');
        if (/no longer available|blocked|conflict|overlap/i.test(message)) {
          throw new Error('The original court time is no longer available. Resolve the conflict or reschedule the booking.');
        }
        throw error;
      }
      _pbClearFastCache(['bookings', 'platformAvailability']);
      return data || null;
    }
    await this.updateBooking(ref, {
      status: 'confirmed',
      paymentStatus: 'paid',
    });
    return {
      bookingReference: String(ref || ''),
      bookingStatus: 'confirmed',
      paymentStatus: 'paid',
    };
  },

  async issueBookingBalanceRequest({
    bookingReference,
    verificationId,
    acceptedAmount,
    deadlineAt,
    note = '',
  }) {
    if (!PB_PLATFORM_V1) {
      throw new Error('Protected remaining-balance requests require the tenant platform.');
    }
    const result = await _invokeEdgeFunction(
      `review-payment-receipt?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        tenantSlug: PB_TENANT_SLUG,
        bookingReference: String(bookingReference || '').toUpperCase(),
        verificationId: String(verificationId || ''),
        decision: 'short_payment',
        acceptedAmount: Number(acceptedAmount),
        deadlineAt: String(deadlineAt || ''),
        note: String(note || '').trim() || null,
      },
      { preferDirect: true }
    );
    if (!result?.ok || !result?.review?.balanceRequestId) {
      throw new Error(result?.message || result?.error || 'The remaining-balance request could not be created.');
    }
    _pbClearFastCache(['bookings', 'platformAvailability']);
    return result;
  },

  async resendBookingBalanceNotice(balanceRequestId) {
    if (!PB_PLATFORM_V1) {
      throw new Error('Protected remaining-balance notices require the tenant platform.');
    }
    const result = await _invokeEdgeFunction(
      `send-balance-payment-email?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        tenantSlug: PB_TENANT_SLUG,
        balanceRequestId: String(balanceRequestId || ''),
        resend: true,
      },
      { preferDirect: true }
    );
    if (!result?.ok) {
      throw new Error(result?.message || result?.error || 'The remaining-balance email could not be resent.');
    }
    return result;
  },

  // Stamp a set of bookings as billed on a given weekly statement (idempotent
  // audit trail; a booking is only ever billed once).
  async markBookingsBilled(refs, weeklyFeeId) {
    if (!Array.isArray(refs) || refs.length === 0) return;
    const { error } = await _sb.from('bookings')
      .update({ billed_at: new Date().toISOString(), weekly_fee_id: weeklyFeeId })
      .in('ref', refs);
    if (error) { console.error('markBookingsBilled:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async deleteBooking(ref) {
    if (PB_PLATFORM_V1) {
      return this.updateBooking(ref, {
        status: 'cancelled',
        reason: 'Cancelled from dashboard',
      });
    }
    const { error } = await _sb.from('bookings').delete().eq('ref', ref);
    if (error) { console.error('deleteBooking:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async voidDeleteBookingGroup(ref, reason) {
    if (PB_PLATFORM_V1) {
      const result = await this.updateBooking(ref, { status: 'cancelled', reason });
      return { cancelled: true, voided_fee_amount: 0, result };
    }
    const { data, error } = await _sb.rpc('void_delete_booking_group', {
      p_booking_ref: ref,
      p_reason: reason,
    });
    if (error) { console.error('voidDeleteBookingGroup:', error); throw error; }
    _pbClearFastCache(['bookings']);
    return data || null;
  },

  async archiveBooking(ref) {
    if (!PB_PLATFORM_V1) return this.deleteBooking(ref);
    const result = await _invokeEdgeFunction(
      `manage-booking-archive?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      { action: 'archive', tenantSlug: PB_TENANT_SLUG, bookingReference: String(ref || '') },
      { preferDirect: true }
    );
    if (!result?.ok) throw new Error(result?.message || result?.error || 'Could not archive the booking.');
    _pbClearFastCache(['bookings', 'platformAvailability']);
    return result.booking || null;
  },

  async getArchivedBookings() {
    if (!PB_PLATFORM_V1) {
      const rows = await this.getDeletedBookingArchive({ limit: 250 });
      return rows
        .filter(row => row.recoveryStatus !== 'restored')
        .map(row => ({ ...(row.originalBooking || row.originalBookingRow || {}), archivedAt: row.archivedAt || row.deletedAt, archiveId: row.id }));
    }
    const session = await _pbAuthenticatedSession();
    if (!session || window.Auth?.getSession?.()?.role !== 'owner') {
      throw new Error('Only the System Owner can view archived bookings.');
    }
    const [result, courts, bootstrap] = await Promise.all([
      _invokeEdgeFunction(
        `tenant-manager-data?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
        {
          action: 'list-archived-bookings',
          tenantSlug: PB_TENANT_SLUG,
          filters: { limit: 250 },
        },
        { preferDirect: true }
      ),
      this.getCourts(),
      _pbPlatformBootstrap(),
    ]);
    if (!result?.ok || !Array.isArray(result.bookings)) {
      throw new Error('The tenant booking archive could not be loaded.');
    }
    const courtMap = new Map(courts.map(court => [String(court.id), court]));
    return result.bookings.map(row => _pbPlatformBookingToLegacy(
      row,
      courtMap,
      bootstrap?.tenant?.timezone || 'Asia/Manila'
    ));
  },

  async restoreArchivedBooking(ref) {
    if (!PB_PLATFORM_V1) {
      const rows = await this.getDeletedBookingArchive({ bookingRef: ref, limit: 10 });
      const entry = rows.find(row => row.recoveryStatus !== 'restored');
      if (!entry) throw new Error('Archived booking not found.');
      return this.restoreDeletedBookingArchive(entry.id);
    }
    const result = await _invokeEdgeFunction(
      `manage-booking-archive?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      { action: 'restore', tenantSlug: PB_TENANT_SLUG, bookingReference: String(ref || '') },
      { preferDirect: true }
    );
    if (!result?.ok) throw new Error(result?.message || result?.error || 'Could not restore the booking.');
    _pbClearFastCache(['bookings', 'platformAvailability']);
    return result.booking || null;
  },

  async permanentlyDeleteArchivedBooking(ref) {
    if (!PB_PLATFORM_V1) throw new Error('Permanent deletion is available only on the protected platform archive.');
    const result = await _invokeEdgeFunction(
      `manage-booking-archive?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      { action: 'delete', tenantSlug: PB_TENANT_SLUG, bookingReference: String(ref || '') },
      { preferDirect: true }
    );
    if (!result?.ok) throw new Error(result?.message || result?.error || 'Could not permanently delete the booking.');
    _pbClearFastCache(['bookings', 'platformAvailability']);
    return result;
  },

  async getDeletedBookingArchive(filters = {}) {
    const opts = filters || {};
    let query = _sb
      .from('deleted_booking_archive')
      .select('*')
      .order('deleted_at', { ascending: false })
      .limit(Number(opts.limit || 250));
    if (opts.status) query = query.eq('recovery_status', opts.status);
    if (opts.bookingRef) query = query.eq('booking_ref', opts.bookingRef);
    const { data, error } = await query;
    if (error) { console.error('getDeletedBookingArchive:', error); throw error; }
    return (data || []).map(rowToDeletedBookingArchive);
  },

  async restoreDeletedBookingArchive(id) {
    const { data, error } = await _sb.rpc('restore_deleted_booking_archive', { p_archive_id: id });
    if (error) { console.error('restoreDeletedBookingArchive:', error); throw error; }
    _pbClearFastCache(['bookings']);
    return data ? rowToBooking(data) : null;
  },

  // ---- BLOCKED DATES ----
  async getBlockedDateAccess() {
    if (!PB_PLATFORM_V1) {
      return {
        canManage: window.Auth?.getSession?.()?.role === 'owner',
        status: 'unavailable',
        durationDays: null,
        grantedAt: null,
        expiresAt: null,
        revokedAt: null,
        serverNow: new Date().toISOString(),
      };
    }
    if (!await _pbAuthenticatedSession()) {
      throw new Error('Your session is no longer available. Please sign in again.');
    }
    const { data, error } = await _sb.rpc('get_blocked_date_access', {
      p_tenant_slug: PB_TENANT_SLUG,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not verify blocked-date access'));
    return {
      canManage: data?.canManage === true,
      status: String(data?.status || 'none'),
      durationDays: data?.durationDays == null ? null : Number(data.durationDays),
      grantedAt: data?.grantedAt || null,
      expiresAt: data?.expiresAt || null,
      revokedAt: data?.revokedAt || null,
      serverNow: data?.serverNow || null,
    };
  },

  async setBlockedDateAccess({ action, durationDays = null } = {}) {
    if (!PB_PLATFORM_V1) throw new Error('Temporary blocked-date access requires the protected platform backend.');
    if (!await _pbAuthenticatedSession()) {
      throw new Error('Your session is no longer available. Please sign in again.');
    }
    const normalizedAction = String(action || '').toLowerCase();
    const normalizedDuration = durationDays == null ? null : Number(durationDays);
    if (!['grant', 'revoke'].includes(normalizedAction)) throw new Error('Choose a valid access action.');
    if (normalizedAction === 'grant' && ![1, 2, 3].includes(normalizedDuration)) {
      throw new Error('Choose an access duration of 1, 2, or 3 days.');
    }
    const { data, error } = await _sb.rpc('set_blocked_date_access', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_action: normalizedAction,
      p_duration_days: normalizedAction === 'grant' ? normalizedDuration : null,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not update blocked-date access'));
    return {
      canManage: data?.canManage === true,
      status: String(data?.status || 'none'),
      durationDays: data?.durationDays == null ? null : Number(data.durationDays),
      grantedAt: data?.grantedAt || null,
      expiresAt: data?.expiresAt || null,
      revokedAt: data?.revokedAt || null,
      serverNow: data?.serverNow || null,
    };
  },

  async getBlockedDateRecords() {
    if (PB_PLATFORM_V1 && PB_PAGE_DATA_SCOPE !== 'manager') return [];
    if (PB_PLATFORM_V1) {
      return _pbCached('blockedDateRecords', {}, PB_FAST_CACHE_MS.blockedDates, async () => {
        const session = await _pbAuthenticatedSession();
        if (!session) return [];
        const result = await _invokeEdgeFunction(
          `tenant-manager-data?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
          {
            action: 'list-blocked-dates',
            tenantSlug: PB_TENANT_SLUG,
            filters: { limit: 500 },
          },
          { preferDirect: true }
        );
        if (!result?.ok || !Array.isArray(result.blockedDates)) {
          throw new Error('The reserved-date list could not be loaded.');
        }
        return result.blockedDates.map(row => ({
          id: row.id,
          courtId: row.court_id,
          blockedOn: row.blocked_on,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          publicLabel: row.public_label || 'Closed',
          internalReason: row.internal_reason || '',
          createdAt: row.created_at,
        }));
      });
    }
    const dates = await this.getBlockedDates();
    return dates.map(date => ({
      id: date,
      blockedOn: date,
      startsAt: null,
      endsAt: null,
      publicLabel: 'Closed',
      internalReason: '',
    }));
  },

  async getBlockedDates() {
    if (PB_PLATFORM_V1) {
      return _pbCached('blockedDates', {}, PB_FAST_CACHE_MS.blockedDates, async () => {
        const records = await this.getBlockedDateRecords();
        return [...new Set(records
          .filter(row => !row.startsAt && !row.endsAt)
          .map(row => row.blockedOn))];
      });
    }
    return _pbCached('blockedDates', {}, PB_FAST_CACHE_MS.blockedDates, async () => {
      const { data, error } = await _sb.from('blocked_dates').select('date').order('date');
      if (error) { console.error('getBlockedDates:', error); return []; }
      return data.map(r => r.date);
    });
  },

  async addBlockedDate(input) {
    if (PB_PLATFORM_V1) {
      const session = await _pbAuthenticatedSession();
      if (!session) throw new Error('Your staff session has expired. Please sign in again.');
      const value = typeof input === 'string' ? { startDate: input } : (input || {});
      const { data, error } = await _sb.rpc('manage_blocked_dates', {
        p_tenant_slug: PB_TENANT_SLUG,
        p_action: 'create',
        p_block_id: null,
        p_start_date: value.startDate || value.date || null,
        p_end_date: value.endDate || value.startDate || value.date || null,
        p_court_id: value.courtId || null,
        p_starts_at: value.startsAt || null,
        p_ends_at: value.endsAt || null,
        p_public_label: value.publicLabel || 'Reserved',
        p_internal_reason: value.internalReason || null,
      });
      if (error) throw new Error(error.message || 'The dates could not be reserved.');
      _pbClearFastCache(['blockedDates', 'blockedDateRecords', 'bookings', 'platformAvailability']);
      return data;
    }
    const date = typeof input === 'string' ? input : (input?.startDate || input?.date);
    const { error } = await _sb.from('blocked_dates').insert({ date, created_at: new Date().toISOString() });
    if (error) console.error('addBlockedDate:', error);
    _pbClearFastCache(['blockedDates']);
  },

  async removeBlockedDate(identifier) {
    if (PB_PLATFORM_V1) {
      const session = await _pbAuthenticatedSession();
      if (!session) throw new Error('Your staff session has expired. Please sign in again.');
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(identifier || ''))) {
        const { data, error } = await _sb.rpc('manage_blocked_dates', {
          p_tenant_slug: PB_TENANT_SLUG,
          p_action: 'delete',
          p_block_id: identifier,
        });
        if (error) throw new Error(error.message || 'The reserved date could not be removed.');
        _pbClearFastCache(['blockedDates', 'blockedDateRecords', 'bookings', 'platformAvailability']);
        return data;
      }
      const records = (await this.getBlockedDateRecords()).filter(record =>
        record.blockedOn === String(identifier || '') && !record.startsAt && !record.endsAt
      );
      if (!records.length) throw new Error('The reserved date was not found. Refresh and try again.');
      for (const record of records) {
        const { error } = await _sb.rpc('manage_blocked_dates', {
          p_tenant_slug: PB_TENANT_SLUG,
          p_action: 'delete',
          p_block_id: record.id,
        });
        if (error) throw new Error(error.message || 'The reserved date could not be removed.');
      }
      _pbClearFastCache(['blockedDates', 'blockedDateRecords', 'bookings', 'platformAvailability']);
      return;
    }
    const date = identifier;
    const { error } = await _sb.from('blocked_dates').delete().eq('date', date);
    if (error) console.error('removeBlockedDate:', error);
    _pbClearFastCache(['blockedDates']);
  },

  // ---- ACCOUNTS ----
  async getAccounts() {
    if (PB_PLATFORM_V1) {
      const result = await _invokeEdgeFunction(`manage-account?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`, {
        action: 'list',
        tenantSlug: PB_TENANT_SLUG,
      }, { preferDirect: true });
      if (!result?.ok || !Array.isArray(result.accounts)) {
        throw new Error('The account service returned an invalid response.');
      }
      return result.accounts;
    }
    const { data, error } = await _sb.from('accounts').select('*').order('created_at');
    if (error) { console.error('getAccounts:', error); return []; }
    return data.map(rowToAccount);
  },

  async getHostFinanceAccounts() {
    const { data, error } = await _sb.rpc('get_host_finance_accounts');
    if (error) {
      console.error('getHostFinanceAccounts:', error);
      throw error;
    }
    return (data || []).map(rowToHostFinanceAccount).filter(account => account.id);
  },

  async getHostFinanceBookings(hostUserId) {
    const id = String(hostUserId || '').trim();
    if (!id) throw new Error('A host account is required to load finance bookings.');
    const { data, error } = await _sb.rpc('get_host_finance_bookings', { p_host_user_id: id });
    if (error) {
      console.error('getHostFinanceBookings:', error);
      throw error;
    }
    return (data || []).map(rowToBooking);
  },

  async saveAccount(account) {
    const { error } = await _sb.from('accounts').upsert(accountToRow(account));
    if (error) { console.error('saveAccount:', error); throw error; }
  },

  async deleteAccount(id) {
    const { error } = await _sb.from('accounts').delete().eq('id', id);
    if (error) console.error('deleteAccount:', error);
  },

  // ---- SETTINGS ----
  async getSettings() {
    if (PB_PLATFORM_V1) {
      return _pbCached('settings', {}, PB_FAST_CACHE_MS.settings, async () => {
        const bootstrap = await _pbPlatformBootstrap();
        const session = await _pbAuthenticatedSession();
        const dashboardSession = window.Auth?.getSession?.() || {};
        const membershipRole = String(dashboardSession.membershipRole || '').toLowerCase();
        const canManageTenant = dashboardSession.role === 'owner' || ['owner', 'admin'].includes(membershipRole);
        if (PB_PAGE_DATA_SCOPE !== 'manager' || !session || !canManageTenant) return _pbPlatformSettingsToLegacy(bootstrap);

        const { data, error } = await _sb.rpc('get_tenant_settings_for_manager', {
          p_tenant_slug: PB_TENANT_SLUG,
          p_hostname: _pbTenantHostname(),
        });
        if (error) throw error;
        const allSettings = { ...(bootstrap.settings || {}) };
        for (const row of (data || [])) allSettings[row.setting_key] = row.setting_value;
        return _pbPlatformSettingsToLegacy({ ...bootstrap, settings: allSettings });
      });
    }
    return _pbCached('settings', {}, PB_FAST_CACHE_MS.settings, async () => {
      const { data, error } = await _sb.from('settings').select('*');
      if (error) { console.error('getSettings:', error); return {}; }
      const out = {};
      data.forEach(r => out[r.key] = r.value);
      return out;
    });
  },

  async saveSetting(key, value) {
    if (PB_PLATFORM_V1) {
      throw new Error('Generic platform settings writes are disabled. Use the protected per-feature controls.');
    }
    const { error } = await _sb.from('settings').upsert({ key, value });
    if (error) { console.error('saveSetting:', error); throw error; }
    _pbClearFastCache(['settings']);
  },

  async getRefundReschedulePolicyState() {
    const {data,error}=await _sb.rpc('get_tenant_refund_reschedule_policy', {
      p_tenant_slug:PB_TENANT_SLUG, p_hostname:_pbTenantHostname(),
    });
    if(error) throw error;
    _pbPolicyRevision=data?.revision || null;
    return data;
  },

  async saveRefundReschedulePolicy(policy) {
    if (!PB_PLATFORM_V1) {
      throw new Error('Policy publication requires the protected platform backend.');
    }
    if (!PB_REFUND_RESCHEDULE_POLICY_ENABLED) {
      throw new Error('Refund and reschedule policy publication is disabled for this tenant.');
    }
    if (!await _pbAuthenticatedSession()) {
      throw new Error('Your session is no longer available. Please sign in again.');
    }

    if (policy?.ownerApproved !== true) throw new Error('Review and approve the policy before publishing.');
    const { data, error } = await _sb.rpc('update_tenant_refund_reschedule_policy', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_expected_revision: _pbPolicyRevision,
      p_policy: {title:policy.title, intro:policy.intro, content:policy.content},
      p_publish: true,
    });
    if (error) throw new Error(_extractFnError(error, 'The policy could not be published'));
    _pbPolicyRevision = data?.revision || null;
    _pbClearFastCache(['settings', 'platformBootstrap']);
    return data;
  },

  // ---- TENANT ACTIVATION SETTINGS ----
  // These are authoritative production settings. They intentionally live in
  // tenant-scoped database tables instead of build-time JavaScript constants.
  async getTenantBusinessSettings() {
    if (!PB_PLATFORM_V1) throw new Error('Tenant business settings require the protected platform backend.');
    const { data, error } = await _sb.rpc('get_tenant_activation_settings', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load business settings'));
    _pbCaptureBusinessRevision(data);
    const business = data?.business && typeof data.business === 'object'
      ? data.business
      : data?.tenant && typeof data.tenant === 'object'
        ? data.tenant
        : {};
    return {
      ...business,
      branding: business.branding && typeof business.branding === 'object'
        ? business.branding
        : data?.tenant?.branding || {},
      updatedAt: data?.updatedAt || null,
    };
  },

  async saveTenantBusinessSettings(patch = {}) {
    if (!PB_PLATFORM_V1) throw new Error('Tenant business settings require the protected platform backend.');
    if (!_pbBusinessRevision) throw new Error('Reload the settings before saving.');
    const { data, error } = await _sb.rpc('update_tenant_business_settings_if_current', {
      p_expected_revision: _pbBusinessRevision,
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_patch: patch,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not save business settings'));
    _pbClearFastCache(['platformBootstrap', 'settings']);
    _pbCaptureBusinessRevision(data);
    return data?.business || data?.tenant || data || {};
  },

  async getTenantActivationSettings() {
    if (!PB_PLATFORM_V1) {
      const settings = await this.getSettings();
      return {
        tenant: {
          replyToEmail: settings.email_reply_to || '',
          emailEnabled: settings.email_enabled === '1',
          publicBookingRequested: settings.public_booking_requested === '1',
        },
        billing: {
          feeMode: String(settings.fee_type || '').toLowerCase() === 'flat'
            ? 'fixed_per_booking'
            : 'fixed_per_hour',
          feeAmount: Number(settings.maintenance_fee || 0),
        },
        openPlayServiceFee: {
          feeMode: 'fixed_per_player',
          feeAmount: Number(settings.open_play_service_fee_per_person || settings.open_play_service_fee || 0),
          isConfigured: Object.prototype.hasOwnProperty.call(settings, 'open_play_service_fee_per_person') ||
            Object.prototype.hasOwnProperty.call(settings, 'open_play_service_fee'),
        },
        paymentMethods: [],
        readiness: { publicBookingEnabled: false },
      };
    }

    const result = await _invokeEdgeFunction(
      `tenant-activation-settings?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      { action: 'get', tenantSlug: PB_TENANT_SLUG },
      { preferDirect: true }
    );
    if (!result?.ok || !result.settings) {
      throw new Error('Activation settings returned an invalid response.');
    }
    _pbCaptureBusinessRevision(result.settings);
    return _pbNormalizeTenantActivationSettings(result.settings);
  },

  async uploadTenantPaymentQr({ methodCode, file }) {
    if (!PB_PLATFORM_V1) throw new Error('Payment QR uploads require the platform backend.');
    const code = String(methodCode || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(code)) throw new Error('The payment method is invalid.');
    if (!file) throw new Error('Choose a QR image to upload.');
    const form = new FormData();
    form.append('qrFile', file, file.name || `${code}-qr.jpg`);
    const response = await _pbFetchWithTimeout(
      `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/tenant-payment-asset?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        method: 'POST',
        headers: await _authRestHeaders({
          'X-Payment-Method': code,
          'X-Asset-Action': 'upload',
        }),
        body: form,
      },
      PB_RECEIPT_TIMEOUT_MS
    );
    const text = await response.text();
    const result = _safeJsonParse(text) || {};
    if (!response.ok) {
      const failure = new Error(_pbApiErrorMessage(result, text, `Upload failed (HTTP ${response.status}).`));
      failure.code = result?.error?.code || null;
      throw failure;
    }
    if (!result?.ok || !result?.asset?.url) throw new Error('The QR upload returned an invalid response.');
    _pbCaptureBusinessRevision(result);
    return result.asset;
  },

  async saveTenantPlatformBilling({ feeMode, feeAmount }) {
    const mode = String(feeMode || '');
    const amount = Number(feeAmount);
    if (!['fixed_per_booking', 'fixed_per_hour'].includes(mode)) {
      throw new Error('Choose a valid booking-fee charging method.');
    }
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) {
      throw new Error('Enter a valid non-negative booking fee.');
    }
    if (!PB_PLATFORM_V1) {
      await this.saveSetting('maintenance_fee', String(amount));
      await this.saveSetting('fee_type', mode === 'fixed_per_booking' ? 'flat' : 'per_hour');
      return;
    }
    const result = await _invokeEdgeFunction(
      `tenant-activation-settings?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'update',
        tenantSlug: PB_TENANT_SLUG,
        patch: { platformBilling: { feeMode: mode, feeAmount: amount } },
      },
      { preferDirect: true }
    );
    if (!result?.ok || !result.settings) throw new Error('The booking fee was not saved.');
    const saved = _pbNormalizeTenantActivationSettings(result.settings);
    if (saved.billing?.feeMode !== mode || saved.billing?.feeAmount !== amount || !saved.billing?.isConfigured) {
      throw new Error('The server did not confirm the requested booking fee. Reload the settings and try again.');
    }
    _pbCaptureBusinessRevision(result.settings);
    _pbClearFastCache(['settings', 'platformBootstrap']);
    return saved;
  },

  async saveTenantOpenPlayServiceFee({ feeAmount }) {
    const amount = Number(feeAmount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
      throw new Error('Enter a valid non-negative Open Play service fee.');
    }
    if (!PB_PLATFORM_V1) {
      await this.saveSetting('open_play_service_fee_per_person', String(amount));
      return {
        openPlayServiceFee: {
          feeMode: 'fixed_per_player',
          feeAmount: amount,
          isConfigured: true,
        },
      };
    }
    const feePatch = {
      feeMode: 'fixed_per_player',
      feeAmount: amount,
    };
    const patchCandidates = [
      { openPlayServiceFee: feePatch },
      { openPlayBilling: feePatch },
      { openPlay: feePatch },
    ];
    let unsupportedPatchError = null;
    for (const patch of patchCandidates) {
      try {
        const result = await _invokeEdgeFunction(
          `tenant-activation-settings?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
          {
            action: 'update',
            tenantSlug: PB_TENANT_SLUG,
            patch,
          },
          { preferDirect: true }
        );
        if (!result?.ok || !result.settings) throw new Error('The Open Play service fee was not saved.');
        const saved = _pbNormalizeTenantActivationSettings(result.settings);
        if (saved.openPlayServiceFee?.feeAmount !== amount || !saved.openPlayServiceFee?.isConfigured) {
          throw new Error('The server did not confirm the requested Open Play service fee. Reload the settings and try again.');
        }
        _pbCaptureBusinessRevision(result.settings);
        _pbClearFastCache(['settings', 'platformBootstrap']);
        return saved;
      } catch (error) {
        if (_pbIsUnsupportedSettingsPatchError(error)) {
          unsupportedPatchError = error;
          continue;
        }
        throw error;
      }
    }
    const failure = new Error('The protected backend does not support saving the Open Play service fee yet. Deploy the tenant-activation-settings backend update for the Open Play fee settings patch, then try again.');
    failure.code = 'OPEN_PLAY_SERVICE_FEE_PATCH_UNSUPPORTED';
    failure.originalError = unsupportedPatchError;
    throw failure;
  },

  async saveTenantActivationSettings({
    emailEnabled,
    replyToEmail,
    paymentMethods,
  }) {
    const email = String(replyToEmail || '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Enter a valid Reply-To email address.');
    }
    const methods = Array.isArray(paymentMethods) ? paymentMethods : [];
    const normalized = methods.map((method, index) => {
      const code = String(method.code || '').trim().toLowerCase();
      const displayName = String(method.displayName || '').trim();
      const accountName = String(method.accountName || '').trim();
      const accountReference = String(method.accountReference || '').trim();
      const instructions = String(method.instructions || '').trim();
      const qrImageUrl = String(method.qrImageUrl || '').trim();
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(code)) throw new Error('A payment-method code is invalid.');
      if (displayName.length < 2 || displayName.length > 80) throw new Error(`Enter a valid name for ${code}.`);
      if (accountName && (accountName.length < 2 || accountName.length > 120)) throw new Error(`${displayName} account name is invalid.`);
      if (accountReference && (accountReference.length < 3 || accountReference.length > 120)) throw new Error(`${displayName} account number is invalid.`);
      if (instructions.length > 1000) throw new Error(`${displayName} instructions are too long.`);
      if (qrImageUrl) {
        let parsed;
        try { parsed = new URL(qrImageUrl); } catch (_) { parsed = null; }
        if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname || qrImageUrl.length > 500) {
          throw new Error(`${displayName} QR must be a public HTTPS URL.`);
        }
      }
      const configured = !!(accountName || accountReference || instructions || qrImageUrl);
      if (configured && (!accountName || !accountReference)) {
        throw new Error(`${displayName} needs both the receiving account name and account number.`);
      }
      if (method.isActive && !configured) {
        throw new Error(`${displayName} needs receiving account details before it can be enabled.`);
      }
      return {
        methodCode: code,
        displayName,
        accountName,
        accountNumber: accountReference,
        qrUrl: qrImageUrl || null,
        instructions: instructions || null,
        isActive: method.isActive === true,
        sortOrder: Number.isInteger(method.sortOrder) ? method.sortOrder : index,
        configured,
      };
    }).filter(method => method.configured).map(({ configured, ...method }) => method);

    if (!PB_PLATFORM_V1) {
      await this.saveSetting('email_reply_to', email);
      await this.saveSetting('email_enabled', emailEnabled ? '1' : '0');
      return;
    }
    const { data, error } = await _sb.rpc('update_tenant_business_settings_if_current', {
      p_expected_revision: _pbBusinessRevision,
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_patch: {
        venue: {
          replyToEmail: email || null,
          emailEnabled: emailEnabled === true,
        },
        paymentMethods: normalized,
      },
    });
    if (error) throw new Error(_extractFnError(error, 'Activation settings were not saved'));
    _pbClearFastCache(['settings', 'platformBootstrap']);
    // Refresh the safe server view so the public gate changes only when the
    // backend has independently confirmed every required setting.
    await _pbPlatformBootstrap();
    _pbCaptureBusinessRevision(data);
    return _pbNormalizeTenantActivationSettings(data);
  },

  async activateTenantInitially() {
    if (!String(PB_RUNTIME_CONFIG.turnstileSiteKey || '').trim()) throw new Error('The website booking security check must be configured before activation.');
    if (!PB_PLATFORM_V1) throw new Error('Initial tenant activation requires the protected platform backend.');
    const { data, error } = await _sb.rpc('activate_tenant_initially', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
    });
    if (error) throw new Error(_extractFnError(error, 'The tenant could not be activated'));
    _pbClearFastCache(['settings', 'platformBootstrap', 'platformAvailability']);
    await _pbPlatformBootstrap();
    _pbCaptureBusinessRevision(data);
    return _pbNormalizeTenantActivationSettings(data);
  },

  clearCache(scopes = []) {
    _pbClearFastCache(scopes);
  },

  async createPublicBooking(booking, { turnstileToken } = {}) {
    if (!PB_PLATFORM_V1) throw new Error('The tenant booking service is not enabled.');
    const bootstrap = await _pbPlatformBootstrap();
    if (bootstrap?.readiness?.publicBookingEnabled !== true) {
      throw new Error('Online booking is not ready yet. Complete the required settings in the dashboard.');
    }
    let publishedPolicy = null;
    if (PB_REFUND_RESCHEDULE_POLICY_ENABLED) {
      try {
        publishedPolicy = _pbApprovedRefundPolicyForWrite(
          bootstrap?.settings?.[PB_REFUND_RESCHEDULE_POLICY_KEY]
        );
      } catch (_) {
        throw new Error('Online booking is waiting for an owner-approved Refund & Reschedule Policy.');
      }
      const policyVersion = String(booking?.policyVersion || '').trim();
      if (booking?.policyAccepted !== true || policyVersion !== publishedPolicy.version) {
        throw new Error('The Refund & Reschedule Policy changed or was not accepted. Review the current policy and try again.');
      }
    }
    const slots = [...new Set((booking?.slots || []).map(Number))]
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    if (!slots.length || slots.some((hour, index) => index > 0 && hour !== slots[index - 1] + 1)) {
      throw new Error('Booking hours must be consecutive.');
    }
    const token = String(turnstileToken || '').trim();
    if (!token) throw new Error('Please complete the security check before confirming.');
    const clientRequestId = String(booking?.clientRequestId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clientRequestId)) {
      throw new Error('A secure booking request ID could not be created. Please refresh and try again.');
    }
    const notes = [booking.eventType, booking.eventSetupNotes]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join(' - ') || null;
    const payload = {
      tenantSlug: PB_TENANT_SLUG,
      courtId: String(booking.courtId),
      bookingDate: String(booking.date),
      startTime: `${String(slots[0]).padStart(2, '0')}:00`,
      durationHours: slots.length,
      bookingType: booking.bookingType === 'event' ? 'event' : 'regular',
      customer: {
        name: String(booking.fullName || '').trim(),
        email: String(booking.email || '').trim(),
        phone: String(booking.contactNumber || '').trim(),
      },
      guestCount: booking.bookingType === 'event'
        ? Number(booking.eventGuestCount || 1)
        : 1,
      notes,
      clientRequestId,
      turnstileToken: token,
    };
    if (PB_REFUND_RESCHEDULE_POLICY_ENABLED) {
      payload.policyAccepted = true;
      payload.policyVersion = publishedPolicy.version;
    }
    const result = await _invokeEdgeFunction(
      `create-booking?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      payload,
      { preferDirect: true }
    );
    if (!result?.ok || !result?.booking?.reference) {
      throw new Error(_pbApiErrorMessage(result, '', 'The booking service returned an invalid response.'));
    }
    _pbClearFastCache(['bookings', 'platformAvailability']);
    return result.booking;
  },

  async submitPublicPaymentReceipt({
    bookingReference,
    bookingToken,
    balanceRequestId = '',
    paymentMethod,
    paymentReference = '',
    receiptFile,
  }) {
    if (!PB_PLATFORM_V1) throw new Error('The tenant receipt service is not enabled.');
    if (!receiptFile) throw new Error('Receipt screenshot is required.');
    const imageFile = await _pbPrepareReceiptImage(receiptFile);
    const imageType = String(imageFile?.type || '').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(imageType)) {
      throw new Error('Use a JPEG, PNG, or WebP receipt image.');
    }
    const backendPaymentMethod = window.PB_PAYMENT_METHOD_CODES?.[paymentMethod] || paymentMethod;
    const form = new FormData();
    form.append('receiptFile', imageFile, imageFile.name || 'receipt.jpg');
    const response = await _pbFetchWithTimeout(
      `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/submit-payment-receipt?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'X-Booking-Reference': String(bookingReference || ''),
          'X-Booking-Token': String(bookingToken || ''),
          ...(balanceRequestId ? { 'X-Balance-Request': String(balanceRequestId) } : {}),
          'X-Payment-Method': String(backendPaymentMethod || ''),
          ...(paymentReference ? { 'X-Payment-Reference': String(paymentReference) } : {}),
        },
        body: form,
      },
      PB_RECEIPT_TIMEOUT_MS
    );
    const text = await response.text();
    const result = _safeJsonParse(text) || {};
    if (!response.ok || result.ok !== true) {
      const failure = new Error(_pbApiErrorMessage(result, text, `Receipt upload failed (HTTP ${response.status}).`));
      failure.code = result?.error?.code || null;
      failure.httpStatus = response.status;
      throw failure;
    }
    _pbClearFastCache(['bookings', 'platformAvailability']);
    return result;
  },

  async getPublicBalancePaymentStatus({ balanceRequestId, balanceToken }) {
    if (!PB_PLATFORM_V1) throw new Error('The tenant balance-payment service is not enabled.');
    const result = await _invokeEdgeFunction(
      `balance-payment-status?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        tenantSlug: PB_TENANT_SLUG,
        balanceRequestId: String(balanceRequestId || ''),
        balanceToken: String(balanceToken || ''),
      },
      { preferDirect: true }
    );
    if (!result?.ok || !result?.balance) {
      throw new Error(result?.message || result?.error || 'The remaining-balance request is unavailable.');
    }
    return result.balance;
  },

  async submitPublicBalanceReceipt({
    bookingReference,
    balanceRequestId,
    balanceToken,
    paymentMethod,
    paymentReference = '',
    receiptFile,
  }) {
    return this.submitPublicPaymentReceipt({
      bookingReference,
      bookingToken: balanceToken,
      balanceRequestId,
      paymentMethod,
      paymentReference,
      receiptFile,
    });
  },

  async startPlayerRainReport({
    bookingReference,
    clientRequestId,
    bookingToken = '',
    bookingContact = '',
    turnstileToken = '',
  } = {}) {
    if (!PB_PLATFORM_V1) throw new Error('Player rain reporting is not available.');
    const reference = String(bookingReference || '').trim().toUpperCase();
    const requestId = String(clientRequestId || '').trim().toLowerCase();
    const token = String(bookingToken || '').trim();
    const contact = String(bookingContact || '').trim();
    const turnstile = String(turnstileToken || '').trim();
    if (!reference) throw new Error('Enter your booking reference.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
      throw new Error('Please refresh and try again.');
    }
    if (Boolean(token) === Boolean(contact)) {
      throw new Error('Use your saved booking access or enter the exact booking contact.');
    }
    if (!token && !turnstile) throw new Error('Please complete the security check.');
    const result = await _invokeEdgeFunction(
      `player-rain-report?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'start',
        tenantSlug: PB_TENANT_SLUG,
        bookingReference: reference,
        clientRequestId: requestId,
        ...(token
          ? { bookingToken: token }
          : { bookingContact: contact, turnstileToken: turnstile }),
      },
      { preferDirect: true }
    );
    const claim = _pbNormalizePlayerRainClaim(result.claim);
    const claimToken = String(result.claimToken || '').trim();
    if (!result?.ok || !claim || !claimToken ||
        !_pbPlayerRainStartPolicyAccepted(claim, result.idempotent === true)) {
      throw new Error('The rain report could not be started. Please try again.');
    }
    return { claim, claimToken, idempotent: result.idempotent === true };
  },

  async getPlayerRainReportStatus({ claimId, claimToken } = {}) {
    if (!PB_PLATFORM_V1) throw new Error('Player rain reporting is not available.');
    const result = await _invokeEdgeFunction(
      `player-rain-report?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'status',
        tenantSlug: PB_TENANT_SLUG,
        claimId: String(claimId || '').trim(),
        claimToken: String(claimToken || '').trim(),
      },
      { preferDirect: true }
    );
    const claim = _pbNormalizePlayerRainClaim(result.claim);
    if (!result?.ok || !claim) throw new Error('The rain report status is unavailable.');
    return claim;
  },

  async submitPlayerRainProof({
    claimId,
    claimToken,
    proofFile,
    reportNote = '',
    payoutDestination = null,
  } = {}) {
    if (!PB_PLATFORM_V1) throw new Error('Player rain reporting is not available.');
    if (!proofFile) throw new Error('Add a clear photo of the rainy or wet court.');
    const destination = payoutDestination && typeof payoutDestination === 'object'
      ? {
          method: String(payoutDestination.method || '').trim().toLowerCase(),
          accountName: String(payoutDestination.accountName || '').trim(),
          mobileNumber: String(payoutDestination.mobileNumber || '').trim(),
        }
      : null;
    if (!destination || destination.method !== 'gcash' ||
        destination.accountName.length < 2 || destination.accountName.length > 100 ||
        !/^\+639\d{9}$/.test(destination.mobileNumber)) {
      throw new Error('Enter the GCash account name and a valid Philippine GCash mobile number.');
    }
    const imageFile = await _pbPrepareReceiptImage(proofFile);
    const imageType = String(imageFile?.type || '').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(imageType)) {
      throw new Error('Use a JPEG, PNG, or WebP court photo.');
    }
    const form = new FormData();
    form.append('proofFile', imageFile, imageFile.name || 'rain-court-proof.jpg');
    form.append('payoutDestination', JSON.stringify(destination));
    const note = String(reportNote || '').trim();
    if (note) form.append('reportNote', note);
    const response = await _pbFetchWithTimeout(
      `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/player-rain-report?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'X-Rain-Action': 'submit',
          'X-Claim-ID': String(claimId || '').trim(),
          'X-Claim-Token': String(claimToken || '').trim(),
        },
        body: form,
      },
      PB_RECEIPT_TIMEOUT_MS
    );
    const text = await response.text();
    const result = _safeJsonParse(text) || {};
    const claim = _pbNormalizePlayerRainClaim(result.claim);
    if (!response.ok || result.ok !== true || !claim) {
      const failure = new Error(_pbApiErrorMessage(
        result,
        '',
        'The court photo could not be submitted. Please try again.'
      ));
      failure.code = result?.error?.code || null;
      failure.httpStatus = response.status;
      throw failure;
    }
    return claim;
  },

  async getPublicBookingStatus({ bookingReference, bookingToken }) {
    if (!PB_PLATFORM_V1) throw new Error('The tenant booking-status service is not enabled.');
    const result = await _invokeEdgeFunction(
      `booking-status?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        tenantSlug: PB_TENANT_SLUG,
        bookingReference: String(bookingReference || ''),
        bookingToken: String(bookingToken || ''),
      },
      { preferDirect: true }
    );
    const booking = _pbNormalizePublicBookingStatus(result?.booking);
    if (!result?.ok || !booking) {
      throw new Error(result?.message || result?.error || 'Booking status is unavailable.');
    }
    return booking;
  },

  async cancelPublicBookingHold({ bookingReference, bookingToken }) {
    if (!PB_PLATFORM_V1) throw new Error('The tenant booking-cancellation service is not enabled.');
    const result = await _invokeEdgeFunction(
      `cancel-booking?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        tenantSlug: PB_TENANT_SLUG,
        bookingReference: String(bookingReference || ''),
        bookingToken: String(bookingToken || ''),
      },
      { preferDirect: true }
    );
    if (!result?.ok || !result?.cancellation) {
      throw new Error(result?.message || result?.error || 'The slot could not be released.');
    }
    _pbClearFastCache(['bookings', 'platformAvailability']);
    return result.cancellation;
  },

  async createPaymentSession(payload) {
    if (PB_PLATFORM_V1) {
      const error = new Error('Online payment checkout is not configured for the tenant platform.');
      error.code = 'PLATFORM_PAYMENT_API_REQUIRED';
      throw error;
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Supabase configuration missing (SUPABASE_URL / SUPABASE_ANON_KEY).');
    }
    const { data, error } = await _sb.functions.invoke('create-payment-session', { body: payload });
    if (!error && data) return data;

    // Fallback path: direct HTTP call to the function endpoint. This helps diagnose
    // invoke-wrapper issues and still allows checkout if endpoint is reachable.
    try {
      return await _invokePaymentSessionFallback(payload);
    } catch (fallbackErr) {
      const baseReason = _extractFnError(error, 'Failed to send a request to the Edge Function');
      const fbReason = _extractFnError(fallbackErr, 'Fallback call failed');
      console.error('createPaymentSession.invokeError:', error);
      console.error('createPaymentSession.fallbackError:', fallbackErr);
      throw new Error(`${baseReason}. Fallback failed: ${fbReason}`);
    }
  },

  async sendConfirmationEmail(booking, options = {}) {
    if (!booking?.email) return { ok: false, skipped: true, reason: 'No customer email' };
    if (PB_PLATFORM_V1) {
      return _invokeEdgeFunction(
        `send-booking-email?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
        {
          tenantSlug: PB_TENANT_SLUG,
          bookingReference: booking.primaryRef || booking.ref,
          emailKind: 'booking_confirmed',
          resend: true,
        },
        { allowFailure: !!options.allowFailure },
      );
    }
    return _invokeEdgeFunction('send-confirmation-email', _bookingEmailPayload(booking), {
      allowFailure: !!options.allowFailure,
    });
  },

  async sendRescheduleEmail(payload, options = {}) {
    if (!payload?.email) return { ok: false, skipped: true, reason: 'No customer email' };
    if (PB_PLATFORM_V1) {
      const result = { ok: false, skipped: true, reason: 'Platform rescheduling is not enabled.' };
      if (options.allowFailure) return result;
      throw new Error(result.reason);
    }
    return _invokeEdgeFunction('send-reschedule-email', payload, {
      allowFailure: !!options.allowFailure,
    });
  },

  async sendTelegramNotification(payload, options = {}) {
    if (PB_PLATFORM_V1) return { ok: false, skipped: true, reason: 'Telegram is not configured for the tenant platform.' };
    return _invokeEdgeFunction('send-telegram-notification', payload, {
      allowFailure: options.allowFailure !== false,
    });
  },

  async notifyBookingSubmitted(booking) {
    if (window.PB_USE_LOCAL_DATA) return { ok: true, skipped: true, reason: 'Local data mode' };
    return this.sendTelegramNotification(_telegramBookingPayload(booking, { event: 'new_booking' }), { allowFailure: true });
  },

  async notifyBookingUpdate(booking, event, note = '') {
    if (window.PB_USE_LOCAL_DATA) return { ok: true, skipped: true, reason: 'Local data mode' };
    return this.sendTelegramNotification(_telegramBookingPayload(booking, { type: 'booking_update', event, note }), { allowFailure: true });
  },

  async getIntegrationStatus() {
    if (PB_PLATFORM_V1) {
      const activation = await this.getTenantActivationSettings();
      const activeMethods = (activation.paymentMethods || []).filter(method => method.isActive);
      const hasPaymentDestination = activeMethods.some(method =>
        method.accountReference || method.qrImageUrl || method.instructions
      );
      const serverReady = activation.readiness?.publicBookingEnabled === true;
      return {
        ok: true,
        platform: true,
        legacyIntegrationsDisabled: true,
        services: [
          {
            id: 'booking-gate',
            label: 'Public booking gate',
            configured: serverReady,
            missing: serverReady ? [] : ['server readiness approval'],
            note: serverReady
              ? 'The server confirms this tenant can accept bookings.'
              : 'Public checkout stays closed until all required settings pass the server check.',
          },
          {
            id: 'billing',
            label: 'Platform booking fee',
            configured: !!activation.billing,
            missing: activation.billing ? [] : ['fee mode and amount'],
          },
          {
            id: 'payments',
            label: 'Customer payment destination',
            configured: hasPaymentDestination,
            missing: hasPaymentDestination ? [] : ['an enabled payment method with destination details'],
          },
          {
            id: 'email',
            label: 'Tenant booking email',
            configured: !activation.tenant.emailEnabled || !!activation.tenant.replyToEmail,
            missing: activation.tenant.emailEnabled && !activation.tenant.replyToEmail
              ? ['court Reply-To email']
              : [],
            note: activation.tenant.emailEnabled
              ? 'Booking email is enabled for this tenant.'
              : 'Booking email is currently disabled by the tenant setting.',
          },
        ],
      };
    }
    return _invokeEdgeFunction('integration-status', { action: 'status' }, { allowFailure: true });
  },

  // Verify an uploaded GCash/GoTyme/PNB receipt image via the Edge Function.
  // payload: { bookingRef, provider, imageFile, contentType }.
  // imageBase64 remains supported for older deployed clients.
  // Returns: { ok, status, flags, extracted, confidence, message }
  async verifyGcashReceipt(payload) {
    if (PB_PLATFORM_V1) {
      throw new Error('Use the secure customer receipt-submission workflow for platform bookings.');
    }
    // Do not use `instanceof Blob` here. Facebook/Messenger WebViews can hand
    // us a File from a different JavaScript realm, where that check is false.
    if (payload?.imageFile) {
      const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
      const imageFile = await _pbPrepareReceiptImage(payload.imageFile);
      const form = new FormData();
      form.append('action', 'verify');
      form.append('bookingRef', String(payload.bookingRef || ''));
      form.append('provider', String(payload.provider || 'gcash'));
      form.append('contentType', imageFile.type || payload.contentType || 'image/jpeg');
      if (payload.bookingData) form.append('bookingData', JSON.stringify(payload.bookingData));
      try {
        form.append('receipt', imageFile, imageFile.name || 'receipt.jpg');
      } catch (_) {
        // Older embedded WebViews may expose a file-like object that FormData
        // refuses. Base64 is a compatibility fallback, not the normal path.
        return _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile);
      }

      const res = await _pbFetchWithTimeout(fnUrl, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: form,
      }, PB_RECEIPT_TIMEOUT_MS);
      const txt = await res.text();
      const json = _safeJsonParse(txt);
      if (!res.ok) {
        const reason = String(json?.error || txt || `HTTP ${res.status}`);
        // A small set of WebViews sends multipart headers but drops the File
        // part. Retry only when the server explicitly says it got no image;
        // never retry an uncertain timeout/network request.
        const missingMultipartImage = [400, 415, 422].includes(res.status) &&
          /receipt file|multipart body|empty image/i.test(reason);
        if (missingMultipartImage) return _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile);
        throw new Error(reason);
      }
      if (!json) throw new Error('Receipt verification returned an invalid response.');
      return json;
    }

    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', { body: payload });
    if (!error && data) return data;

    // Fallback: direct HTTP call (mirrors createPaymentSession fallback).
    const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
    const sess = await _sb.auth.getSession();
    const accessToken = sess?.data?.session?.access_token || '';
    const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;
    const res = await _pbFetchWithTimeout(fnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': authHeader },
      body: JSON.stringify(payload),
    }, PB_RECEIPT_TIMEOUT_MS);
    const txt = await res.text();
    const json = _safeJsonParse(txt);
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  },

  // Request a short-lived signed URL to view a stored receipt (admin only).
  async getReceiptSignedUrl(bookingRef) {
    if (PB_PLATFORM_V1) {
      const booking = await this.getBookingByRef(bookingRef);
      if (!booking?.receiptVerificationId || !booking?.receiptImageUrl) {
        throw new Error('No receipt image is attached to this booking.');
      }
      const result = await _invokeEdgeFunction(
        `get-receipt-view-url?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
        {
          tenantSlug: PB_TENANT_SLUG,
          verificationId: booking.receiptVerificationId,
        },
        { preferDirect: true }
      );
      if (!result?.ok || !result?.signedUrl) {
        throw new Error(result?.message || result?.error || 'Could not load the protected receipt image.');
      }
      const signedUrl = new URL(String(result.signedUrl));
      const expectedHost = new URL(SUPABASE_URL).hostname;
      if (signedUrl.protocol !== 'https:' || signedUrl.hostname !== expectedHost || signedUrl.username || signedUrl.password) {
        throw new Error('The protected receipt URL was not issued by the booking platform.');
      }
      return signedUrl.href;
    }
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', bookingRef },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  // ---- SAFE FIRST-LOAD INITIALIZATION ----
  async seedDefaultData() {
    // Tenant onboarding is server-owned. Never invent courts, rates, hours, or
    // other operating data from the browser, including in preview mode.
    return;
  },

  // Check whether this user accepted the exact content-addressed agreement
  // that was just loaded from the protected server document.
  async getAgreement(userId, acceptanceVersion) {
    if (PB_PLATFORM_V1) {
      const session = Auth.getSession();
      if (!session?.id || session.id !== userId) {
        throw new Error('Agreement evidence can only be checked for the signed-in account.');
      }
      if (!/^2:[0-9a-f]{64}$/.test(String(acceptanceVersion || ''))) {
        throw new Error('A verified agreement acceptance version is required.');
      }
      const terms = await this.getAgreementTerms();
      if (terms.acceptanceVersion !== acceptanceVersion) return null;
      return terms.currentAgreement || null;
    }
    const { data, error } = await _sb.from('agreements').select('id, full_name, agreed_at').eq('user_id', userId).eq('version', acceptanceVersion).maybeSingle();
    if (error) throw error;
    return data || null;
  },

  // Load the exact protected billing/remittance terms that the agreement Edge
  // Function will snapshot again when the owner signs. Court owners cannot
  // read platform billing tables directly, so this authenticated projection is
  // the only browser-safe source of agreement terms.
  async getAgreementTerms() {
    if (!PB_PLATFORM_V1) throw new Error('Protected agreement terms require the tenant platform.');
    const result = await _invokeEdgeFunction(
      `accept-tenant-agreement-v2?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      { action: 'terms', tenantSlug: PB_TENANT_SLUG },
      { preferDirect: true }
    );
    if (!result?.ok || !result.terms ||
        !/^[0-9a-f]{64}$/.test(String(result.documentSha256 || '')) ||
        String(result.acceptanceVersion || '') !== `2:${String(result.documentSha256 || '')}`) {
      throw new Error('The protected agreement terms could not be verified.');
    }
    return {
      ...result.terms,
      documentSha256: String(result.documentSha256),
      acceptanceVersion: String(result.acceptanceVersion),
      currentAgreement: result.currentAgreement || null,
    };
  },

  // Save signed agreement
  async saveAgreement({ userId, email, fullName, role, signatureData, ipAddress, userAgent, version = 1, expectedDocumentSha256 }) {
    if (PB_PLATFORM_V1) {
      if (!/^[0-9a-f]{64}$/.test(String(expectedDocumentSha256 || ''))) {
        throw new Error('The verified agreement document is missing. Reload and review it again.');
      }
      const result = await _invokeEdgeFunction(
        `accept-tenant-agreement-v2?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
        {
          tenantSlug: PB_TENANT_SLUG,
          fullName,
          signatureData,
          expectedDocumentSha256,
        },
        { preferDirect: true }
      );
      if (!result?.ok || !result.agreement) {
        throw new Error('The signed agreement was not recorded.');
      }
      return result.agreement;
    }
    const { error } = await _sb.from('agreements').upsert({
      user_id:        userId,
      email,
      full_name:      fullName,
      role,
      version,
      signature_data: signatureData,
      ip_address:     ipAddress || null,
      user_agent:     userAgent || null,
      agreed_at:      new Date().toISOString(),
    }, { onConflict: 'user_id,version' });
    if (error) throw error;
  },

  // ---- ACCUMULATED BOOKING-FEE REMITTANCE ----
  // Financial mutations are RPC-only so the cutoff, immutable booking items,
  // proof attempts, and audit events are committed in one database transaction.
  async getBookingFeeRemittanceDashboard() {
    const tenantArgs = {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
    };
    const [dashboardResult, historyResult, destinationResult] = await Promise.all([
      _sb.rpc('get_booking_fee_remittance_dashboard', tenantArgs),
      _sb.rpc('get_booking_fee_remittance_history', {
        ...tenantArgs, p_limit: 100, p_before: null,
      }),
      _invokeEdgeFunction(
        `tenant-remittance-asset?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
        { action: 'get-destination', tenantSlug: PB_TENANT_SLUG },
        { preferDirect: true }
      ).catch(() => null),
    ]);
    if (dashboardResult.error) throw new Error(_extractFnError(dashboardResult.error, 'Could not load remittance dashboard'));
    if (historyResult.error) throw new Error(_extractFnError(historyResult.error, 'Could not load remittance history'));
    const dashboard = dashboardResult.data || {};
    const allHistory = Array.isArray(historyResult.data) ? historyResult.data : [];
    const active = Array.isArray(dashboard.open_remittances) ? dashboard.open_remittances : [];
    const history = allHistory.sort((a, b) =>
      new Date(b.settled_at || b.cancelled_at || b.prepared_at || 0)
      - new Date(a.settled_at || a.cancelled_at || a.prepared_at || 0));
    const destination = destinationResult?.ok && destinationResult.destination
      ? { ...destinationResult.destination }
      : { ...(dashboard.payment_destination || {}) };
    // Private object paths are never exposed as browser signing authority. If
    // the asset service is unavailable, account text may remain visible but
    // the QR image fails closed.
    delete destination.qr_storage_path;
    delete destination.qrStoragePath;
    if (!destinationResult?.ok) {
      delete destination.qr_url;
      delete destination.qrUrl;
    }
    return {
      ...dashboard,
      live: dashboard.accumulated || {},
      active,
      history,
      payment_destination: destination,
    };
  },

  async sendHostBalanceNotice(bookingRef, eventType = 'reminder_1d', options = {}) {
    return _invokeEdgeFunction('process-host-balance-deadlines', {
      action: 'manual', bookingRef, eventType,
    }, { allowFailure: !!options.allowFailure });
  },

  async processHostBalanceDeadlines(options = {}) {
    return _invokeEdgeFunction('process-host-balance-deadlines', {
      action: 'process', source: 'admin',
    }, { allowFailure: options.allowFailure !== false });
  },

  async getBookingBalanceNotifications(bookingKey) {
    if (!bookingKey) return [];
    const { data, error } = await _sb.from('booking_balance_notifications')
      .select('*').eq('booking_key', bookingKey).order('created_at', { ascending: false });
    if (error) { console.error('getBookingBalanceNotifications:', error); return []; }
    return data || [];
  },

  async getBookingFeeRemittanceHistory({ limit = 30, before = null } = {}) {
    const { data, error } = await _sb.rpc('get_booking_fee_remittance_history', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_limit: Math.max(1, Math.min(100, Number(limit) || 30)),
      p_before: before || null,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load remittance history'));
    return Array.isArray(data) ? data : (data || []);
  },

  async getBookingFeeRemittanceDetail(remittanceId) {
    const { data, error } = await _sb.rpc('get_booking_fee_remittance_detail', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_remittance_id: remittanceId,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load remittance details'));
    return data || null;
  },

  async prepareBookingFeeRemittance({ ownerOverride = false, overrideDueOn = null, overrideReason = null } = {}) {
    const { data, error } = await _sb.rpc('prepare_booking_fee_remittance', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_idempotency_key: _remittanceIdempotencyKey('prepare'),
      p_owner_override: ownerOverride === true,
      p_override_due_on: overrideDueOn || null,
      p_override_reason: overrideReason || null,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not prepare remittance'));
    return data || null;
  },

  async submitBookingFeeRemittance(remittanceId, {
    amount = null,
    paymentMethod = 'gcash',
    paymentRef = '',
    proofUrl = '',
    proofData = '',
    note = '',
  } = {}) {
    const proofDataUrl = String(proofData || proofUrl || '');
    _remittanceProofUpload(proofDataUrl);
    const safeRemittanceId = String(remittanceId || '').replace(/[^a-z0-9-]/gi, '');
    if (!safeRemittanceId) throw new Error('Remittance record is missing.');
    const result = await _invokeEdgeFunction(
      `tenant-remittance-asset?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'submit-proof',
        tenantSlug: PB_TENANT_SLUG,
        remittanceId: safeRemittanceId,
        amount: Number(amount),
        paymentMethod: String(paymentMethod || 'gcash').toLowerCase(),
        paymentRef: String(paymentRef || '').trim(),
        proofDataUrl,
        note: String(note || '').trim() || null,
        idempotencyKey: _remittanceIdempotencyKey('submit'),
      },
      { preferDirect: true }
    );
    if (!result?.ok || !result.remittance) throw new Error('The remittance proof was not recorded.');
    return result.remittance;
  },

  async getBookingFeeRemittanceProofUrl(proofPath, expiresIn = 300) {
    const path = String(proofPath || '').trim();
    if (!path) throw new Error('No remittance receipt is attached.');
    const result = await _invokeEdgeFunction(
      `tenant-remittance-asset?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'get-proof-url',
        tenantSlug: PB_TENANT_SLUG,
        proofPath: path,
        expiresIn: Math.max(60, Math.min(600, Number(expiresIn) || 300)),
      },
      { preferDirect: true }
    );
    if (!result?.ok || !result.proof?.signedUrl) throw new Error('Could not open the remittance receipt.');
    return result.proof;
  },

  async getBookingFeeRemittanceProofSignedUrl(proofPath, expiresIn = 300) {
    return this.getBookingFeeRemittanceProofUrl(proofPath, expiresIn);
  },

  async reviewBookingFeeRemittancePayment(paymentId, {
    approve = false,
    decision = null,
    amountAccepted = null,
    note = '',
  } = {}) {
    const requestedDecision = String(decision || (approve ? 'accept' : 'reject')).toLowerCase();
    const normalizedDecision = requestedDecision === 'approve' ? 'accept' : requestedDecision;
    const { data, error } = await _sb.rpc('review_booking_fee_remittance_payment', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_payment_id: paymentId,
      p_decision: normalizedDecision,
      p_amount_accepted: amountAccepted == null ? null : Number(amountAccepted),
      p_review_note: String(note || '').trim() || null,
      p_idempotency_key: _remittanceIdempotencyKey('review'),
    });
    if (error) throw new Error(_extractFnError(error, 'Could not review remittance payment'));
    return data || null;
  },

  async cancelBookingFeeRemittance(remittanceId, reason = '') {
    const { data, error } = await _sb.rpc('cancel_booking_fee_remittance', {
      p_tenant_slug: PB_TENANT_SLUG,
      p_hostname: _pbTenantHostname(),
      p_remittance_id: remittanceId,
      p_reason: String(reason || '').trim(),
      p_idempotency_key: _remittanceIdempotencyKey('cancel'),
    });
    if (error) throw new Error(_extractFnError(error, 'Could not cancel remittance'));
    return data || null;
  },

  async getPlatformRemittanceDestination() {
    const result = await _invokeEdgeFunction(
      `tenant-remittance-asset?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      { action: 'get-destination', tenantSlug: PB_TENANT_SLUG },
      { preferDirect: true }
    );
    if (!result?.ok || !result.destination) throw new Error('Could not load the remittance account.');
    return result.destination;
  },

  async savePlatformRemittanceDestination({
    accountName = '', accountReference = '', qrData = '', removeQr = false,
    instructions = '', method = '', dueDay = null,
  } = {}) {
    if (qrData) _remittanceProofUpload(qrData);
    const result = await _invokeEdgeFunction(
      `tenant-remittance-asset?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
      {
        action: 'save-destination',
        tenantSlug: PB_TENANT_SLUG,
        method: String(method || '').trim().toLowerCase(),
        accountName: String(accountName || '').trim(),
        accountReference: String(accountReference || '').trim(),
        dueDay: Number(dueDay),
        qrDataUrl: qrData || undefined,
        removeQr: removeQr === true,
        instructions: String(instructions || '').trim() || null,
      },
      { preferDirect: true }
    );
    if (!result?.ok || !result.destination) throw new Error('Could not save the remittance account.');
    return result.destination;
  },

  // ---- LEGACY MONTHLY BILLING (read-only compatibility) ----
  async getWeeklyFees() {
    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?order=week_start.desc,created_at.desc`, {
        headers: await _authRestHeaders(),
      });
      if (!res.ok) {
        console.error('getWeeklyFees REST error:', res.status, res.statusText);
        return [];
      }
      return await res.json();
    } catch (err) {
      console.error('getWeeklyFees:', err);
      return [];
    }
  },

  async saveWeeklyFee(statement) {
    const row = {
      court_owner_user_id: statement.courtOwnerUserId,
      court_owner_email: statement.courtOwnerEmail || null,
      week_start: statement.weekStart,
      week_end: statement.weekEnd,
      bookings_count: statement.bookingsCount || 0,
      fee_per_booking: statement.feePerBooking,
      amount_due: statement.amountDue,
      billed_refs: statement.billedRefs || [],
      status: statement.status || 'sent',
      generated_at: statement.generatedAt || new Date().toISOString(),
      due_at: statement.dueAt || null,
      sent_at: statement.sentAt || null,
      paid_at: statement.paidAt || null,
      paid_ref: statement.paidRef || null,
      paid_note: statement.paidNote || null,
      paid_by_user_id: statement.paidByUserId || null,
    };

    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees`, {
        method: 'POST',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('saveWeeklyFee error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
      const data = await res.json();
      return Array.isArray(data) ? data[0] : data;
    } catch (err) {
      console.error('saveWeeklyFee:', err);
      throw err;
    }
  },

  async updateWeeklyFee(id, updates) {
    const row = {};
    if (updates.courtOwnerUserId !== undefined) row.court_owner_user_id = updates.courtOwnerUserId;
    if (updates.courtOwnerEmail !== undefined) row.court_owner_email = updates.courtOwnerEmail;
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.paidAt !== undefined) row.paid_at = updates.paidAt;
    if (updates.paidRef !== undefined) row.paid_ref = updates.paidRef;
    if (updates.paidNote !== undefined) row.paid_note = updates.paidNote;
    if (updates.paidByUserId !== undefined) row.paid_by_user_id = updates.paidByUserId;
    if (updates.sentAt !== undefined) row.sent_at = updates.sentAt;
    if (updates.dueAt !== undefined) row.due_at = updates.dueAt;
    if (updates.bookingsCount !== undefined) row.bookings_count = updates.bookingsCount;
    if (updates.amountDue !== undefined) row.amount_due = updates.amountDue;
    if (updates.feePerBooking !== undefined) row.fee_per_booking = updates.feePerBooking;
    if (updates.billedRefs !== undefined) row.billed_refs = updates.billedRefs;
    if (updates.generatedAt !== undefined) row.generated_at = updates.generatedAt;

    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?id=eq.${id}`, {
        method: 'PATCH',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('updateWeeklyFee error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      console.error('updateWeeklyFee:', err);
      throw err;
    }
  },

  // Court owner submits a payment proof for their statement
  async submitWeeklyFeePayment(id, { submittedRef, submittedNote, submittedProofUrl }) {
    const row = {
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      submitted_ref: submittedRef || null,
      submitted_note: submittedNote || null,
      submitted_proof_url: submittedProofUrl || null,
    };
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?id=eq.${id}`, {
        method: 'PATCH',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('submitWeeklyFeePayment error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      console.error('submitWeeklyFeePayment:', err);
      throw err;
    }
  },
};
// Copied interfaces that are outside this tenant's protected platform remain
// unavailable even when called directly from DevTools.
if (PB_PLATFORM_V1) {
  const disabledPlatformReads = {
    // Copied legacy tables and host-finance interfaces are not tenant-safe in
    // the shared schema. Keep them inert even when called directly in DevTools.
    getDeletedBookingArchive: [],
    getHostFinanceAccounts: [],
    getHostFinanceBookings: [],
    getWeeklyFees: [],
    getBookingBalanceNotifications: [],
  };
  Object.entries(disabledPlatformReads).forEach(([method, value]) => {
    window.DB[method] = async () => _pbClone(value);
  });
  [
    'restoreDeletedBookingArchive', 'saveAccount', 'deleteAccount', 'markBookingsBilled',
    'saveWeeklyFee', 'updateWeeklyFee', 'submitWeeklyFeePayment',
    'sendHostBalanceNotice', 'processHostBalanceDeadlines',
  ].forEach(method => {
    window.DB[method] = async () => {
      throw new Error('This copied legacy operation is not enabled for this tenant.');
    };
  });
}

// =============================================
// AUTH — Supabase Auth (email + password)
// Admin accounts are managed in Supabase Dashboard → Authentication → Users
// The accounts table stores role/display info linked by email.
// =============================================
window.Auth = {

  // ── Role model ──────────────────────────────────────────
  // owner       → System Owner   (full access: everything + accounts)
  // court_owner → Court Owner    (operations + payment settings, no account mgmt)
  // staff       → Court Staff    (front-desk: bookings and payment review)
  ROLES: ['owner', 'court_owner', 'staff'],
  ROLE_LABELS: { owner: 'System Owner', court_owner: 'Court Owner', staff: 'Court Staff' },
  ROLE_PERMISSIONS: {
    owner:       ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play_roster', 'open_play_manage', 'remittances', 'blocked_dates', 'payments', 'accounts', 'booking_delete', 'export', 'settings', 'owner_only'],
    court_owner: ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play_roster', 'open_play_manage', 'remittances', 'payments', 'export', 'settings', 'court_owner_only'],
    staff:       ['bookings', 'payment_review', 'open_play_roster'],
  },

  permissionsFor(role) {
    return this.ROLE_PERMISSIONS[role] || [];
  },

  can(action, role) {
    const r = role || (this.getSession() && this.getSession().role);
    return this.permissionsFor(r).includes(action);
  },

  hasRole(role) {
    const sess = this.getSession();
    if (!sess) return false;
    if (sess.role === 'owner') return true; // system owner has all access
    return sess.role === role;
  },

  async refreshSessionFromAuth({ remember = null } = {}) {
    if (!PB_SUPABASE_AUTH_CONFIGURED) {
      this._lastLoginMessage = 'Dashboard authentication is not configured.';
      return null;
    }
    const { data: authData, error } = await _sb.auth.getUser();
    if (error || !authData?.user) {
      this._lastLoginMessage = error
        ? 'Could not verify your sign-in right now. Please check your connection and try again.'
        : 'Your sign-in session is no longer available. Please log in again.';
      return null;
    }

    const { data: acc, error: accountErr } = await _sb.rpc(
      'get_my_tenant_session',
      {
        p_tenant_slug: PB_TENANT_SLUG,
        p_hostname: PB_IS_LOCAL_HOST
          ? String(PB_RUNTIME_CONFIG.productionHosts?.[0] || window.location.hostname)
          : window.location.hostname,
      }
    );

    if (accountErr) {
      console.error('refreshSessionFromAuth tenant session lookup:', accountErr);
      this._lastLoginMessage = 'Could not verify your account status right now. Please try again in a moment.';
      sessionStorage.removeItem('pickle-street-tugbok-session');
      localStorage.removeItem('pickle-street-tugbok-session');
      return null;
    }

    if (!acc || acc.tenantSlug !== PB_TENANT_SLUG ||
        acc.tenantId !== 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' ||
        acc.id !== authData.user.id || acc.status !== 'active' ||
        !['owner','admin','court_owner','staff'].includes(acc.role)) {
      this._lastLoginMessage = 'This login is not linked to a dashboard account.';
      await _sb.auth.signOut();
      sessionStorage.removeItem('pickle-street-tugbok-session');
      localStorage.removeItem('pickle-street-tugbok-session');
      return null;
    }

    const role = acc.role === 'admin' ? 'court_owner' : acc.role;
    const session = {
      id: acc.id || authData.user.id,
      tenantId: acc.tenantId || null,
      tenantSlug: acc.tenantSlug || PB_TENANT_SLUG,
      membershipRole: acc.membershipRole || null,
      username: acc.username || String(acc.email || authData.user.email || '').split('@')[0],
      role,
      status: acc.status || 'active',
      fullName: acc.fullName || authData.user.user_metadata?.full_name || authData.user.email || 'Account',
      email: acc.email || authData.user.email || '',
      loginAt: new Date().toISOString(),
    };

    if (session.status && session.status !== 'active') {
      this._lastLoginMessage = 'This account is not active. Please contact the court owner.';
      await _sb.auth.signOut();
      sessionStorage.removeItem('pickle-street-tugbok-session');
      localStorage.removeItem('pickle-street-tugbok-session');
      return null;
    }

    const shouldRemember = remember === null ? localStorage.getItem('pickle-street-tugbok-remember') === '1' : !!remember;
    sessionStorage.removeItem('pickle-street-tugbok-session');
    localStorage.removeItem('pickle-street-tugbok-session');
    const store = shouldRemember ? localStorage : sessionStorage;
    store.setItem('pickle-street-tugbok-session', JSON.stringify(session));
    if (shouldRemember) localStorage.setItem('pickle-street-tugbok-remember', '1');
    else localStorage.removeItem('pickle-street-tugbok-remember');
    return session;
  },

  async login(email, password, remember = false) {
    // Select the storage scope before Supabase writes its verified JWT.
    if (remember) localStorage.setItem(PB_AUTH_REMEMBER_KEY, '1');
    else localStorage.removeItem(PB_AUTH_REMEMBER_KEY);
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      localStorage.removeItem(PB_AUTH_REMEMBER_KEY);
      return { ok: false, msg: error?.message || 'Invalid email or password.' };
    }
    this._lastLoginMessage = '';
    const session = await this.refreshSessionFromAuth({ remember });
    return session ? { ok: true } : { ok: false, msg: this._lastLoginMessage || 'Account is not active.' };
  },

  getSession() {
    // Check localStorage first (remembered), then sessionStorage (tab-only).
    const s = localStorage.getItem('pickle-street-tugbok-session') || sessionStorage.getItem('pickle-street-tugbok-session');
    if (!s) return null;
    try { return JSON.parse(s); }
    catch (_) {
      localStorage.removeItem('pickle-street-tugbok-session');
      sessionStorage.removeItem('pickle-street-tugbok-session');
      return null;
    }
  },

  requireAuth() {
    const sess = this.getSession();
    if (!sess) { window.location.href = 'login.html'; return null; }
    return sess;
  },

  async logout() {
    await _sb.auth.signOut();
    sessionStorage.removeItem('pickle-street-tugbok-session');
    localStorage.removeItem('pickle-street-tugbok-session');
    localStorage.removeItem('pickle-street-tugbok-remember');
    window.location.href = 'login.html';
  },

  // Used by admin.html account management
  async getAll() {
    return DB.getAccounts();
  },

  async add(d) {
    try {
      const result = await _invokeEdgeFunction(`manage-account?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`, {
        action: 'create',
        tenantSlug: PB_TENANT_SLUG,
        fullName: d.fullName,
        email: d.email,
        password: d.password,
        role: ['court_owner', 'staff'].includes(d.role) ? d.role : 'staff',
        status: d.status || 'active',
      }, { preferDirect: true });
      if (!result?.ok) throw new Error(result?.error || 'Account create failed.');
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account create failed.') };
    }
  },

  async update(id, d) {
    try {
      const payload = {
        action: 'update',
        tenantSlug: PB_TENANT_SLUG,
        id,
        fullName: d.fullName,
        email: d.email,
        role: ['court_owner', 'staff'].includes(d.role) ? d.role : 'staff',
        status: d.status || 'active',
      };
      if (d.password) payload.password = d.password;
      const result = await _invokeEdgeFunction(
        `manage-account?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`,
        payload,
        { preferDirect: true }
      );
      if (!result?.ok) throw new Error(result?.error || 'Account update failed.');
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account update failed.') };
    }
  },

  // Self-service password change for the currently signed-in user.
  // Verifies the current password first, then updates Supabase Auth (the source
  // of truth for login). Any signed-in role (owner / court_owner / staff) can use it.
  async changePassword(currentPassword, newPassword) {
    const sess = this.getSession();
    if (!sess || !sess.email) return { ok: false, msg: 'No active session. Please sign in again.' };
    const strongPassword = typeof newPassword === 'string' && newPassword.length >= 14 &&
      !/\s/.test(newPassword) && /[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) &&
      /\d/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword);
    if (!strongPassword) {
      return { ok: false, msg: 'Use at least 14 characters with uppercase, lowercase, a number, and a symbol, without spaces.' };
    }

    // Re-authenticate to confirm the current password is correct.
    const { error: authErr } = await _sb.auth.signInWithPassword({ email: sess.email, password: currentPassword });
    if (authErr) return { ok: false, msg: 'Current password is incorrect.' };

    // Update the password in Supabase Auth.
    const { error: updErr } = await _sb.auth.updateUser({ password: newPassword });
    if (updErr) return { ok: false, msg: updErr.message || 'Could not update password.' };

    return { ok: true };
  },

  async del(id) {
    try {
      const result = await _invokeEdgeFunction(`manage-account?tenantSlug=${encodeURIComponent(PB_TENANT_SLUG)}`, {
        action: 'delete',
        tenantSlug: PB_TENANT_SLUG,
        id,
      }, { preferDirect: true });
      if (!result?.ok) throw new Error(result?.error || 'Account suspension failed.');
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account suspension failed.') };
    }
  },
};
