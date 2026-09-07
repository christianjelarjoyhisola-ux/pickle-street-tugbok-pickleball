// =============================================
// SUPABASE CONFIGURATION
// Replace these with your actual project credentials.
// Find them at: Supabase Dashboard → Project Settings → API
// =============================================
// Dedicated Pickle Street project. The anon key is safe for browser use because
// database access is enforced by the project's Row Level Security policies.
const SUPABASE_URL = 'https://neqvrwtofiolcuxewdze.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';

const PB_REQUEST_TIMEOUT_MS = 45000;
const PB_RECEIPT_TIMEOUT_MS = 90000;
const PB_PRIVATE_DATA_SURFACE = /^\/(?:admin|signature-view)(?:\.html)?\/?$/i.test(location.pathname);
const _pbLocalStagedReceipts = new Map();

function normalizeOpenPlaySkillLevel(value, fallback = 1) {
  const level = Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : fallback;
}

function openPlayPerformanceSeed(skillLevel) {
  if (window.PBOpenPlayRating?.seedRating) {
    return window.PBOpenPlayRating.seedRating(skillLevel);
  }
  return 1000 + (normalizeOpenPlaySkillLevel(skillLevel) - 1) * 100;
}

function normalizeOpenPlayRankingMode(value) {
  if (window.PBOpenPlayRating?.normalizeRankingMode) {
    return window.PBOpenPlayRating.normalizeRankingMode(value);
  }
  if (value === 'competitive') return 'competitive';
  return value === 'win_percentage' ? 'win_percentage' : 'performance';
}

function _pbApiError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function _pbFetchWithTimeout(input, init = {}, timeoutMs = PB_REQUEST_TIMEOUT_MS) {
  throw new Error('The demonstration does not connect to a live database.');

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

// Initialize Supabase client (uses UMD global loaded from CDN). A bounded
// fetch prevents embedded browsers from leaving the booking button hanging.
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: (input, init) => _pbFetchWithTimeout(input, init) },
});

// Expose globally so HTML pages can use real-time subscriptions
window._supabase = _sb;

const PB_IS_LOCAL_HOST = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const PB_DATA_MODE_KEY = 'pb_data_mode';
const PB_HAS_PLACEHOLDER_BACKEND = SUPABASE_URL.includes('YOUR_PROJECT_REF') || SUPABASE_ANON_KEY.includes('YOUR_SUPABASE');
const PB_IS_PADDLE_RAGE_PAGES = location.hostname === 'paddle-rage-pickleball.pages.dev'
  || location.hostname.endsWith('.paddle-rage-pickleball.pages.dev');
const PB_IS_CLOUDFLARE_DEMO = PB_HAS_PLACEHOLDER_BACKEND && PB_IS_PADDLE_RAGE_PAGES;

if (PB_IS_LOCAL_HOST) {
  const params = new URLSearchParams(location.search);
  if (['1', 'true', 'local'].includes((params.get('localData') || '').toLowerCase())) {
    localStorage.setItem(PB_DATA_MODE_KEY, 'local');
  }
  if (['1', 'true', 'remote'].includes((params.get('remoteData') || '').toLowerCase())) {
    localStorage.removeItem(PB_DATA_MODE_KEY);
  }
}

// The isolated Pickle Street Pages site automatically uses browser-only demo data
// until a dedicated Supabase project replaces the placeholders above.
window.PB_USE_LOCAL_DATA = PB_IS_CLOUDFLARE_DEMO
  || (PB_IS_LOCAL_HOST && localStorage.getItem(PB_DATA_MODE_KEY) === 'local');

const PB_FAST_CACHE_MS = {
  courts: 60000,
  settings: 30000,
  blockedDates: 30000,
  bookings: 3500,
  openPlay: 3500,
};
const PB_BOOKING_ACCESS_TOKENS_KEY = 'pb_booking_access_tokens_v1';
const PB_BOOKING_ACCESS_TOKEN_LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PB_BOOKING_ACCESS_TOKEN_HARD_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const _pbFastCache = new Map();
let _pbAccountRoleCache = null;

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

async function _pbCurrentAccountRole() {
  const { data: sessionData, error: sessionError } = await _sb.auth.getSession();
  if (sessionError) throw sessionError;
  const userId = sessionData?.session?.user?.id || '';
  if (!userId) return '';

  const now = Date.now();
  if (_pbAccountRoleCache?.userId === userId && now - _pbAccountRoleCache.at < 30000) {
    return _pbAccountRoleCache.role;
  }

  const { data, error } = await _sb
    .from('accounts')
    .select('role,status')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  const role = data?.status === 'active' ? String(data.role || '') : '';
  _pbAccountRoleCache = { userId, role, at: now };
  return role;
}

async function _pbHasActiveAccount() {
  return !!(await _pbCurrentAccountRole());
}

function _pbLoadBookingAccessTokens() {
  let stored = {};
  let needsCleanup = false;
  try {
    stored = JSON.parse(localStorage.getItem(PB_BOOKING_ACCESS_TOKENS_KEY) || '{}');
  } catch (_) {
    stored = {};
    needsCleanup = true;
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    stored = {};
    needsCleanup = true;
  }

  const now = Date.now();
  const legacyCutoff = now - PB_BOOKING_ACCESS_TOKEN_LEGACY_MAX_AGE_MS;
  const cleaned = Object.fromEntries(
    Object.entries(stored)
      .filter(([, entry]) => {
        if (!entry || typeof entry.token !== 'string') return false;
        const createdAt = Number(entry.createdAt || 0);
        const expiresAt = Number(entry.expiresAt || 0);
        if (Number.isFinite(expiresAt) && expiresAt > 0) {
          return expiresAt > now && expiresAt <= createdAt + PB_BOOKING_ACCESS_TOKEN_HARD_MAX_AGE_MS;
        }
        // Legacy hold tokens had no explicit booking-bound expiry. Preserve
        // their original 24-hour behavior rather than silently extending them.
        return createdAt >= legacyCutoff;
      })
      .sort(([, a], [, b]) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 100)
  );
  if (needsCleanup || JSON.stringify(cleaned) !== JSON.stringify(stored)) {
    _pbSaveBookingAccessTokens(cleaned);
  }
  return cleaned;
}

function _pbSaveBookingAccessTokens(tokens) {
  try {
    localStorage.setItem(PB_BOOKING_ACCESS_TOKENS_KEY, JSON.stringify(tokens || {}));
  } catch (_) {}
}

function _pbBookingAccessToken(ref, create = false, expiresAt = 0) {
  const key = String(ref || '').trim().toUpperCase();
  if (!key) return '';
  const tokens = _pbLoadBookingAccessTokens();
  if (tokens[key]?.token) {
    const requestedExpiry = Number(expiresAt || 0);
    if (create && Number.isFinite(requestedExpiry) && requestedExpiry > Date.now()) {
      const hardExpiry = Number(tokens[key].createdAt || Date.now()) + PB_BOOKING_ACCESS_TOKEN_HARD_MAX_AGE_MS;
      tokens[key].expiresAt = Math.min(requestedExpiry, hardExpiry);
      _pbSaveBookingAccessTokens(tokens);
    }
    return tokens[key].token;
  }
  if (!create) return '';
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('This browser cannot securely create a booking access token.');
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const token = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  const createdAt = Date.now();
  const requestedExpiry = Number(expiresAt || 0);
  tokens[key] = {
    token,
    createdAt,
    ...(Number.isFinite(requestedExpiry) && requestedExpiry > createdAt
      ? { expiresAt: Math.min(requestedExpiry, createdAt + PB_BOOKING_ACCESS_TOKEN_HARD_MAX_AGE_MS) }
      : {}),
  };
  _pbSaveBookingAccessTokens(tokens);
  return token;
}

function _pbRememberBookingAccessToken(ref, token, expiresAt = 0) {
  const key = String(ref || '').trim().toUpperCase();
  if (!key || !token) return;
  const tokens = _pbLoadBookingAccessTokens();
  const existing = tokens[key];
  const createdAt = existing?.token === String(token) ? Number(existing.createdAt || Date.now()) : Date.now();
  const requestedExpiry = Number(expiresAt || 0);
  tokens[key] = {
    token: String(token),
    createdAt,
    ...(Number.isFinite(requestedExpiry) && requestedExpiry > Date.now()
      ? { expiresAt: Math.min(requestedExpiry, createdAt + PB_BOOKING_ACCESS_TOKEN_HARD_MAX_AGE_MS) }
      : existing?.expiresAt ? { expiresAt: existing.expiresAt } : {}),
  };
  _pbSaveBookingAccessTokens(tokens);
}

function _pbBookingAccessExpiry() {
  // Keep the device proof long enough to survive a staff reschedule. The RPC
  // remains authoritative and refuses access seven days after the current
  // booking date, with the same absolute 400-day cap enforced server-side.
  return Date.now() + PB_BOOKING_ACCESS_TOKEN_HARD_MAX_AGE_MS;
}

function _pbForgetBookingAccessToken(ref) {
  const key = String(ref || '').trim().toUpperCase();
  if (!key) return;
  const tokens = _pbLoadBookingAccessTokens();
  if (!Object.prototype.hasOwnProperty.call(tokens, key)) return;
  delete tokens[key];
  _pbSaveBookingAccessTokens(tokens);
}

function _pbForgetBookingAccessTokenFamily(token) {
  const normalized = String(token || '');
  if (!normalized) return;
  const tokens = _pbLoadBookingAccessTokens();
  let changed = false;
  Object.keys(tokens).forEach(key => {
    if (String(tokens[key]?.token || '') !== normalized) return;
    delete tokens[key];
    changed = true;
  });
  if (changed) _pbSaveBookingAccessTokens(tokens);
}

async function _pbSha256Hex(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') {
    throw new Error('This browser cannot securely protect the booking access token.');
  }
  const input = new TextEncoder().encode(String(value || ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function _safeJsonParse(v) {
  try { return JSON.parse(v); } catch(_) { return null; }
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
    return encoded?.size ? encoded : file;
  } catch (_) {
    return file;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile, authHeader = '') {
  const imageBase64 = await _pbFileToDataUrl(imageFile);
  const fallbackPayload = {
    action: String(payload?.action || 'verify'),
    bookingRef: String(payload?.bookingRef || ''),
    provider: String(payload?.provider || 'gcash'),
    contentType: imageFile?.type || payload?.contentType || 'image/jpeg',
    imageBase64,
    ...(payload?.bookingData ? { bookingData: payload.bookingData } : {}),
    ...(payload?.bookingAccessToken ? { bookingAccessToken: payload.bookingAccessToken } : {}),
  };
  const res = await _pbFetchWithTimeout(fnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': authHeader || `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(fallbackPayload),
  }, PB_RECEIPT_TIMEOUT_MS);
  const txt = await res.text();
  const json = _safeJsonParse(txt);
  if (!res.ok) throw new Error(json?.error || txt || `HTTP ${res.status}`);
  if (!json) throw new Error('Receipt service returned an invalid response.');
  return json;
}

function _pbCanFallbackReceiptTransport(error, startedAt) {
  const elapsedMs = Math.max(0, Date.now() - Number(startedAt || 0));
  const name = String(error?.name || '');
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  if (
    name === 'AbortError' ||
    code === 'PB_REQUEST_TIMEOUT' ||
    /timed out|timeout|aborted/i.test(message)
  ) return false;

  // A later network failure is ambiguous: the multipart request may already
  // have reached Storage. Retry only failures that surface immediately and
  // look like a browser/FormData transport incompatibility.
  return elapsedMs <= 1000 && (
    name === 'TypeError' ||
    /failed to fetch|network request failed|load failed|formdata|multipart/i.test(message)
  );
}

async function _pbReceiptCheckpointRequest(action, payload = {}) {
  const bookingRef = String(payload?.bookingRef || '').trim();
  if (!bookingRef) throw new Error('Booking reference is required.');
  const storedBookingToken = _pbBookingAccessToken(bookingRef, false);
  const sessionResult = await _sb.auth.getSession();
  const userAccessToken = sessionResult?.data?.session?.access_token || '';
  const authHeader = `Bearer ${userAccessToken || SUPABASE_ANON_KEY}`;
  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
  const requestPayload = {
    ...(payload || {}),
    action,
    bookingRef,
    ...(storedBookingToken ? { bookingAccessToken: storedBookingToken } : {}),
  };
  const res = await _pbFetchWithTimeout(fnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': authHeader,
    },
    body: JSON.stringify(requestPayload),
  }, PB_RECEIPT_TIMEOUT_MS);
  const txt = await res.text();
  const json = _safeJsonParse(txt);
  if (!res.ok) throw _pbApiError(
    String(json?.error || txt || `HTTP ${res.status}`),
    String(json?.code || `HTTP_${res.status}`),
  );
  if (!json) throw new Error('Receipt checkpoint service returned an invalid response.');
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

async function _invokeEdgeFunction(name, payload = {}, {
  allowFailure = false,
  preferDirect = false,
  retryDirect = true,
} = {}) {
  let data = null;
  let error = null;
  if (!preferDirect) {
    try {
      ({ data, error } = await _sb.functions.invoke(name, { body: payload }));
    } catch (invokeErr) {
      error = invokeErr;
    }
    if (!error && data) return data;
    if (!retryDirect) {
      const reason = error
        ? _extractFnError(error, 'Function invoke failed')
        : 'Function returned an empty response';
      if (allowFailure) return { ok: false, error: reason };
      throw new Error(reason);
    }
  }

  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${name}`;
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

  try {
    const res = await fetch(fnUrl, {
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
    if (!res.ok) throw new Error(json.error || txt || `HTTP ${res.status}`);
    return json;
  } catch (fallbackErr) {
    const fallbackReason = _extractFnError(fallbackErr, 'Fallback call failed');
    const reason = error ? `${_extractFnError(error, 'Function invoke failed')}. ${fallbackReason}` : fallbackReason;
    if (allowFailure) return { ok: false, error: reason };
    throw new Error(reason);
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
    // Always send a real row reference to the Edge Function. Group display
    // labels can omit the internal "-G" suffix and are not database keys.
    bookingRef: b.primaryRef || b.ref || b.displayRef,
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

// =============================================
// ROW ↔ JS OBJECT MAPPING
// SQL uses snake_case; JS objects use camelCase
// =============================================
const PB_DIGITAL_PAYMENT_METHODS = ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'];

function _pbNormalizeReceiptOutcome(result) {
  const source = result && typeof result === 'object' ? result : {};
  if (String(source.status || '').toLowerCase() === 'auto_approved') return source;
  return {
    ...source,
    status: 'manual_review',
    paymentStatus: ['pending', 'for_verification'].includes(String(source.paymentStatus || '').toLowerCase())
      ? source.paymentStatus
      : 'for_verification',
    bookingStatus: 'pending',
    publicReason: source.publicReason || source.message || 'Receipt needs court-owner review.',
  };
}

function normalizePaymentKey(value, fallback = '') {
  return String(value || fallback || '').toLowerCase().trim();
}

function receivedAccountForBooking(b = {}) {
  const explicit = normalizePaymentKey(b.receivedAccount || b.received_account);
  if (explicit) return explicit;

  const method = normalizePaymentKey(b.paymentMethod || b.payment_method, 'cash');
  if (method === 'cash') return 'cash';
  return 'gcash';
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
    bookingFeeAmountSnapshot: r.booking_fee_amount_snapshot != null ? Number(r.booking_fee_amount_snapshot) : null,
    bookingFeeRateSnapshot: r.booking_fee_rate_snapshot != null ? Number(r.booking_fee_rate_snapshot) : null,
    bookingFeeTypeSnapshot: r.booking_fee_type_snapshot || null,
    bookingFeeUnitsSnapshot: r.booking_fee_units_snapshot != null ? Number(r.booking_fee_units_snapshot) : null,
    bookingFeeSnapshotSource: r.booking_fee_snapshot_source || null,
    bookingFeeLedgerEligibleSnapshot: !!r.booking_fee_ledger_eligible_snapshot,
    bookingFeeEarnedAt: r.booking_fee_earned_at || null,
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
    receiptImageHash:  r.receipt_image_hash || null,
    receiptPhash:      r.receipt_phash || null,
    receiptVerifiedAt: r.receipt_verified_at || null,
    receiptVerificationId: Number(r.receipt_verification_id) || null,
    paymentTransferId: r.payment_transfer_id || null,
    paymentReassignedFromRef: r.payment_reassigned_from_ref || null,
    paymentReassignedToRef: r.payment_reassigned_to_ref || null,
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
const PB_PUBLIC_COURT_OPENING_DATE = '2026-01-01';

function _pbManilaToday() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function _pbMinimumPublicBookingDate() {
  const today = _pbManilaToday();
  return today > PB_PUBLIC_COURT_OPENING_DATE ? today : PB_PUBLIC_COURT_OPENING_DATE;
}

function _pbRpcResultError(data, fallback) {
  return _pbApiError(
    String(data?.error || data?.message || fallback),
    String(data?.code || 'RPC_REQUEST_FAILED'),
  );
}

function _pbNormalizeAvailabilityGraphicSnapshot(payload, requestedDate, requestedCourtIds = []) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const expectedDate = String(requestedDate || '');
  if (!value || value.version !== 1 || value.date !== expectedDate || value.timezone !== 'Asia/Manila') {
    throw new Error('The availability service returned an invalid snapshot. Refresh and try again.');
  }

  const openHour = Number(value.openHour);
  const closeHour = Number(value.closeHour);
  const asOf = String(value.asOf || '');
  const courts = Array.isArray(value.courts) ? value.courts : null;
  if (!Number.isInteger(openHour) || !Number.isInteger(closeHour) || openHour < 0 || closeHour > 24 || closeHour <= openHour
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+08:00$/.test(asOf)
      || !courts || courts.length === 0) {
    throw new Error('The availability service returned an incomplete snapshot. Refresh and try again.');
  }

  const seenCourts = new Set();
  const expectedCourtIds = new Set((Array.isArray(requestedCourtIds) ? requestedCourtIds : []).map(String));
  const expectedSlotCount = closeHour - openHour;
  const normalizedCourts = courts.map(court => {
    const id = String(court?.id || '').trim();
    const name = String(court?.name || '').trim();
    const slots = Array.isArray(court?.slots) ? court.slots : null;
    if (!id || !name || seenCourts.has(id) || !slots || slots.length !== expectedSlotCount) {
      throw new Error('The availability service returned incomplete court data. Refresh and try again.');
    }
    seenCourts.add(id);

    const normalizedSlots = slots.map((slot, index) => {
      const hour = Number(slot?.hour);
      const startHour = Number(slot?.startHour);
      const endHour = Number(slot?.endHour);
      const startLabel = String(slot?.startLabel || '').trim();
      const endLabel = String(slot?.endLabel || '').trim();
      const label = String(slot?.label || '').trim();
      const state = String(slot?.state || '');
      const reason = slot?.reason == null ? null : String(slot.reason);
      if (hour !== openHour + index || startHour !== hour || endHour !== hour + 1
          || !startLabel || !endLabel || !label || !['free', 'unavailable'].includes(state)
          || (state === 'free' && reason !== null) || (state === 'unavailable' && !reason)) {
        throw new Error('The availability service returned an invalid slot state. Refresh and try again.');
      }
      return {
        hour,
        startHour,
        endHour,
        startLabel,
        endLabel,
        state,
        reason,
        label,
      };
    });
    const availableCount = normalizedSlots.filter(slot => slot.state === 'free').length;
    if (Number(court.availableCount) !== availableCount || Number(court.totalSlots) !== expectedSlotCount) {
      throw new Error('The availability service returned inconsistent slot totals. Refresh and try again.');
    }
    return { id, name, availableCount, totalSlots: expectedSlotCount, slots: normalizedSlots };
  });
  if (expectedCourtIds.size > 0
      && (seenCourts.size !== expectedCourtIds.size || [...expectedCourtIds].some(id => !seenCourts.has(id)))) {
    throw new Error('The availability service did not return the selected courts. Refresh and try again.');
  }

  return {
    version: 1,
    date: expectedDate,
    timezone: 'Asia/Manila',
    asOf,
    generatedAt: asOf,
    openHour,
    closeHour,
    courts: normalizedCourts,
  };
}

function _pbAssertPublicBookingDate(date) {
  const value = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < _pbMinimumPublicBookingDate()) {
    throw new Error('Advance booking is available from September 19, 2026.');
  }
}

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
    createdAt:    r.created_at || null,
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
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  if (!extByType[mimeType]) {
    throw new Error('Receipt must be a JPG, PNG, WebP, HEIC, or HEIF image.');
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

function rowToOpenPlayHostApplication(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    contactNumber: r.contact_number,
    email: r.email,
    hostUserId: r.host_user_id || null,
    gcashNumber: r.gcash_number || '',
    validIdFileName: r.valid_id_file_name || '',
    validIdFileType: r.valid_id_file_type || '',
    validIdFileSize: r.valid_id_file_size || null,
    validIdPath: r.valid_id_path || '',
    preferredSchedule: r.preferred_schedule || '',
    notes: r.notes || '',
    status: r.status || 'pending',
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
    reviewNote: r.review_note || '',
    emailVerifiedAt: r.email_verified_at || null,
    telegramNotificationSentAt: r.telegram_notification_sent_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hostApplicationToRow(app) {
  return {
    full_name: app.fullName,
    contact_number: app.contactNumber,
    email: app.email,
    gcash_number: app.gcashNumber || null,
    valid_id_file_name: app.validIdFileName || null,
    valid_id_file_type: app.validIdFileType || null,
    valid_id_file_size: app.validIdFileSize || null,
    valid_id_path: app.validIdPath || null,
    preferred_schedule: app.preferredSchedule || null,
    notes: app.notes || null,
    status: app.status || 'pending',
    review_note: app.reviewNote || null,
  };
}

function rowToOpenPlayHostSession(r) {
  return {
    id: r.id,
    hostUserId: r.host_user_id || null,
    hostName: r.host_name,
    hostEmail: r.host_email || '',
    title: r.title,
    date: r.date,
    startHour: Number(r.start_hour),
    endHour: Number(r.end_hour),
    courtIds: r.court_ids || [],
    courtNames: r.court_names || [],
    maxPlayers: Number(r.max_players || 0),
    feePerPlayer: Number(r.fee_per_player || 0),
    status: r.status || 'published',
    notes: r.notes || '',
    paymentInstructions: r.payment_instructions || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hostSessionToRow(session) {
  return {
    host_user_id: session.hostUserId || null,
    host_name: session.hostName,
    host_email: session.hostEmail || null,
    title: session.title,
    date: session.date,
    start_hour: session.startHour,
    end_hour: session.endHour,
    court_ids: session.courtIds || [],
    court_names: session.courtNames || [],
    max_players: session.maxPlayers || 16,
    fee_per_player: session.feePerPlayer || 0,
    status: session.status || 'published',
    notes: session.notes || null,
    payment_instructions: session.paymentInstructions || null,
  };
}

function rowToOpenPlayHostSessionRegistration(r) {
  return {
    id: r.id,
    sessionId: r.session_id,
    fullName: r.full_name,
    contactNumber: r.contact_number || '',
    paymentMethod: r.payment_method || 'gcash',
    gcashRef: r.gcash_ref || null,
    paymentStatus: r.payment_status || 'pending',
    amount: Number(r.amount || 0),
    receiptImageUrl: r.receipt_image_url || null,
    receiptImageHash: r.receipt_image_hash || null,
    receiptPhash: r.receipt_phash || null,
    receiptStatus: r.receipt_status || 'none',
    receiptFlags: r.receipt_flags || [],
    receiptExtracted: r.receipt_extracted || null,
    receiptConfidence: r.receipt_confidence != null ? Number(r.receipt_confidence) : null,
    receiptVerifiedAt: r.receipt_verified_at || null,
    receiptVerificationId: Number(r.receipt_verification_id) || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// =============================================
// DB — Async Data Layer (replaces localStorage)
// =============================================
window.DB = {

  // ---- COURTS ----
  async getCourts() {
    return _pbCached('courts', {}, PB_FAST_CACHE_MS.courts, async () => {
      const { data, error } = await _sb.from('courts').select('*').order('id');
      if (error) { console.error('getCourts:', error); return []; }
      return data.map(rowToCourt);
    });
  },

  async getAvailabilityGraphic(date, courtIds = []) {
    const requestedDate = String(date || '').trim();
    const requestedCourtIds = [...new Set((Array.isArray(courtIds) ? courtIds : [])
      .map(id => String(id || '').trim()).filter(Boolean))];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || requestedCourtIds.length > 50) {
      throw new Error('Choose a valid availability date and court selection.');
    }
    const { data, error } = await _sb.rpc('get_admin_availability_graphic', {
      p_date: requestedDate,
      p_court_ids: requestedCourtIds.length ? requestedCourtIds : null,
    });
    if (error) {
      console.error('getAvailabilityGraphic:', error);
      throw error;
    }
    return _pbNormalizeAvailabilityGraphicSnapshot(data, requestedDate, requestedCourtIds);
  },

  async getAvailabilityGraphicSnapshot(date, courtIds = []) {
    return this.getAvailabilityGraphic(date, courtIds);
  },

  async saveCourt(court) {
    const { error } = await _sb.from('courts').upsert(courtToRow(court));
    if (error) { console.error('saveCourt:', error); throw error; }
    _pbClearFastCache(['courts']);
  },

  async deleteCourt(id) {
    const { data, error } = await _sb.from('courts').delete().eq('id', id).select('id');
    if (error) { console.error('deleteCourt:', error); throw error; }
    if (!data?.some(court => String(court.id) === String(id))) {
      throw new Error('Court deletion was not confirmed. Refresh the page and check that you are signed in as an owner.');
    }
    _pbClearFastCache(['courts']);
  },

  // ---- BOOKINGS ----
  async getBookings(filters = {}) {
    const opts = filters || {};
    return _pbCached('bookings', opts, PB_FAST_CACHE_MS.bookings, async () => {
      const accountRole = await _pbCurrentAccountRole();
      const canReadFullRows = PB_PRIVATE_DATA_SURFACE
        && ['owner', 'court_owner', 'staff'].includes(accountRole);

      if (!canReadFullRows) {
        const { data, error } = await _sb.rpc('get_public_booking_availability', {
          p_date: opts.date || null,
          p_court_id: opts.courtId ? String(opts.courtId) : null,
        });
        if (error) {
          console.error('getBookings:', error);
          return [];
        }
        return (data || []).map(rowToBooking);
      }

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

  async getInsightBookings() {
    return _pbCached('bookings', { view: 'insights' }, PB_FAST_CACHE_MS.bookings, async () => {
      const accountRole = await _pbCurrentAccountRole();
      if (!PB_PRIVATE_DATA_SURFACE || !['owner', 'court_owner'].includes(accountRole)) {
        throw new Error('An active owner session is required to load Pickle Street Insights.');
      }
      const pageSize = 1000;
      const rows = [];
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await _sb
          .from('bookings')
          .select('ref,booking_group_ref,court_id,date,slots,start_time,end_time,duration,status,payment_status,created_at')
          .order('created_at', { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) {
          console.error('getInsightBookings:', error);
          throw error;
        }
        const page = data || [];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      return rows.map(row => ({
        ref: row.ref,
        groupRef: row.booking_group_ref || null,
        courtId: row.court_id,
        date: row.date,
        slots: row.slots || [],
        startTime: row.start_time,
        endTime: row.end_time,
        duration: Number(row.duration || 0),
        status: row.status,
        paymentStatus: row.payment_status || 'unpaid',
        createdAt: row.created_at,
      }));
    });
  },

  async getMyHostBookings() {
    if (!(await _pbHasActiveAccount())) {
      throw new Error('Your host session has expired. Please log in again.');
    }
    const { data, error } = await _sb.rpc('get_my_host_bookings');
    if (error) {
      console.error('getMyHostBookings:', error);
      throw error;
    }
    return (data || []).map(rowToBooking);
  },

  async markHostBookingGroupFullyPaid(bookingRef) {
    const ref = String(bookingRef || '').trim();
    if (!ref) throw new Error('A booking reference is required.');
    const { data, error } = await _sb.rpc('mark_host_booking_group_fully_paid', {
      p_booking_ref: ref,
    });
    if (error) {
      console.error('markHostBookingGroupFullyPaid:', error);
      throw error;
    }
    _pbClearFastCache(['bookings']);
    return data || {};
  },

  async restoreForfeitedHostBookingAsFullyPaid(bookingRef, reason) {
    const ref = String(bookingRef || '').trim();
    const note = String(reason || '').trim();
    if (!ref) throw new Error('A booking reference is required.');
    if (note.length < 10) throw new Error('Enter a correction reason of at least 10 characters.');
    const { data, error } = await _sb.rpc('restore_forfeited_host_booking_as_fully_paid', {
      p_booking_ref: ref,
      p_reason: note,
    });
    if (error) {
      console.error('restoreForfeitedHostBookingAsFullyPaid:', error);
      throw error;
    }
    _pbClearFastCache(['bookings']);
    return data || {};
  },

  async addBookings(bookings) {
    const batch = Array.isArray(bookings) ? bookings.filter(Boolean) : [];
    if (batch.length < 1 || batch.length > 8) {
      throw new Error('Choose between one and eight booking items.');
    }
    batch.forEach(booking => _pbAssertPublicBookingDate(booking.date));
    const authenticated = await _pbHasActiveAccount();

    // Fast client feedback only. The database serializes and re-checks every
    // court/date conflict, including all rows in an atomic group.
    for (const booking of batch) {
      const existing = await this.getBookings({
        courtId: booking.courtId,
        date: booking.date,
        activeOnly: true,
      });
      if (hasSlotConflict(existing, booking)) {
        throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
      }
    }

    if (authenticated) {
      // One multi-row statement is atomic. A later court conflict can no longer
      // strand earlier "Reserving..." siblings from the same selection.
      const rows = batch.map(bookingToRow);
      let { error } = await _sb.from('bookings').insert(rows);
      if (error && isMissingOptionalBookingColumnError(error) && batch.every(booking => !booking.hostBooking)) {
        ({ error } = await _sb.from('bookings').insert(rows.map(withoutOptionalBookingColumns)));
      }
      if (error) {
        console.error('addBookings:', error);
        throw error;
      }
      _pbClearFastCache(['bookings']);
      return batch.map(booking => booking.ref);
    }

    const tokenKey = batch[0].groupRef || batch[0].ref;
    const accessExpiresAt = _pbBookingAccessExpiry(batch);
    const publicAccessToken = _pbBookingAccessToken(tokenKey, true, accessExpiresAt);
    batch.forEach(booking => _pbRememberBookingAccessToken(booking.ref, publicAccessToken, accessExpiresAt));

    try {
      const response = await _invokeEdgeFunction('submit-public-booking', {
        bookings: batch.map(bookingToRow),
        accessToken: publicAccessToken,
      }, { retryDirect: false });
      const refs = Array.isArray(response?.refs) ? response.refs.map(String) : [];
      if (refs.length !== batch.length) {
        throw new Error(response?.error || 'Booking holds were not created.');
      }
      _pbClearFastCache(['bookings']);
      return refs;
    } catch (error) {
      _pbForgetBookingAccessToken(tokenKey);
      batch.forEach(booking => _pbForgetBookingAccessToken(booking.ref));
      console.error('addBookings:', error);
      throw error;
    }
  },

  async addBooking(booking) {
    return this.addBookings([booking]);
  },

  async releaseBookingHold(ref) {
    const accessToken = _pbBookingAccessToken(ref, false);
    const authenticated = await _pbHasActiveAccount();
    if (!accessToken && !authenticated) {
      const denied = new Error(`Booking ${ref} cannot be released because its secure access token is missing.`);
      denied.code = 'BOOKING_ACCESS_TOKEN_MISSING';
      throw denied;
    }
    const { data, error } = await _sb.rpc('release_public_booking_hold', {
      p_ref: String(ref),
      p_access_token: accessToken || null,
    });
    if (error) { console.error('releaseBookingHold:', error); throw error; }
    if (accessToken) _pbForgetBookingAccessTokenFamily(accessToken);
    else _pbForgetBookingAccessToken(ref);
    _pbClearFastCache(['bookings']);
    return data || ref;
  },

  async getBookingByRef(ref) {
    const authenticated = await _pbHasActiveAccount();
    let data;
    let error;
    if (authenticated) {
      ({ data, error } = await _sb.from('bookings').select('*').eq('ref', ref).single());
    } else {
      const accessToken = _pbBookingAccessToken(ref, false);
      if (!accessToken) return null;
      ({ data, error } = await _sb.rpc('get_public_booking_by_ref', {
        p_ref: String(ref),
        p_access_token: accessToken,
      }));
      data = Array.isArray(data) ? data[0] || null : data;
    }
    if (error) { console.error('getBookingByRef:', error); return null; }
    if (!data) return null;
    return rowToBooking(data);
  },

  async getBookingManagementViewerContext() {
    try {
      const role = await _pbCurrentAccountRole();
      return {
        isAuthenticated: Boolean(role),
        isSystemOwner: role === 'owner',
      };
    } catch (error) {
      console.error('getBookingManagementViewerContext:', error);
      return { isAuthenticated: false, isSystemOwner: false };
    }
  },

  async getBookingForManagement(ref, email, options = {}) {
    const bookingRef = String(ref || '').trim().toUpperCase();
    const bookingEmail = String(email || '').trim().toLowerCase();

    if (options?.ownerPreview === true) {
      const accountRole = await _pbCurrentAccountRole().catch(() => '');
      if (accountRole !== 'owner') {
        const denied = new Error('An active System Owner account is required.');
        denied.code = 'OWNER_PREVIEW_UNAUTHORIZED';
        throw denied;
      }

      const { data, error } = await _sb.rpc('get_owner_booking_for_management', {
        p_ref: bookingRef,
        p_email: bookingEmail,
      });
      if (error) {
        console.error('getBookingForManagement owner preview:', error);
        throw error;
      }
      return (Array.isArray(data) ? data : data ? [data] : []).map(row => ({
        ...rowToBooking(row),
        managementAccess: 'owner_preview',
      }));
    }

    const tokenCandidates = [
      bookingRef,
      bookingRef.endsWith('-G') ? bookingRef.slice(0, -2) : `${bookingRef}-G`,
    ].filter(Boolean);
    const accessToken = tokenCandidates
      .map(candidate => _pbBookingAccessToken(candidate, false))
      .find(Boolean) || '';

    if (!accessToken) {
      const denied = new Error('Open Manage booking on the browser used to make this reservation.');
      denied.code = 'BOOKING_ACCESS_TOKEN_MISSING';
      throw denied;
    }

    const { data, error } = await _sb.rpc('get_public_booking_for_management', {
      p_ref: bookingRef,
      p_email: bookingEmail,
      p_access_token: accessToken,
    });
    if (error) {
      console.error('getBookingForManagement:', error);
      throw error;
    }
    return (Array.isArray(data) ? data : data ? [data] : []).map(rowToBooking);
  },

  async getBookingRescheduleState(ref, email) {
    const bookingRef = String(ref || '').trim().toUpperCase();
    const bookingEmail = String(email || '').trim().toLowerCase();
    const tokenCandidates = [
      bookingRef,
      bookingRef.endsWith('-G') ? bookingRef.slice(0, -2) : `${bookingRef}-G`,
    ].filter(Boolean);
    const accessToken = tokenCandidates
      .map(candidate => _pbBookingAccessToken(candidate, false))
      .find(Boolean) || '';
    if (!accessToken) {
      const denied = new Error('Open Manage booking on the browser used to make this reservation.');
      denied.code = 'BOOKING_ACCESS_TOKEN_MISSING';
      throw denied;
    }
    const { data, error } = await _sb.rpc('get_public_booking_reschedule_state', {
      p_ref: bookingRef,
      p_email: bookingEmail,
      p_access_token: accessToken,
    });
    if (error) {
      console.error('getBookingRescheduleState:', error);
      throw new Error(_extractFnError(error, 'Could not load the schedule request'));
    }
    if (data?.ok === false) throw _pbRpcResultError(data, 'Could not load the schedule request.');
    return data || { ok: true, request: null };
  },

  async getAdminRescheduleOptions(ref, date) {
    _pbAssertPublicBookingDate(date);
    const { data, error } = await _sb.rpc('get_admin_reschedule_options', {
      p_ref: String(ref || '').trim(), p_date: date,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load available time slots.'));
    if (!data || data.ok === false) throw _pbRpcResultError(data, 'Could not load available time slots.');
    return data;
  },

  async rescheduleBookingTransaction(ref, schedule) {
    _pbAssertPublicBookingDate(schedule?.date);
    const { data, error } = await _sb.rpc('reschedule_booking_transaction', {
      p_ref: String(ref || '').trim(), p_date: schedule.date,
      p_start_hour: schedule.startHour, p_expected_date: schedule.expectedDate,
      p_expected_slots: schedule.expectedSlots,
      p_expected_court_id: schedule.expectedCourtId,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not reschedule this booking.'));
    if (!data || data.ok === false) throw _pbRpcResultError(data, 'Could not reschedule this booking.');
    _pbClearFastCache(['bookings']);
    return data;
  },

  async rescheduleBookingsTransaction(ref, changes) {
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 8) {
      throw new Error('Choose between 1 and 8 booking items to reschedule.');
    }
    changes.forEach(change => _pbAssertPublicBookingDate(change?.date));
    const { data, error } = await _sb.rpc('reschedule_bookings_transaction', {
      p_ref: String(ref || '').trim(), p_changes: changes,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not reschedule the selected bookings.'));
    if (!data || data.ok === false) throw _pbRpcResultError(data, 'Could not reschedule the selected bookings.');
    _pbClearFastCache(['bookings']);
    return data;
  },

  async getBookingRescheduleOptions(ref, email, itemRefs, date) {
    const bookingRef = String(ref || '').trim().toUpperCase();
    const bookingEmail = String(email || '').trim().toLowerCase();
    const requestedDate = String(date || '').trim();
    _pbAssertPublicBookingDate(requestedDate);
    const tokenCandidates = [bookingRef, bookingRef.endsWith('-G') ? bookingRef.slice(0, -2) : `${bookingRef}-G`];
    const accessToken = tokenCandidates.map(candidate => _pbBookingAccessToken(candidate, false)).find(Boolean) || '';
    if (!accessToken) {
      const denied = new Error('Secure booking access is missing from this browser.');
      denied.code = 'BOOKING_ACCESS_TOKEN_MISSING';
      throw denied;
    }
    const selectedRefs = [...new Set((Array.isArray(itemRefs) ? itemRefs : []).map(value => String(value || '').trim()).filter(Boolean))];
    if (!selectedRefs.length || selectedRefs.length > 8) throw new Error('Choose at least one booking item to reschedule.');
    const { data, error } = await _sb.rpc('get_public_booking_reschedule_options', {
      p_ref: bookingRef,
      p_email: bookingEmail,
      p_access_token: accessToken,
      p_item_refs: selectedRefs,
      p_date: requestedDate,
    });
    if (error) {
      console.error('getBookingRescheduleOptions:', error);
      throw new Error(_extractFnError(error, 'Could not load available schedule options'));
    }
    if (data?.ok === false) throw _pbRpcResultError(data, 'Could not load available schedule options.');
    const allowed = new Set(selectedRefs);
    return {
      ...(data || {}),
      items: Array.isArray(data?.items) ? data.items.filter(item => allowed.has(String(item?.ref || ''))) : [],
    };
  },

  async submitBookingRescheduleRequest(payload = {}) {
    const bookingRef = String(payload.bookingRef || '').trim().toUpperCase();
    const bookingEmail = String(payload.email || '').trim().toLowerCase();
    const requestedDate = String(payload.requestedDate || '').trim();
    _pbAssertPublicBookingDate(requestedDate);
    const itemRefs = [...new Set((Array.isArray(payload.itemRefs) ? payload.itemRefs : []).map(value => String(value || '').trim()).filter(Boolean))];
    const requestedSlots = [...new Set((Array.isArray(payload.requestedSlots) ? payload.requestedSlots : []).map(value => String(value).trim()).filter(Boolean))];
    if (!itemRefs.length || itemRefs.length > 8) throw new Error('Choose between one and eight booking items.');
    if (!requestedSlots.length || requestedSlots.length > 12) throw new Error('Choose an available schedule.');
    if (payload.acknowledgedNoRefund !== true || payload.acknowledgedSlotNotHeld !== true) {
      throw new Error('Confirm both schedule request acknowledgements before continuing.');
    }
    const tokenCandidates = [bookingRef, bookingRef.endsWith('-G') ? bookingRef.slice(0, -2) : `${bookingRef}-G`];
    const accessToken = tokenCandidates.map(candidate => _pbBookingAccessToken(candidate, false)).find(Boolean) || '';
    if (!accessToken) {
      const denied = new Error('Secure booking access is missing from this browser.');
      denied.code = 'BOOKING_ACCESS_TOKEN_MISSING';
      throw denied;
    }
    const { data, error } = await _sb.rpc('submit_public_booking_reschedule_request', {
      p_ref: bookingRef,
      p_email: bookingEmail,
      p_access_token: accessToken,
      p_item_refs: itemRefs,
      p_requested_date: requestedDate,
      p_requested_slots: requestedSlots,
      p_note: String(payload.note || '').trim() || null,
      p_acknowledged_no_refund: true,
      p_acknowledged_slot_not_held: true,
    });
    if (error) {
      console.error('submitBookingRescheduleRequest:', error);
      throw new Error(_extractFnError(error, 'Could not submit the schedule request'));
    }
    if (data?.ok === false) throw _pbRpcResultError(data, 'Could not submit the schedule request.');
    const request = data?.request || data;
    if (!request?.id) throw new Error('The schedule request service returned an invalid result.');
    const notificationDelivery = await this.dispatchBookingRescheduleNotifications({
      requestId: request.id,
      bookingRef,
      email: bookingEmail,
      accessToken,
      allowFailure: true,
    }).catch(() => null);
    return data && typeof data === 'object' ? { ...data, notificationDelivery } : data;
  },

  async withdrawBookingRescheduleRequest(payload = {}) {
    const bookingRef = String(payload.bookingRef || '').trim().toUpperCase();
    const bookingEmail = String(payload.email || '').trim().toLowerCase();
    const requestId = String(payload.requestId || '').trim();
    const tokenCandidates = [bookingRef, bookingRef.endsWith('-G') ? bookingRef.slice(0, -2) : `${bookingRef}-G`];
    const accessToken = tokenCandidates.map(candidate => _pbBookingAccessToken(candidate, false)).find(Boolean) || '';
    if (!accessToken) {
      const denied = new Error('Secure booking access is missing from this browser.');
      denied.code = 'BOOKING_ACCESS_TOKEN_MISSING';
      throw denied;
    }
    const { data, error } = await _sb.rpc('withdraw_public_booking_reschedule_request', {
      p_ref: bookingRef,
      p_email: bookingEmail,
      p_access_token: accessToken,
      p_request_id: requestId,
    });
    if (error) {
      console.error('withdrawBookingRescheduleRequest:', error);
      throw new Error(_extractFnError(error, 'Could not withdraw the schedule request'));
    }
    if (data?.ok === false) throw _pbRpcResultError(data, 'Could not withdraw the schedule request.');
    const request = data?.request || data;
    const notificationDelivery = request?.id ? await this.dispatchBookingRescheduleNotifications({
      requestId: request.id,
      bookingRef,
      email: bookingEmail,
      accessToken,
      allowFailure: true,
    }).catch(() => null) : null;
    return data && typeof data === 'object' ? { ...data, notificationDelivery } : data;
  },

  async listBookingRescheduleRequests(status = null, limit = 100) {
    const normalizedStatus = String(status || '').trim().toLowerCase() || null;
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    const { data, error } = await _sb.rpc('list_booking_reschedule_requests', {
      p_status: normalizedStatus,
      p_limit: normalizedLimit,
    });
    if (error) {
      console.error('listBookingRescheduleRequests:', error);
      throw new Error(_extractFnError(error, 'Could not load schedule requests'));
    }
    if (data?.ok === false) throw _pbRpcResultError(data, 'Could not load schedule requests.');
    const result = data || { ok:true, counts:{}, requests:[] };
    const requests = Array.isArray(result.requests) ? result.requests : [];
    return {
      ...result,
      requests,
      pendingRequests:Array.isArray(result.pendingRequests)
        ? result.pendingRequests
        : requests.filter(item => String(item?.status || '').toLowerCase() === 'pending'),
      historyRequests:Array.isArray(result.historyRequests)
        ? result.historyRequests
        : requests.filter(item => String(item?.status || '').toLowerCase() !== 'pending'),
    };
  },

  async getBookingRescheduleRequest(requestId) {
    const { data, error } = await _sb.rpc('get_booking_reschedule_request', {
      p_request_id: String(requestId || '').trim(),
    });
    if (error) {
      console.error('getBookingRescheduleRequest:', error);
      throw new Error(_extractFnError(error, 'Could not load the schedule request'));
    }
    if (data?.ok === false) throw _pbRpcResultError(data, 'Could not load the schedule request.');
    return data;
  },

  async reviewBookingRescheduleRequest(requestId, decision, reason = '') {
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!['approved','rejected'].includes(normalizedDecision)) throw new Error('Choose approve or decline.');
    const note = String(reason || '').trim();
    if (normalizedDecision === 'rejected' && note.length < 5) throw new Error('Enter a clear reason before declining.');
    const { data, error } = await _sb.rpc('review_booking_reschedule_request', {
      p_request_id: String(requestId || '').trim(),
      p_decision: normalizedDecision === 'approved' ? 'approve' : 'reject',
      p_reason: note || null,
    });
    if (error) {
      console.error('reviewBookingRescheduleRequest:', error);
      throw new Error(_extractFnError(error, 'Could not save the schedule decision'));
    }
    if (data?.ok === false && String(data?.request?.status || '').toLowerCase() !== 'conflicted') {
      throw _pbRpcResultError(data, 'Could not save the schedule decision.');
    }
    _pbClearFastCache(['bookings']);
    return data;
  },

  async dispatchBookingRescheduleNotifications(payload = {}) {
    const allowFailure = payload.allowFailure === true;
    const body = {
      action: payload.action === 'retry' ? 'retry' : 'dispatch',
      ...(payload.requestId ? { requestId: String(payload.requestId) } : {}),
      ...(payload.bookingRef ? { bookingRef: String(payload.bookingRef).trim().toUpperCase() } : {}),
      ...(payload.email ? { email: String(payload.email).trim().toLowerCase() } : {}),
      ...(payload.accessToken ? { accessToken: String(payload.accessToken) } : {}),
      ...(payload.limit ? { limit: Number(payload.limit) } : {}),
    };
    return _invokeEdgeFunction('booking-reschedule-notifications', body, {
      allowFailure,
      retryDirect: false,
    });
  },

  async updateBooking(ref, updates) {
    if (updates.date !== undefined) _pbAssertPublicBookingDate(updates.date);
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
    const authenticated = await _pbHasActiveAccount();
    let data;
    let error;
    if (!authenticated) {
      const accessToken = _pbBookingAccessToken(ref, false);
      if (!accessToken) {
        const denied = new Error(`Booking ${ref} cannot be updated from this browser because its secure access token is missing.`);
        denied.code = 'BOOKING_ACCESS_TOKEN_MISSING';
        throw denied;
      }
      const allowedPublicFields = new Set([
        'full_name',
        'contact_number',
        'email',
        'payment_method',
        'payment_flow',
        'gcash_ref',
        'downpayment',
        'payment_status',
        'status',
      ]);
      const publicUpdates = Object.fromEntries(
        Object.entries(row).filter(([key]) => allowedPublicFields.has(key))
      );
      const rpcResult = await _sb.rpc('update_public_booking_hold', {
        p_ref: String(ref),
        p_access_token: accessToken,
        p_updates: publicUpdates,
      });
      data = rpcResult.data ? [{ ref: rpcResult.data }] : [];
      error = rpcResult.error;
    } else {
      ({ data, error } = await _sb.from('bookings').update(row).eq('ref', ref).select('ref'));
      if (error && isMissingOptionalBookingColumnError(error) && !updates.hostBooking && updates.createdVia !== 'host') {
        ({ data, error } = await _sb.from('bookings').update(withoutOptionalBookingColumns(row)).eq('ref', ref).select('ref'));
      }
    }
    if (error) { console.error('updateBooking:', error); throw error; }
    if (!Array.isArray(data) || data.length === 0) {
      const denied = new Error(`Booking ${ref} was not updated. It may have expired or this account does not have permission to change it.`);
      denied.code = 'BOOKING_UPDATE_NOT_ALLOWED';
      console.error('updateBooking:', denied);
      throw denied;
    }
    if (!authenticated && updates.status === 'cancelled') _pbForgetBookingAccessToken(ref);
    _pbClearFastCache(['bookings']);
  },

  async confirmBookingTransaction(ref) {
    const bookingRef = String(ref || '').trim();
    if (!bookingRef) throw new Error('A booking reference is required.');

    const { data, error } = await _sb.rpc('confirm_booking_transaction', {
      p_booking_ref: bookingRef,
    });
    if (error) {
      console.error('confirmBookingTransaction:', error);
      throw new Error(_extractFnError(error, 'Could not confirm this booking payment'));
    }

    const result = Array.isArray(data) ? data[0] || null : data;
    if (!result || typeof result.transitioned !== 'boolean') {
      throw new Error('The booking confirmation service returned an invalid result.');
    }

    const canonicalRef = String(result.booking_ref || bookingRef);
    const refs = Array.isArray(result.booking_refs) && result.booking_refs.length
      ? result.booking_refs.map(value => String(value))
      : [canonicalRef];

    // The transaction is already committed at this point.  A post-commit read
    // failure must not turn that success into a retryable confirmation error.
    _pbClearFastCache(['bookings']);
    let booking = null;
    try {
      booking = await this.getBookingByRef(canonicalRef);
    } catch (readError) {
      console.warn('confirmBookingTransaction refresh:', readError);
    }

    const status = String(result.booking_status || booking?.status || '').trim();
    const paymentStatus = String(
      result.booking_payment_status || booking?.paymentStatus || '',
    ).trim();
    return {
      transitioned: result.transitioned,
      booking: booking || undefined,
      paymentStatus: paymentStatus || undefined,
      status: status || undefined,
      refs,
    };
  },

  async transferCancelledBookingPayment(sourceRef, targetRef, reason, noRefundConfirmed, idempotencyKey) {
    const sourceBookingRef = String(sourceRef || '').trim();
    const targetBookingRef = String(targetRef || '').trim();
    const transferReason = String(reason || '').trim();
    const requestKey = String(idempotencyKey || '').trim();
    if (!sourceBookingRef || !targetBookingRef || sourceBookingRef === targetBookingRef) {
      throw new Error('Choose two different source and destination bookings.');
    }
    if (transferReason.length < 10 || transferReason.length > 1000) {
      throw new Error('Enter a transfer reason between 10 and 1000 characters.');
    }
    if (noRefundConfirmed !== true) {
      throw new Error('Confirm that no refund or chargeback was issued for the cancelled booking.');
    }
    if (!requestKey) throw new Error('A payment-transfer idempotency key is required.');

    const { data, error } = await _sb.rpc('transfer_cancelled_booking_payment', {
      p_source_booking_ref: sourceBookingRef,
      p_target_booking_ref: targetBookingRef,
      p_reason: transferReason,
      p_no_refund_confirmed: true,
      p_idempotency_key: requestKey,
    });
    if (error) {
      console.error('transferCancelledBookingPayment:', error);
      throw new Error(_extractFnError(error, 'Could not move this payment to the new booking'));
    }

    const result = Array.isArray(data) ? data[0] || null : data;
    if (!result || typeof result.transitioned !== 'boolean' || !result.transfer_id) {
      throw new Error('The payment transfer service returned an invalid result.');
    }
    _pbClearFastCache(['bookings']);
    return {
      transitioned: result.transitioned,
      transferId: String(result.transfer_id),
      sourceBookingRef: String(result.source_booking_ref || sourceBookingRef),
      targetBookingRef: String(result.target_booking_ref || targetBookingRef),
      targetBookingStatus: String(result.target_booking_status || ''),
      targetPaymentStatus: String(result.target_payment_status || ''),
      sourceBookingRefs: Array.isArray(result.source_booking_refs)
        ? result.source_booking_refs.map(value => String(value))
        : [sourceBookingRef],
      targetBookingRefs: Array.isArray(result.target_booking_refs)
        ? result.target_booking_refs.map(value => String(value))
        : [targetBookingRef],
    };
  },

  async rejectBookingPaymentTransaction(ref, reason) {
    const bookingRef = String(ref || '').trim();
    const reviewReason = String(reason || '').trim();
    if (!bookingRef) throw new Error('A booking reference is required.');
    if (reviewReason.length < 3) throw new Error('A Not Received reason of at least 3 characters is required.');

    const { data, error } = await _sb.rpc('reject_booking_payment_transaction', {
      p_booking_ref: bookingRef,
      p_reason: reviewReason,
    });
    if (error) {
      console.error('rejectBookingPaymentTransaction:', error);
      throw new Error(_extractFnError(error, 'Could not mark this booking payment as not received'));
    }

    const result = Array.isArray(data) ? data[0] || null : data;
    if (!result || typeof result.transitioned !== 'boolean') {
      throw new Error('The booking payment review service returned an invalid result.');
    }
    const canonicalRef = String(result.booking_ref || bookingRef);
    const refs = Array.isArray(result.booking_refs) && result.booking_refs.length
      ? result.booking_refs.map(value => String(value))
      : [canonicalRef];
    _pbClearFastCache(['bookings']);
    return {
      transitioned: result.transitioned,
      status: String(result.booking_status || 'cancelled'),
      paymentStatus: String(result.booking_payment_status || 'rejected'),
      refs,
    };
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
    if (!(await _pbHasActiveAccount())) {
      await this.updateBooking(ref, { status: 'cancelled', paymentStatus: 'rejected' });
      return;
    }
    const { error } = await _sb.from('bookings').delete().eq('ref', ref);
    if (error) { console.error('deleteBooking:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async voidDeleteBookingGroup(ref, reason) {
    const { data, error } = await _sb.rpc('void_delete_booking_group', {
      p_booking_ref: ref,
      p_reason: reason,
    });
    if (error) { console.error('voidDeleteBookingGroup:', error); throw error; }
    _pbClearFastCache(['bookings']);
    return data || null;
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

  // ---- OPEN PLAY REGISTRATIONS ----
  async getOpenPlayRegistrations() {
    return _pbCached('openPlayRegistrations', {}, PB_FAST_CACHE_MS.openPlay, async () => {
      if (!(await _pbHasActiveAccount())) return [];
      const { data, error } = await _sb.from('open_play_registrations').select('*').order('created_at', { ascending: false });
      if (error) { console.error('getOpenPlayRegistrations:', error); return []; }
      return data;
    });
  },

  async addOpenPlayRegistration(reg) {
    _pbAssertPublicBookingDate(reg.date);
    const paymentMethod = String(reg.paymentMethod || 'cash').toLowerCase();
    try {
      const response = await _invokeEdgeFunction('submit-public-registration', {
        action: 'open_play',
        fullName: reg.fullName,
        courtId: String(reg.courtId),
        date: reg.date,
        hour: reg.hour,
        paymentType: reg.paymentType,
        paymentMethod,
        gcashRef: reg.gcashRef || null,
        receiptImageUrl: reg.receiptImageUrl || null,
        receiptStatus: reg.receiptStatus || 'none',
        receiptVerificationId: Number(reg.receiptVerificationId) || null,
      }, { retryDirect: false });
      const saved = response?.registration;
      if (!saved?.id) throw new Error(response?.error || 'Open Play registration was not saved.');
      _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
      return {
        id: saved.id,
        courtId: saved.court_id,
        courtName: saved.court_name,
        date: saved.date,
        hour: Number(saved.hour),
        timeLabel: saved.time_label,
        paymentType: saved.payment_type,
        paymentMethod: saved.payment_method,
        paymentStatus: saved.payment_status || 'pending',
        amount: Number(saved.amount || 0),
        receiptStatus: saved.receipt_status || 'none',
        receiptVerificationId: Number(saved.receipt_verification_id) || null,
        createdAt: saved.created_at,
      };
    } catch (error) {
      console.error('addOpenPlayRegistration:', error);
      throw error;
    }
  },

  async updateOpenPlayRegistration(id, updates) {
    const row = {};
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.gcashRef      !== undefined) row.gcash_ref      = updates.gcashRef;
    if (updates.receiptImageUrl !== undefined) row.receipt_image_url = updates.receiptImageUrl;
    if (updates.receiptImageHash !== undefined) row.receipt_image_hash = updates.receiptImageHash;
    if (updates.receiptPhash !== undefined) row.receipt_phash = updates.receiptPhash;
    if (updates.receiptStatus !== undefined) row.receipt_status = updates.receiptStatus;
    if (updates.receiptFlags !== undefined) row.receipt_flags = updates.receiptFlags;
    if (updates.receiptExtracted !== undefined) row.receipt_extracted = updates.receiptExtracted;
    if (updates.receiptConfidence !== undefined) row.receipt_confidence = updates.receiptConfidence;
    if (updates.receiptVerifiedAt !== undefined) row.receipt_verified_at = updates.receiptVerifiedAt;
    const { error } = await _sb.from('open_play_registrations').update(row).eq('id', id);
    if (error) { console.error('updateOpenPlayRegistration:', error); throw error; }
    _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  },

  async getOpenPlayCountForDate(date, courtId = null) {
    return _pbCached('openPlayCount', { date, courtId: courtId || '' }, PB_FAST_CACHE_MS.openPlay, async () => {
      const { data, error } = await _sb.rpc('get_public_open_play_counts', {
        p_date: date,
        p_court_id: courtId ? String(courtId) : null,
      });
      if (error) { console.error('getOpenPlayCountForDate:', error); return 0; }
      return (data || []).reduce((sum, row) => sum + Number(row.registration_count || 0), 0);
    });
  },

  async getOpenPlayCountsForDate(date) {
    return _pbCached('openPlayCounts', { date }, PB_FAST_CACHE_MS.openPlay, async () => {
      const { data, error } = await _sb.rpc('get_public_open_play_counts', {
        p_date: date,
        p_court_id: null,
      });
      if (error) { console.error('getOpenPlayCountsForDate:', error); return {}; }
      return (data || []).reduce((counts, row) => {
        const key = String(row.court_id || '');
        counts[key] = Number(row.registration_count || 0);
        return counts;
      }, {});
    });
  },

  async deleteOpenPlayRegistration(id) {
    const { error } = await _sb.from('open_play_registrations').delete().eq('id', id);
    if (error) console.error('deleteOpenPlayRegistration:', error);
    _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  },

  // ---- OPEN PLAY HOSTS ----
  async getOpenPlayHostApplications() {
    const { data, error } = await _sb.from('open_play_host_applications').select('*').order('created_at', { ascending: false });
    if (error) { console.error('getOpenPlayHostApplications:', error); return []; }
    return (data || []).map(rowToOpenPlayHostApplication);
  },

  async addOpenPlayHostApplication(app) {
    return this.submitOpenPlayHostSignup(app);
  },

  async submitOpenPlayHostSignup(app) {
    const data = await _invokeEdgeFunction('host-application', {
      action: 'signup',
      fullName: app.fullName,
      contactNumber: app.contactNumber,
      email: app.email,
      password: app.password,
      gcashNumber: app.gcashNumber,
      validIdBase64: app.validIdBase64,
      validIdFileName: app.validIdFileName,
      validIdFileType: app.validIdFileType,
      validIdFileSize: app.validIdFileSize,
      preferredSchedule: app.preferredSchedule || '',
      notes: app.notes || '',
    }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    return data;
  },

  async resendOpenPlayHostVerification(email) {
    const data = await _invokeEdgeFunction('host-application', {
      action: 'resend-verification',
      email,
    }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    return data;
  },

  async confirmOpenPlayHostVerification() {
    const data = await _invokeEdgeFunction('host-application', {
      action: 'confirm-verification',
    }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    if (!data?.ok || !data?.reviewable) throw new Error('Host verification was not recorded.');
    return data;
  },

  async dispatchOpenPlayHostReviewNotifications() {
    const data = await _invokeEdgeFunction('host-application', {
      action: 'dispatch-review-notifications',
    }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    return data;
  },

  async sendOpenPlayHostTelegramTest() {
    const data = await _invokeEdgeFunction('host-application', {
      action: 'test-review-notification',
    }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    return data;
  },

  async getOpenPlayHostIdSignedUrl(applicationId) {
    const data = await _invokeEdgeFunction('host-application', { action: 'sign-valid-id', applicationId }, { preferDirect: true });
    if (!data?.url) throw new Error(data?.error || 'No valid ID available.');
    return data.url;
  },

  async updateOpenPlayHostApplication(id, updates) {
    const row = {};
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.reviewNote !== undefined) row.review_note = updates.reviewNote;
    if (updates.reviewedBy !== undefined) row.reviewed_by = updates.reviewedBy;
    if (updates.reviewedAt !== undefined) row.reviewed_at = updates.reviewedAt;
    const { data, error } = await _sb.from('open_play_host_applications').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayHostApplication:', error); throw error; }
    return data ? rowToOpenPlayHostApplication(data) : null;
  },

  async reviewOpenPlayHostApplication(id, status, reviewNote = '') {
    const data = await _invokeEdgeFunction('host-application', { action: 'review', applicationId: id, status, reviewNote }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    if (!data?.ok) throw new Error('Host review did not return a successful activation result.');
    return data;
  },

  async repairOpenPlayHostActivation(id) {
    const data = await _invokeEdgeFunction('host-application', {
      action: 'repair-activation',
      applicationId: id,
    }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    if (!data?.ok) throw new Error('Host login repair did not complete successfully.');
    return data;
  },

  async getOpenPlayHostSessions(options = {}) {
    const opts = options || {};
    const accountRole = opts.publicOnly ? '' : await _pbCurrentAccountRole();
    const canReadPrivateRows = !opts.publicOnly && ['owner', 'court_owner', 'host'].includes(accountRole);
    if (opts.publicOnly || !canReadPrivateRows) {
      const { data, error } = await _sb.rpc('get_public_open_play_host_sessions', {
        p_session_id: opts.id || null,
      });
      if (error) { console.error('getOpenPlayHostSessions:', error); return []; }
      return (data || []).map(rowToOpenPlayHostSession);
    }

    const { data, error } = await _sb.from('open_play_host_sessions').select('*').order('date', { ascending: true }).order('start_hour', { ascending: true });
    if (error) { console.error('getOpenPlayHostSessions:', error); return []; }
    return (data || []).map(rowToOpenPlayHostSession);
  },

  async createOpenPlayHostSession(session) {
    _pbAssertPublicBookingDate(session.date);
    const { data, error } = await _sb.from('open_play_host_sessions').insert(hostSessionToRow(session)).select('*').single();
    if (error) { console.error('createOpenPlayHostSession:', error); throw error; }
    return rowToOpenPlayHostSession(data);
  },

  async updateOpenPlayHostSession(id, updates) {
    if (updates.date !== undefined) _pbAssertPublicBookingDate(updates.date);
    const row = {};
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.title !== undefined) row.title = updates.title;
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.startHour !== undefined) row.start_hour = updates.startHour;
    if (updates.endHour !== undefined) row.end_hour = updates.endHour;
    if (updates.courtIds !== undefined) row.court_ids = updates.courtIds;
    if (updates.courtNames !== undefined) row.court_names = updates.courtNames;
    if (updates.maxPlayers !== undefined) row.max_players = updates.maxPlayers;
    if (updates.feePerPlayer !== undefined) row.fee_per_player = updates.feePerPlayer;
    if (updates.notes !== undefined) row.notes = updates.notes;
    if (updates.paymentInstructions !== undefined) row.payment_instructions = updates.paymentInstructions;
    const { data, error } = await _sb.from('open_play_host_sessions').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayHostSession:', error); throw error; }
    return data ? rowToOpenPlayHostSession(data) : null;
  },

  async getOpenPlayHostSessionRegistrations(sessionId = null) {
    let query = _sb.from('open_play_host_session_registrations').select('*').order('created_at', { ascending: false });
    if (sessionId) query = query.eq('session_id', sessionId);
    const { data, error } = await query;
    if (error) { console.error('getOpenPlayHostSessionRegistrations:', error); return []; }
    return (data || []).map(rowToOpenPlayHostSessionRegistration);
  },

  async getOpenPlayHostSessionRegistrationCount(sessionId) {
    const { data, error } = await _sb.rpc('count_open_play_host_session_registrations', { p_session_id: sessionId });
    if (error) { console.error('getOpenPlayHostSessionRegistrationCount:', error); return 0; }
    return Number(data || 0);
  },

  async addOpenPlayHostSessionRegistration(reg) {
    const paymentMethod = String(reg.paymentMethod || 'cash').toLowerCase();
    try {
      const response = await _invokeEdgeFunction('submit-public-registration', {
        action: 'host_session',
        sessionId: reg.sessionId,
        fullName: reg.fullName,
        contactNumber: reg.contactNumber || null,
        paymentMethod,
        gcashRef: reg.gcashRef || null,
        receiptImageUrl: reg.receiptImageUrl || null,
        receiptStatus: reg.receiptStatus || 'none',
        receiptVerificationId: Number(reg.receiptVerificationId) || null,
      }, { retryDirect: false });
      const saved = response?.registration;
      if (!saved?.id) throw new Error(response?.error || 'Host-session registration was not saved.');
      return rowToOpenPlayHostSessionRegistration({
        ...saved,
        updated_at: saved.created_at,
      });
    } catch (error) {
      console.error('addOpenPlayHostSessionRegistration:', error);
      throw error;
    }
  },

  async updateOpenPlayHostSessionRegistration(id, updates) {
    const row = {};
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.gcashRef !== undefined) row.gcash_ref = updates.gcashRef;
    if (updates.receiptStatus !== undefined) row.receipt_status = updates.receiptStatus;
    if (updates.receiptFlags !== undefined) row.receipt_flags = updates.receiptFlags;
    if (updates.receiptExtracted !== undefined) row.receipt_extracted = updates.receiptExtracted;
    if (updates.receiptConfidence !== undefined) row.receipt_confidence = updates.receiptConfidence;
    if (updates.receiptVerifiedAt !== undefined) row.receipt_verified_at = updates.receiptVerifiedAt;
    const { data, error } = await _sb.from('open_play_host_session_registrations')
      .update(row)
      .eq('id', id)
      .select('*')
      .single();
    if (error) {
      console.error('updateOpenPlayHostSessionRegistration:', error);
      throw error;
    }
    return rowToOpenPlayHostSessionRegistration(data);
  },

  // ---- OPEN PLAY GAME MANAGER ----
  async getOpenPlayGameSessions() {
    const { data, error } = await _sb.from('open_play_game_sessions').select('*').order('date', { ascending: false }).order('created_at', { ascending: false });
    if (error) { console.error('getOpenPlayGameSessions:', error); return []; }
    return data || [];
  },

  async setOpenPlayGamePublicShare(sessionId, enabled) {
    const { data, error } = await _sb.rpc('set_open_play_game_public_share', {
      p_session_id: sessionId,
      p_enabled: Boolean(enabled),
    });
    if (error) {
      console.error('setOpenPlayGamePublicShare:', error);
      throw error;
    }
    return data || null;
  },

  async rotateOpenPlayGamePublicShare(sessionId) {
    const { data, error } = await _sb.rpc('rotate_open_play_game_public_share', {
      p_session_id: sessionId,
    });
    if (error) {
      console.error('rotateOpenPlayGamePublicShare:', error);
      throw error;
    }
    return data || null;
  },

  async getPublicOpenPlayGameLiveBoard(shareToken) {
    const token = String(shareToken || '').trim();
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const { data, error } = await _sb.rpc('get_public_open_play_game_live_board', {
      p_share_token: token,
    });
    if (error) {
      console.error('getPublicOpenPlayGameLiveBoard:', error);
      throw error;
    }
    return data || null;
  },

  async createOpenPlayGameSession(session) {
    const row = {
      date: session.date,
      time_label: session.timeLabel || null,
      court_ids: session.courtIds || [],
      court_names: session.courtNames || [],
      mode: session.mode || 'smart_random_mixer',
      ranking_mode: normalizeOpenPlayRankingMode(
        session.rankingMode ?? session.ranking_mode ?? 'competitive'
      ),
      status: session.status || 'draft',
      current_round: session.currentRound || 0,
      performance_rating_version: 'pr-performance-v1',
      performance_rating_k: 24,
      performance_rating_scale: 400,
      performance_rating_min_games: 3,
    };
    const { data, error } = await _sb.from('open_play_game_sessions').insert(row).select('*').single();
    if (error) { console.error('createOpenPlayGameSession:', error); throw error; }
    return data;
  },

  async updateOpenPlayGameSession(id, updates) {
    const row = {};
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.timeLabel !== undefined) row.time_label = updates.timeLabel;
    if (updates.courtIds !== undefined) row.court_ids = updates.courtIds;
    if (updates.courtNames !== undefined) row.court_names = updates.courtNames;
    if (updates.mode !== undefined) row.mode = updates.mode;
    if (updates.rankingMode !== undefined || updates.ranking_mode !== undefined) {
      row.ranking_mode = normalizeOpenPlayRankingMode(
        updates.rankingMode ?? updates.ranking_mode
      );
    }
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.currentRound !== undefined) row.current_round = updates.currentRound;
    const { data, error } = await _sb.from('open_play_game_sessions').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayGameSession:', error); throw error; }
    return data;
  },

  async getOpenPlayGamePlayers(sessionId) {
    const { data, error } = await _sb.from('open_play_game_players').select('*').eq('session_id', sessionId).order('seed_order');
    if (error) { console.error('getOpenPlayGamePlayers:', error); return []; }
    return data || [];
  },

  async addOpenPlayGamePlayer(sessionId, player) {
    const skillLevel = normalizeOpenPlaySkillLevel(player.skillLevel ?? player.skill_level);
    const row = {
      session_id: sessionId,
      full_name: player.fullName || player.full_name,
      source_registration_id: player.sourceRegistrationId || player.source_registration_id || null,
      status: player.status || 'active',
      seed_order: Number(player.seedOrder ?? player.seed_order ?? 0),
      skill_level: skillLevel,
      performance_seed_rating: openPlayPerformanceSeed(skillLevel),
    };
    const { data, error } = await _sb.from('open_play_game_players').insert(row).select('*').single();
    if (error) { console.error('addOpenPlayGamePlayer:', error); throw error; }
    return data;
  },

  async updateOpenPlayGamePlayer(id, updates) {
    const row = {};
    if (updates.fullName !== undefined || updates.full_name !== undefined) {
      row.full_name = String(updates.fullName ?? updates.full_name).trim();
    }
    if (updates.skillLevel !== undefined || updates.skill_level !== undefined) {
      row.skill_level = normalizeOpenPlaySkillLevel(updates.skillLevel ?? updates.skill_level);
    }
    const { data, error } = await _sb
      .from('open_play_game_players')
      .update(row)
      .eq('id', id)
      .select('*')
      .single();
    if (error) { console.error('updateOpenPlayGamePlayer:', error); throw error; }
    return data;
  },

  async replaceOpenPlayGamePlayers(sessionId, players) {
    const { error: delError } = await _sb.from('open_play_game_players').delete().eq('session_id', sessionId);
    if (delError) { console.error('replaceOpenPlayGamePlayers delete:', delError); throw delError; }
    if (!players.length) return [];
    const rows = players.map((p, i) => {
      const skillLevel = normalizeOpenPlaySkillLevel(p.skillLevel ?? p.skill_level);
      return {
        session_id: sessionId,
        full_name: p.fullName || p.full_name,
        source_registration_id: p.sourceRegistrationId || p.source_registration_id || null,
        status: p.status || 'active',
        seed_order: i,
        skill_level: skillLevel,
        performance_seed_rating: openPlayPerformanceSeed(skillLevel),
      };
    });
    const { data, error } = await _sb.from('open_play_game_players').insert(rows).select('*').order('seed_order');
    if (error) { console.error('replaceOpenPlayGamePlayers insert:', error); throw error; }
    return data || [];
  },

  async syncOpenPlayGameQueueWaitTimes(sessionId, queuePlayerIds) {
    const { data, error } = await _sb.rpc('sync_open_play_game_queue_wait_times', {
      p_session_id: sessionId,
      p_queue_player_ids: (queuePlayerIds || []).map(String),
    });
    if (error) { console.error('syncOpenPlayGameQueueWaitTimes:', error); throw error; }
    return data || [];
  },

  async getOpenPlayGameRounds(sessionId) {
    const { data, error } = await _sb.from('open_play_game_rounds').select('*').eq('session_id', sessionId).order('round_no');
    if (error) { console.error('getOpenPlayGameRounds:', error); return []; }
    return data || [];
  },

  async addOpenPlayGameRound(round) {
    const row = {
      session_id: round.sessionId,
      round_no: round.roundNo,
      assignments: round.assignments || [],
      queue_snapshot: round.queueSnapshot || [],
      partner_history: round.partnerHistory || {},
      opponent_history: round.opponentHistory || {},
      completed_at: round.completedAt || null,
    };
    const { data, error } = await _sb.from('open_play_game_rounds').insert(row).select('*').single();
    if (error) { console.error('addOpenPlayGameRound:', error); throw error; }
    return data;
  },

  async updateOpenPlayGameRound(id, updates) {
    const row = {};
    if (updates.assignments !== undefined) row.assignments = updates.assignments;
    if (updates.queueSnapshot !== undefined) row.queue_snapshot = updates.queueSnapshot;
    if (updates.partnerHistory !== undefined) row.partner_history = updates.partnerHistory;
    if (updates.opponentHistory !== undefined) row.opponent_history = updates.opponentHistory;
    if (updates.completedAt !== undefined) row.completed_at = updates.completedAt;
    const { data, error } = await _sb.from('open_play_game_rounds').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayGameRound:', error); throw error; }
    return data;
  },

  async updateOpenPlayGameRoundIfCurrent(id, expected, updates) {
    const { data, error } = await _sb.rpc('update_open_play_game_round_if_current', {
      p_round_id: id,
      p_expected_assignments: expected.assignments || [],
      p_expected_queue_snapshot: expected.queueSnapshot ?? expected.queue_snapshot ?? [],
      p_assignments: updates.assignments || [],
      p_queue_snapshot: updates.queueSnapshot ?? updates.queue_snapshot ?? [],
    });
    if (error) { console.error('updateOpenPlayGameRoundIfCurrent:', error); throw error; }
    return data;
  },

  async replaceOpenPlayGameCourtPlayer(id, expected, replacement) {
    const { data, error } = await _sb.rpc('replace_open_play_game_court_player', {
      p_round_id: id,
      p_expected_assignments: expected.assignments || [],
      p_expected_queue_snapshot: expected.queueSnapshot ?? expected.queue_snapshot ?? [],
      p_court_index: Number(replacement.courtIndex),
      p_team: replacement.team,
      p_slot_index: Number(replacement.slotIndex),
      p_outgoing_player_id: replacement.outgoingPlayerId,
      p_incoming_player_id: replacement.incomingPlayerId || null,
      p_incoming_player_name: replacement.incomingPlayerName || null,
      p_mark_outgoing_removed: replacement.markOutgoingRemoved === true,
    });
    if (error) { console.error('replaceOpenPlayGameCourtPlayer:', error); throw error; }
    return data;
  },

  async correctOpenPlayGameMatchWinner(id, expected, correction) {
    const { data, error } = await _sb.rpc('correct_open_play_game_match_winner', {
      p_round_id: id,
      p_expected_assignments: expected.assignments || [],
      p_court_index: Number(correction.courtIndex),
      p_completed_game_index: correction.completedGameIndex ?? null,
      p_expected_winner: correction.expectedWinner,
      p_new_winner: correction.newWinner,
    });
    if (error) { console.error('correctOpenPlayGameMatchWinner:', error); throw error; }
    return data;
  },

  async deleteLatestOpenPlayGameRound(sessionId) {
    const { data, error } = await _sb.rpc('delete_latest_open_play_game_round_guarded', {
      p_session_id: sessionId,
    });
    if (error) { console.error('deleteLatestOpenPlayGameRound:', error); throw error; }
    return data || null;
  },

  async clearOpenPlayGameRounds(sessionId) {
    const { error } = await _sb.rpc('clear_open_play_game_rounds_guarded', {
      p_session_id: sessionId,
    });
    if (error) { console.error('clearOpenPlayGameRounds:', error); throw error; }
  },

  // ---- BLOCKED DATES ----
  async getBlockedDates() {
    return _pbCached('blockedDates', {}, PB_FAST_CACHE_MS.blockedDates, async () => {
      const { data, error } = await _sb.from('blocked_dates').select('date').order('date');
      if (error) { console.error('getBlockedDates:', error); return []; }
      return data.map(r => r.date);
    });
  },

  async addBlockedDate(date) {
    const { error } = await _sb.from('blocked_dates').insert({ date, created_at: new Date().toISOString() });
    if (error) console.error('addBlockedDate:', error);
    _pbClearFastCache(['blockedDates']);
  },

  async removeBlockedDate(date) {
    const { error } = await _sb.from('blocked_dates').delete().eq('date', date);
    if (error) console.error('removeBlockedDate:', error);
    _pbClearFastCache(['blockedDates']);
  },

  // ---- ACCOUNTS ----
  async getAccounts() {
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
    return _pbCached('settings', {}, PB_FAST_CACHE_MS.settings, async () => {
      const { data, error } = await _sb.from('settings').select('*');
      if (error) { console.error('getSettings:', error); return {}; }
      const out = {};
      data.forEach(r => out[r.key] = r.value);
      return out;
    });
  },

  async saveSetting(key, value) {
    const { error } = await _sb.from('settings').upsert({ key, value });
    if (error) { console.error('saveSetting:', error); throw error; }
    _pbClearFastCache(['settings']);
  },

  clearCache(scopes = []) {
    _pbClearFastCache(scopes);
  },

  async createPaymentSession(payload) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Supabase configuration missing (SUPABASE_URL / SUPABASE_ANON_KEY).');
    }
    const bookingRef = String(payload?.bookingRef || '');
    const bookingAccessToken = _pbBookingAccessToken(bookingRef, false);
    const securedPayload = {
      ...(payload || {}),
      ...(bookingAccessToken ? { bookingAccessToken } : {}),
    };
    const { data, error } = await _sb.functions.invoke('create-payment-session', { body: securedPayload });
    if (!error && data) return data;

    // Fallback path: direct HTTP call to the function endpoint. This helps diagnose
    // invoke-wrapper issues and still allows checkout if endpoint is reachable.
    try {
      return await _invokePaymentSessionFallback(securedPayload);
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
    return _invokeEdgeFunction('send-confirmation-email', _bookingEmailPayload(booking), {
      allowFailure: !!options.allowFailure,
      retryDirect: false,
    });
  },

  async sendRescheduleEmail(payload, options = {}) {
    if (!payload?.email) return { ok: false, skipped: true, reason: 'No customer email' };
    return _invokeEdgeFunction('send-reschedule-email', payload, {
      allowFailure: !!options.allowFailure,
      retryDirect: false,
    });
  },

  async sendGroupedRescheduleEmail(payload, options = {}) {
    return _invokeEdgeFunction('send-reschedule-email', payload, {
      allowFailure: !!options.allowFailure,
      retryDirect: false,
    });
  },

  async sendTelegramNotification(payload, options = {}) {
    return _invokeEdgeFunction('send-telegram-notification', payload, {
      allowFailure: options.allowFailure !== false,
      retryDirect: false,
    });
  },

  async notifyBookingSubmitted(booking) {
    if (window.PB_USE_LOCAL_DATA) return { ok: true, skipped: true, reason: 'Local data mode' };
    if (!(await _pbHasActiveAccount())) {
      return { ok: true, skipped: true, reason: 'Protected booking service sends the canonical alert' };
    }
    return this.sendTelegramNotification({
      bookingRef: booking?.ref,
      event: 'new_booking',
    }, { allowFailure: true });
  },

  async sendBookingStatusEmail(bookingRef, event, reason = '', options = {}) {
    if (!bookingRef) return { ok: false, skipped: true, reason: 'No booking reference' };
    return _invokeEdgeFunction('send-booking-status-email', {
      bookingRef,
      event,
      reason,
    }, {
      allowFailure: !!options.allowFailure,
      retryDirect: false,
    });
  },

  async notifyBookingUpdate(booking, event, note = '') {
    if (window.PB_USE_LOCAL_DATA) return { ok: true, skipped: true, reason: 'Local data mode' };
    if (!(await _pbHasActiveAccount())) {
      return { ok: true, skipped: true, reason: 'Receipt and booking services send canonical alerts' };
    }
    return this.sendTelegramNotification({
      bookingRef: booking?.ref,
      event,
    }, { allowFailure: true });
  },

  async getIntegrationStatus() {
    return _invokeEdgeFunction('integration-status', { action: 'status' }, { allowFailure: true });
  },

  // Upload a court-booking receipt to its private, token-authorized checkpoint.
  // OCR and booking settlement happen only after the customer continues.
  async stageBookingReceipt(payload) {
    const bookingRef = String(payload?.bookingRef || '').trim();
    if (!bookingRef) throw new Error('Booking reference is required before receipt upload.');
    if (!payload?.imageFile) throw new Error('Receipt screenshot is required.');

    const storedBookingToken = _pbBookingAccessToken(bookingRef, false);
    const requestPayload = {
      ...(payload || {}),
      action: 'stage',
      ...(storedBookingToken ? { bookingAccessToken: storedBookingToken } : {}),
    };
    const sessionResult = await _sb.auth.getSession();
    const userAccessToken = sessionResult?.data?.session?.access_token || '';
    const authHeader = `Bearer ${userAccessToken || SUPABASE_ANON_KEY}`;
    const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
    const imageFile = await _pbPrepareReceiptImage(requestPayload.imageFile);
    const finishStage = result => {
      if (!result?.stagedReceiptPath) {
        throw new Error('Receipt upload returned without a secure storage checkpoint.');
      }
      _pbClearFastCache(['bookings']);
      return result;
    };
    let form;
    try {
      form = new FormData();
      form.append('action', 'stage');
      form.append('bookingRef', bookingRef);
      form.append('provider', String(requestPayload.provider || 'gcash'));
      form.append('contentType', imageFile.type || requestPayload.contentType || 'image/jpeg');
      if (requestPayload.bookingAccessToken) form.append('bookingAccessToken', requestPayload.bookingAccessToken);
      form.append('receipt', imageFile, imageFile.name || 'receipt.jpg');
    } catch (_) {
      return finishStage(await _pbVerifyReceiptBase64Fallback(fnUrl, requestPayload, imageFile, authHeader));
    }

    const transportStartedAt = Date.now();
    let res;
    try {
      res = await _pbFetchWithTimeout(fnUrl, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': authHeader,
        },
        body: form,
      }, PB_RECEIPT_TIMEOUT_MS);
    } catch (transportError) {
      if (_pbCanFallbackReceiptTransport(transportError, transportStartedAt)) {
        return finishStage(await _pbVerifyReceiptBase64Fallback(fnUrl, requestPayload, imageFile, authHeader));
      }
      throw transportError;
    }
    const txt = await res.text();
    const json = _safeJsonParse(txt);
    if (!res.ok) {
      const reason = String(json?.error || txt || `HTTP ${res.status}`);
      const missingMultipartImage = [400, 415, 422].includes(res.status) &&
        /receipt file|multipart body|empty image/i.test(reason);
      if (missingMultipartImage) {
        return finishStage(await _pbVerifyReceiptBase64Fallback(fnUrl, requestPayload, imageFile, authHeader));
      }
      throw _pbApiError(reason, String(json?.code || `HTTP_${res.status}`));
    }
    return finishStage(json);
  },

  async recoverBookingReceipt(bookingRef) {
    const normalizedRef = String(bookingRef || '').trim();
    const result = await _pbReceiptCheckpointRequest('recover-stage', {
      bookingRef: normalizedRef,
    });
    const stagedReceiptPath = String(
      result?.stagedReceiptPath || result?.receiptImageUrl || '',
    ).trim();
    if (!stagedReceiptPath) return null;
    return {
      ...result,
      ok: result.ok !== false,
      bookingRef: String(result.bookingRef || normalizedRef),
      stagedReceiptPath,
      receiptImageUrl: String(result.receiptImageUrl || stagedReceiptPath),
      receiptImageHash: result.receiptImageHash || null,
      contentType: String(result.contentType || ''),
      size: Number(result.size || 0),
      stagedAt: result.stagedAt || null,
    };
  },

  async discardBookingReceipt(payload = {}) {
    const bookingRef = String(payload?.bookingRef || '').trim();
    const stagedReceiptPath = String(payload?.stagedReceiptPath || '').trim();
    if (!bookingRef || !stagedReceiptPath) {
      throw new Error('Booking reference and staged receipt path are required.');
    }
    const result = await _pbReceiptCheckpointRequest('discard-stage', {
      bookingRef,
      stagedReceiptPath,
    });
    _pbClearFastCache(['bookings']);
    return result;
  },

  // Verify a provider-specific digital receipt image via the Edge Function.
  // payload: { bookingRef, provider, imageFile, contentType }.
  // For a saved public booking, its browser-only bearer token is attached here
  // and verified by the Edge Function before any service-role write.
  // imageBase64 remains supported for older deployed clients.
  // Returns: { ok, status, flags, extracted, confidence, message }
  async verifyGcashReceipt(payload) {
    const bookingRef = String(payload?.bookingRef || '');
    const storedBookingToken = _pbBookingAccessToken(bookingRef, false);
    const requestPayload = {
      ...(payload || {}),
      ...(storedBookingToken ? { bookingAccessToken: storedBookingToken } : {}),
    };
    const sessionResult = await _sb.auth.getSession();
    const userAccessToken = sessionResult?.data?.session?.access_token || '';
    const authHeader = `Bearer ${userAccessToken || SUPABASE_ANON_KEY}`;

    // Do not use `instanceof Blob` here. Facebook/Messenger WebViews can hand
    // us a File from a different JavaScript realm, where that check is false.
    if (requestPayload.imageFile) {
      const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
      const imageFile = await _pbPrepareReceiptImage(requestPayload.imageFile);
      const form = new FormData();
      form.append('action', 'verify');
      form.append('bookingRef', bookingRef);
      form.append('provider', String(requestPayload.provider || 'gcash'));
      form.append('contentType', imageFile.type || requestPayload.contentType || 'image/jpeg');
      if (requestPayload.bookingData) form.append('bookingData', JSON.stringify(requestPayload.bookingData));
      if (requestPayload.bookingAccessToken) form.append('bookingAccessToken', requestPayload.bookingAccessToken);
      try {
        form.append('receipt', imageFile, imageFile.name || 'receipt.jpg');
      } catch (_) {
        // Older embedded WebViews may expose a file-like object that FormData
        // refuses. Base64 is a compatibility fallback, not the normal path.
        return _pbNormalizeReceiptOutcome(await _pbVerifyReceiptBase64Fallback(fnUrl, requestPayload, imageFile, authHeader));
      }

      const res = await _pbFetchWithTimeout(fnUrl, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': authHeader,
        },
        body: form,
      }, PB_RECEIPT_TIMEOUT_MS);
      const txt = await res.text();
      const json = _safeJsonParse(txt);
      if (!res.ok) {
        const reason = String(json?.error || txt || `HTTP ${res.status}`);
        const missingMultipartImage = [400, 415, 422].includes(res.status) &&
          /receipt file|multipart body|empty image/i.test(reason);
        if (missingMultipartImage) {
          return _pbNormalizeReceiptOutcome(await _pbVerifyReceiptBase64Fallback(fnUrl, requestPayload, imageFile, authHeader));
        }
        throw _pbApiError(reason, String(json?.code || `HTTP_${res.status}`));
      }
      if (!json) throw new Error('Receipt verification returned an invalid response.');
      return _pbNormalizeReceiptOutcome(json);
    }

    const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
    const res = await _pbFetchWithTimeout(fnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': authHeader },
      body: JSON.stringify(requestPayload),
    }, PB_RECEIPT_TIMEOUT_MS);
    const txt = await res.text();
    const json = _safeJsonParse(txt);
    if (!res.ok) throw _pbApiError(
      String(json?.error || txt || `HTTP ${res.status}`),
      String(json?.code || `HTTP_${res.status}`),
    );
    return _pbNormalizeReceiptOutcome(json);
  },

  // Request a short-lived signed URL to view a stored receipt (admin only).
  async getReceiptSignedUrl(bookingRef) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', bookingRef },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  async getOpenPlayReceiptSignedUrl(registrationId) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', openPlayRegistrationId: registrationId },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  async getHostSessionReceiptSignedUrl(registrationId) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', hostSessionRegistrationId: registrationId },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  // Compatibility for older pages: production courts are created only by an
  // explicit admin action. Empty results (including failed reads) must not seed.
  async seedDefaultData() {
    return;
  },

  // Check if user has accepted the current agreement version
  async getAgreement(userId, version = 1) {
    const { data } = await _sb.from('agreements').select('id, full_name, agreed_at').eq('user_id', userId).eq('version', version).maybeSingle();
    return data || null;
  },

  // Save signed agreement
  async saveAgreement({ userId, email, fullName, role, signatureData, ipAddress, userAgent, version = 1 }) {
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
    const [dashboardResult, historyResult, legacyResult] = await Promise.all([
      _sb.rpc('get_booking_fee_remittance_dashboard'),
      _sb.rpc('get_booking_fee_remittance_history', { p_limit: 100, p_before: null }),
      _sb.from('weekly_fees')
        .select('id,court_owner_email,week_start,week_end,bookings_count,fee_per_booking,amount_due,status,billed_refs,generated_at,sent_at,due_at,paid_at,paid_ref,paid_note,paid_by_user_id')
        .eq('status', 'paid')
        .order('paid_at', { ascending: false }),
    ]);
    if (dashboardResult.error) throw new Error(_extractFnError(dashboardResult.error, 'Could not load remittance dashboard'));
    if (historyResult.error) throw new Error(_extractFnError(historyResult.error, 'Could not load remittance history'));
    const dashboard = dashboardResult.data || {};
    const allHistory = Array.isArray(historyResult.data) ? historyResult.data : [];
    const active = Array.isArray(dashboard.open_remittances) ? dashboard.open_remittances : [];
    const legacyPaid = legacyResult.error ? [] : (legacyResult.data || []).map(row => {
      const refs = Array.isArray(row.billed_refs) ? row.billed_refs : [];
      const amount = Number(row.amount_due) || 0;
      return {
        id: `legacy-${row.id}`,
        legacy_weekly_fee_id: row.id,
        is_legacy: true,
        remittance_ref: `LEGACY-${String(row.week_start || '').replace(/-/g, '')}-${String(row.id || '').slice(0, 6).toUpperCase()}`,
        status: 'settled',
        coverage_start_at: row.week_start ? `${row.week_start}T00:00:00+08:00` : null,
        cutoff_at: row.week_end ? `${row.week_end}T23:59:59+08:00` : null,
        cycle_due_on: String(row.due_at || row.week_end || '').slice(0, 10) || null,
        bookings_count: Number(row.bookings_count) || refs.length,
        amount_due: amount,
        amount_settled: amount,
        remaining_balance: 0,
        prepared_at: row.generated_at || row.sent_at || null,
        prepared_by_email: row.court_owner_email || null,
        settled_at: row.paid_at || null,
        billed_refs: refs,
        latest_payment: {
          amount_submitted: amount,
          amount_accepted: amount,
          payment_method: 'legacy',
          payment_reference: row.paid_ref || '',
          note: row.paid_note || 'Imported from the previous statement ledger.',
          status: 'accepted',
          reviewed_at: row.paid_at || null,
          reviewed_by_user_id: row.paid_by_user_id || null,
        },
      };
    });
    const history = [
      ...allHistory.filter(row => ['settled', 'cancelled'].includes(String(row?.status || '').toLowerCase())),
      ...legacyPaid,
    ].sort((a, b) => new Date(b.settled_at || b.prepared_at || 0) - new Date(a.settled_at || a.prepared_at || 0));
    const historySettledTotal = history
      .filter(row => String(row?.status || '').toLowerCase() === 'settled')
      .reduce((sum, row) => sum + (Number(row?.amount_settled ?? row?.amount_due) || 0), 0);
    const legacySettledTotal = legacyPaid.reduce((sum, row) => sum + (Number(row.amount_settled) || 0), 0);
    const newSettledTotal = dashboard.settled_total == null
      ? historySettledTotal - legacySettledTotal
      : (Number(dashboard.settled_total) || 0);
    return {
      ...dashboard,
      live: dashboard.accumulated || {},
      active,
      history,
      settled_total: newSettledTotal + legacySettledTotal,
    };
  },

  async sendHostBalanceNotice(bookingRef, eventType = 'reminder_1d', options = {}) {
    return _invokeEdgeFunction('process-host-balance-deadlines', {
      action: 'manual', bookingRef, eventType,
    }, { allowFailure: !!options.allowFailure, retryDirect: false });
  },

  async processHostBalanceDeadlines(options = {}) {
    return _invokeEdgeFunction('process-host-balance-deadlines', {
      action: 'process', source: 'admin',
    }, { allowFailure: options.allowFailure !== false, retryDirect: false });
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
      p_limit: Math.max(1, Math.min(100, Number(limit) || 30)),
      p_before: before || null,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load remittance history'));
    return Array.isArray(data) ? data : (data || []);
  },

  async getBookingFeeRemittanceDetail(remittanceId) {
    const { data, error } = await _sb.rpc('get_booking_fee_remittance_detail', {
      p_remittance_id: remittanceId,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load remittance details'));
    return data || null;
  },

  async prepareBookingFeeRemittance({ ownerOverride = false, overrideDueOn = null, overrideReason = null } = {}) {
    const { data, error } = await _sb.rpc('prepare_booking_fee_remittance', {
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
    const image = _remittanceProofUpload(proofData || proofUrl);
    const { data: authData, error: authError } = await _sb.auth.getUser();
    if (authError || !authData?.user?.id) throw new Error('Your session expired. Please sign in again.');

    const safeRemittanceId = String(remittanceId || '').replace(/[^a-z0-9-]/gi, '');
    if (!safeRemittanceId) throw new Error('Remittance record is missing.');
    const objectName = `${Date.now()}-${_remittanceIdempotencyKey('proof').replace(/[^a-z0-9-]/gi, '')}.${image.extension}`;
    const proofPath = `${safeRemittanceId}/${authData.user.id}/${objectName}`;
    const { error: uploadError } = await _sb.storage
      .from('remittance-proofs')
      .upload(proofPath, image.bytes, { contentType: image.mimeType, upsert: false });
    if (uploadError) throw new Error(_extractFnError(uploadError, 'Could not upload remittance receipt'));

    const { data, error } = await _sb.rpc('submit_booking_fee_remittance', {
      p_remittance_id: remittanceId,
      p_amount: amount == null ? null : Number(amount),
      p_payment_method: String(paymentMethod || 'gcash').toLowerCase(),
      p_payment_reference: String(paymentRef || '').trim(),
      p_proof_path: proofPath,
      p_note: String(note || '').trim() || null,
      p_idempotency_key: _remittanceIdempotencyKey('submit'),
    });
    if (error) {
      throw new Error(_extractFnError(error, 'Could not submit remittance proof'));
    }
    return data || null;
  },

  async getBookingFeeRemittanceProofUrl(proofPath, expiresIn = 300) {
    const path = String(proofPath || '').trim();
    if (!path) throw new Error('No remittance receipt is attached.');
    const { data, error } = await _sb.storage
      .from('remittance-proofs')
      .createSignedUrl(path, Math.max(60, Math.min(900, Number(expiresIn) || 300)));
    if (error || !data?.signedUrl) throw new Error(_extractFnError(error, 'Could not open remittance receipt'));
    return data.signedUrl;
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
      p_remittance_id: remittanceId,
      p_reason: String(reason || '').trim(),
      p_idempotency_key: _remittanceIdempotencyKey('cancel'),
    });
    if (error) throw new Error(_extractFnError(error, 'Could not cancel remittance'));
    return data || null;
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

// =============================================
// AUTH — Supabase Auth (email + password)
// Admin accounts are managed in Supabase Dashboard → Authentication → Users
// The accounts table stores role/display info linked by email.
// =============================================
// =============================================
// LOCAL DATA MODE
// Enable only on localhost with localStorage.setItem('pb_data_mode', 'local')
// or by opening a local page with ?localData=1. Disable with ?remoteData=1.
// =============================================
(function installLocalDataMode() {
  if (!window.PB_USE_LOCAL_DATA) return;

  // Brand-specific key prevents copied/demo browser data from another venue
  // appearing inside a Pickle Street local preview.
  const STORE_KEY = 'pickle_street_tugbok_local_db_v1';
  const nowIso = () => new Date().toISOString();
  const localRef = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const localShareToken = () => {
    const bytes = new Uint8Array(32);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  };
  const withLocalPlayManagerLock = task =>
    window.navigator?.locks?.request
      ? window.navigator.locks.request(`${STORE_KEY}:play-manager`, task)
      : task();

  const defaultCourts = () => Array.from({ length: 3 }, (_, i) => {
    const n = i + 1;
    return {
      id: `c${n}`,
      name: `Pickle Street Court ${n}`,
      desc: 'Outdoor',
      rate: n <= 5 ? 60 : 90,
      blocked: false,
      feats: ['Outdoor'],
      photo: 'assets/pickle-street-courts.jpg',
      rateSchedule: [
        { from: 6, to: 18, rate: 60 },
        { from: 18, to: 23, rate: 90 },
      ],
    };
  });

  const defaultSettings = () => ({
    open_hour: '6',
    close_hour: '24',
    maintenance_config: JSON.stringify({ rules: [] }),
    open_play_config: JSON.stringify({
      enabled: true,
      start: 6,
      end: 23,
      days: [0, 6],
      specificDates: ['2026-06-20'],
      courtIds: [],
      fee: 25,
      maxPlayers: 16,
    }),
    payment_acceptance_mode: 'full_payment_only',
    payment_method_cash: '0',
    payment_method_gcash: '1',
    payment_method_bdopay: '1',
    payment_method_maya: '1',
    payment_method_bpi: '1',
    payment_method_gotyme: '1',
    payment_method_maribank: '1',
    payment_method_pnb: '0',
    reschedule_cutoff_hours: '24',
    reschedule_submission_cooldown_seconds: '15',
    gcash_merchant_number: '09XXXXXXXXX',
    gcash_merchant_name: 'Court Owner Name',
    service_fee_rate: '10',
    maintenance_fee: '10',
    fee_type: 'per_hour',
  });

  const localBookingFeeSnapshot = (booking, settings = {}) => {
    const total = Math.max(0, Number(booking?.total || 0));
    const slots = Array.isArray(booking?.slots) ? booking.slots : [];
    const configuredRate = Number(
      settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee ?? 0,
    );
    const feeRate = Number.isFinite(configuredRate) ? Math.max(0, configuredRate) : 0;
    const feeType = ['flat', 'booking', 'per_booking', 'per_transaction'].includes(
      String(settings.fee_type || '').toLowerCase(),
    ) ? 'flat' : 'per_hour';
    const feeUnits = feeType === 'flat' ? 1 : slots.length;
    const explicitAmount = booking?.bookingFeeAmountSnapshot ?? booking?.booking_fee_amount_snapshot;
    const parsedExplicitAmount = Number(explicitAmount);
    const calculatedAmount = explicitAmount !== null && explicitAmount !== undefined && Number.isFinite(parsedExplicitAmount)
      ? parsedExplicitAmount
      : feeRate * feeUnits;
    const amount = Math.round(Math.min(total, Math.max(0, calculatedAmount)) * 100) / 100;
    return {
      bookingFeeAmountSnapshot: amount,
      bookingFeeRateSnapshot: feeRate,
      bookingFeeTypeSnapshot: feeType,
      bookingFeeUnitsSnapshot: feeUnits,
      bookingFeeSnapshotSource: booking?.bookingFeeSnapshotSource || 'local_insert',
      bookingFeeLedgerEligibleSnapshot: booking?.bookingFeeLedgerEligibleSnapshot !== undefined
        ? !!booking.bookingFeeLedgerEligibleSnapshot
        : String(booking?.paymentMethod || '').toLowerCase() !== 'manual'
          && !String(booking?.ref || '').toUpperCase().startsWith('MANUAL-'),
    };
  };

  const defaultAccounts = () => ([
    {
      id: 'owner_001',
      username: 'owner',
      password: 'dev123',
      role: 'owner',
      status: 'active',
      fullName: 'System Owner',
      email: 'owner@picklestreet.local',
      createdAt: nowIso(),
    },
    {
      id: 'host_test_001',
      username: 'host.test',
      password: 'HostTest123!',
      role: 'host',
      status: 'active',
      fullName: 'Open Play Test Host',
      email: 'host.test@picklestreet.local',
      createdAt: nowIso(),
    },
  ]);

  const defaultHostDemoBookings = () => {
    const makeHostBooking = ({ ref, groupRef = null, courtId, courtName, date, slots, rate, method = 'gcash', gcashRef = '', paymentStatus = 'downpayment_paid', status = 'confirmed', createdDaysAgo = 0 }) => {
      const duration = slots.length;
      const total = duration * rate;
      const serviceFee = Math.min(total, duration * 10);
      const courtFee = Math.max(0, total - serviceFee);
      const downpayment = Math.round(((courtFee * 0.25) + serviceFee) * 100) / 100;
      const start = Math.min(...slots);
      const end = Math.max(...slots) + 1;
      return {
        ref,
        groupRef,
        fullName: 'Open Play Test Host',
        contactNumber: '09171234567',
        email: 'host.test@picklestreet.local',
        courtId,
        courtName,
        date,
        slots,
        startTime: _fmtBookingHour(start),
        endTime: _fmtBookingHour(end),
        timeLabel: `${_fmtBookingHour(start)} - ${_fmtBookingHour(end)}`,
        duration,
        rate,
        total,
        bookingFeeAmountSnapshot: serviceFee,
        bookingFeeRateSnapshot: 10,
        bookingFeeTypeSnapshot: 'per_hour',
        bookingFeeUnitsSnapshot: duration,
        bookingFeeSnapshotSource: 'local_seed',
        bookingFeeLedgerEligibleSnapshot: true,
        paymentMethod: method,
        paymentFlow: method,
        gcashRef,
        downpayment: paymentStatus === 'paid' ? total : downpayment,
        hostBooking: true,
        hostUserId: 'host_test_001',
        hostName: 'Open Play Test Host',
        hostEmail: 'host.test@picklestreet.local',
        paymentStatus,
        status,
        bookingFeeEarnedAt: ['confirmed', 'completed'].includes(status)
          && ['paid', 'downpayment_paid'].includes(paymentStatus)
          ? new Date(Date.now() - createdDaysAgo * 86400000).toISOString()
          : null,
        createdAt: new Date(Date.now() - createdDaysAgo * 86400000).toISOString(),
      };
    };
    return [
      makeHostBooking({ ref: 'HOST-DEMO-001', courtId: 'c1', courtName: 'Pickle Street Court 1', date: '2026-07-12', slots: [14, 15], rate: 60, gcashRef: '1234567890123', createdDaysAgo: 1 }),
      makeHostBooking({ ref: 'HOST-DEMO-002', courtId: 'c2', courtName: 'Pickle Street Court 2', date: '2026-07-14', slots: [18, 19, 20], rate: 90, gcashRef: '9876543210123', createdDaysAgo: 2 }),
      makeHostBooking({ ref: 'HOST-DEMO-003', courtId: 'c3', courtName: 'Pickle Street Court 3', date: '2026-07-18', slots: [8, 9], rate: 60, method: 'cash', paymentStatus: 'unpaid', status: 'pending', createdDaysAgo: 0 }),
      makeHostBooking({ ref: 'HOST-DEMO-004', courtId: 'c4', courtName: 'Pickle Street Court 4', date: '2026-07-04', slots: [16, 17], rate: 60, gcashRef: '2223334445556', paymentStatus: 'paid', createdDaysAgo: 6 }),
      makeHostBooking({ ref: 'HOST-DEMO-005', courtId: 'c5', courtName: 'Pickle Street Court 5', date: '2026-06-29', slots: [19, 20, 21], rate: 90, gcashRef: '3334445556667', paymentStatus: 'downpayment_paid', createdDaysAgo: 12 }),
      makeHostBooking({ ref: 'HOST-DEMO-006', courtId: 'c6', courtName: 'Pickle Street Court 6', date: '2026-07-20', slots: [10, 11, 12], rate: 90, gcashRef: '4445556667778', paymentStatus: 'for_verification', status: 'verifying', createdDaysAgo: 0 }),
      makeHostBooking({ ref: 'HOST-DEMO-MULTI-001-A', groupRef: 'HOST-DEMO-MULTI-001', courtId: 'c7', courtName: 'Pickle Street Court 7', date: '2026-07-25', slots: [17, 18, 19, 20], rate: 90, gcashRef: '5556667778889', createdDaysAgo: 0 }),
      makeHostBooking({ ref: 'HOST-DEMO-MULTI-001-B', groupRef: 'HOST-DEMO-MULTI-001', courtId: 'c8', courtName: 'Pickle Street Court 8', date: '2026-07-25', slots: [17, 18, 19, 20], rate: 90, gcashRef: '5556667778889', createdDaysAgo: 0 }),
      makeHostBooking({ ref: 'HOST-DEMO-MULTI-001-C', groupRef: 'HOST-DEMO-MULTI-001', courtId: 'c9', courtName: 'Pickle Street Court 9', date: '2026-07-25', slots: [17, 18, 19, 20], rate: 90, gcashRef: '5556667778889', createdDaysAgo: 0 }),
    ];
  };

  function freshDb() {
    return {
      courts: defaultCourts(),
      bookings: [],
      bookingRescheduleRequests: [],
      openPlayRegistrations: [],
      openPlayHostApplications: [],
      openPlayHostSessions: [],
      openPlayHostSessionRegistrations: [],
      openPlayGameSessions: [],
      openPlayGamePlayers: [],
      openPlayGameRounds: [],
      openPlayGameShares: [],
      blockedDates: [],
      deletedBookingArchive: [],
      accounts: defaultAccounts(),
      settings: defaultSettings(),
      agreements: [],
      weeklyFees: [],
    };
  }

  function readDb() {
    const parsed = _safeJsonParse(localStorage.getItem(STORE_KEY));
    if (!parsed || typeof parsed !== 'object') {
      const db = freshDb();
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
      return db;
    }
    const accounts = Array.isArray(parsed.accounts) && parsed.accounts.length ? parsed.accounts : defaultAccounts();
    const bookings = Array.isArray(parsed.bookings) ? parsed.bookings : [];
    let localSeedChanged = false;
    for (const defaultAccount of defaultAccounts()) {
      if (!accounts.some(a => String(a.id) === String(defaultAccount.id))) {
        accounts.push(defaultAccount);
        localSeedChanged = true;
      }
    }
    for (const demoBooking of []) {
      if (!bookings.some(b => String(b.ref) === String(demoBooking.ref))) {
        bookings.push(demoBooking);
        localSeedChanged = true;
      }
    }
    const openPlayGamePlayers = (Array.isArray(parsed.openPlayGamePlayers)
      ? parsed.openPlayGamePlayers
      : []
    ).map(player => {
      if (Number.isFinite(Number(player.performance_seed_rating))) return player;
      localSeedChanged = true;
      return {
        ...player,
        performance_seed_rating: openPlayPerformanceSeed(player.skill_level),
      };
    });
    const db = {
      ...freshDb(),
      ...parsed,
      settings: { ...defaultSettings(), ...(parsed.settings || {}) },
      courts: Array.isArray(parsed.courts) ? parsed.courts : defaultCourts(),
      bookings,
      bookingRescheduleRequests: Array.isArray(parsed.bookingRescheduleRequests) ? parsed.bookingRescheduleRequests : [],
      openPlayRegistrations: Array.isArray(parsed.openPlayRegistrations) ? parsed.openPlayRegistrations : [],
      openPlayHostApplications: Array.isArray(parsed.openPlayHostApplications) ? parsed.openPlayHostApplications : [],
      openPlayHostSessions: Array.isArray(parsed.openPlayHostSessions) ? parsed.openPlayHostSessions : [],
      openPlayHostSessionRegistrations: Array.isArray(parsed.openPlayHostSessionRegistrations) ? parsed.openPlayHostSessionRegistrations : [],
      openPlayGameSessions: (Array.isArray(parsed.openPlayGameSessions)
        ? parsed.openPlayGameSessions
        : []
      ).map(session => ({
        ...session,
        ranking_mode: normalizeOpenPlayRankingMode(session.ranking_mode),
        performance_rating_version: session.performance_rating_version || 'pr-performance-v1',
        performance_rating_k: Number(session.performance_rating_k || 24),
        performance_rating_scale: Number(session.performance_rating_scale || 400),
        performance_rating_min_games: Number(session.performance_rating_min_games || 3),
      })),
      openPlayGamePlayers,
      openPlayGameRounds: Array.isArray(parsed.openPlayGameRounds) ? parsed.openPlayGameRounds : [],
      openPlayGameShares: Array.isArray(parsed.openPlayGameShares) ? parsed.openPlayGameShares : [],
      blockedDates: Array.isArray(parsed.blockedDates) ? parsed.blockedDates : [],
      deletedBookingArchive: Array.isArray(parsed.deletedBookingArchive) ? parsed.deletedBookingArchive : [],
      accounts,
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
      weeklyFees: Array.isArray(parsed.weeklyFees) ? parsed.weeklyFees : [],
    };
    if (localSeedChanged) writeDb(db);
    return db;
  }

  function writeDb(db) {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  }

  function mutateLocalOpenPlayGamePublicShare(db, sessionId, enabled, rotate = false) {
    const session = db.openPlayGameSessions.find(item =>
      String(item.id) === String(sessionId)
    );
    if (!session) throw new Error('PLAY_MANAGER_SESSION_NOT_FOUND');

    if (!enabled) {
      db.openPlayGameShares = (db.openPlayGameShares || []).filter(share =>
        String(share.session_id) !== String(sessionId)
      );
      return null;
    }

    const now = Date.now();
    const status = String(session.status || '');
    const completedAt = Date.parse(session.updated_at || '');
    const completedIsFresh = status === 'completed'
      && Number.isFinite(completedAt)
      && now - completedAt <= 24 * 60 * 60 * 1000;
    if (!['active', 'paused'].includes(status) && !completedIsFresh) {
      throw new Error('PLAY_MANAGER_SESSION_NOT_SHAREABLE');
    }

    db.openPlayGameShares = (db.openPlayGameShares || []).filter(share => {
      const expiresAt = Date.parse(share.expires_at || '');
      const belongsToSession = String(share.session_id) === String(sessionId);
      return Number.isFinite(expiresAt) && expiresAt > now && !(rotate && belongsToSession);
    });
    const token = localShareToken();
    const expiresAt = status === 'completed'
      ? Math.min(now + 24 * 60 * 60 * 1000, completedAt + 24 * 60 * 60 * 1000)
      : now + 24 * 60 * 60 * 1000;
    db.openPlayGameShares.push({
      id: localRef('gms'),
      session_id: sessionId,
      token,
      created_at: new Date(now).toISOString(),
      rotated_at: new Date(now).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
    });
    return token;
  }

  function requireLocalPlayManagerSession(db, sessionId, allowedStatuses) {
    const session = db.openPlayGameSessions.find(item =>
      String(item.id) === String(sessionId)
    );
    if (!session) throw new Error('PLAY_MANAGER_SESSION_NOT_FOUND');
    if (!allowedStatuses.includes(String(session.status || ''))) {
      throw new Error('PLAY_MANAGER_SESSION_NOT_ACTIVE');
    }
    return session;
  }

  function localOpenPlayPlayerHasRatedGame(db, player) {
    const playerId = String(player?.id || '');
    if (!playerId) return false;
    return (db.openPlayGameRounds || [])
      .filter(round => String(round.session_id) === String(player.session_id))
      .some(round => (round.assignments || []).some(game => {
        const results = [
          ...(Array.isArray(game.completedGames) ? game.completedGames : []),
          game,
        ];
        return results.some(result =>
          ['A', 'B'].includes(result?.winner) &&
          [...(result.teamA || []), ...(result.teamB || [])]
            .some(id => String(id) === playerId)
        );
      }));
  }

  function localOpenPlayLiveBoard(db, shareToken) {
    const token = String(shareToken || '').trim();
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const share = (db.openPlayGameShares || []).find(row => row.token === token);
    if (!share) return null;
    const shareExpiresAt = Date.parse(share.expires_at || '');
    if (!Number.isFinite(shareExpiresAt) || shareExpiresAt <= Date.now()) return null;

    const session = (db.openPlayGameSessions || []).find(row =>
      String(row.id) === String(share.session_id)
    );
    if (!session) return null;
    const status = String(session.status || '');
    const rankingMode = normalizeOpenPlayRankingMode(session.ranking_mode);
    const completedAt = Date.parse(session.updated_at || '');
    const completedIsFresh = status === 'completed'
      && Number.isFinite(completedAt)
      && Date.now() - completedAt <= 24 * 60 * 60 * 1000;
    if (!['active', 'paused'].includes(status) && !completedIsFresh) return null;

    const sessionPlayers = (db.openPlayGamePlayers || [])
      .filter(player => String(player.session_id) === String(session.id));
    const activePlayers = sessionPlayers
      .filter(player => player.status === 'active')
      .sort((left, right) =>
        Number(left.seed_order || 0) - Number(right.seed_order || 0) ||
        String(left.created_at || '').localeCompare(String(right.created_at || '')) ||
        String(left.id).localeCompare(String(right.id))
      );
    const playerById = new Map(sessionPlayers.map(player => [String(player.id), player.full_name || 'Player']));
    const rounds = (db.openPlayGameRounds || [])
      .filter(round => String(round.session_id) === String(session.id))
      .sort((left, right) =>
        Number(left.round_no || 0) - Number(right.round_no || 0) ||
        String(left.created_at || '').localeCompare(String(right.created_at || ''))
      );
    const latestRound = rounds[rounds.length - 1] || null;
    const liveAssigned = new Set(
      (latestRound?.assignments || [])
        .flatMap(game => game.winner
          ? [
              ...(game.readyMatch?.teamA || []),
              ...(game.readyMatch?.teamB || []),
            ]
          : [...(game.teamA || []), ...(game.teamB || [])]
        )
        .map(String)
    );
    const activeIds = new Set(activePlayers.map(player => String(player.id)));
    const readyLineups = (latestRound?.assignments || [])
      .map((game, courtIndex) => {
        const teamOneIds = (game.readyMatch?.teamA || []).map(String);
        const teamTwoIds = (game.readyMatch?.teamB || []).map(String);
        const teamIds = [...teamOneIds, ...teamTwoIds];
        const uniqueTeamIds = [...new Set(teamIds)];
        if (
          !game.winner
          || teamOneIds.length !== 2
          || teamTwoIds.length !== 2
          || uniqueTeamIds.length !== 4
          || uniqueTeamIds.some(playerId => !activeIds.has(playerId))
        ) return null;

        const storedOrder = [...new Set((game.readyMatch?.queueOrder || []).map(String))];
        const teamSet = new Set(uniqueTeamIds);
        const playerIds = storedOrder.length === 4
          && storedOrder.every(playerId => teamSet.has(playerId))
          ? storedOrder
          : teamIds;
        const reservedAt = game.readyMatch?.reservedAt || game.resultAt || '';
        const parsedReservedAt = Date.parse(reservedAt);
        return {
          courtIndex,
          courtName: game.courtName || `Court ${courtIndex + 1}`,
          players: playerIds.map(playerId => playerById.get(playerId) || 'Player'),
          team1: teamOneIds.map(playerId => playerById.get(playerId) || 'Player'),
          team2: teamTwoIds.map(playerId => playerById.get(playerId) || 'Player'),
          sortTime: Number.isFinite(parsedReservedAt) ? parsedReservedAt : Number.MAX_SAFE_INTEGER,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.sortTime - right.sortTime || left.courtIndex - right.courtIndex);
    const publicUpNext = readyLineups.length ? {
      courtName: readyLineups[0].courtName,
      players: readyLineups[0].players,
      team1: readyLineups[0].team1,
      team2: readyLineups[0].team2,
    } : null;
    const queuedIds = [];
    const queuedSet = new Set();
    (latestRound?.queue_snapshot || []).map(String).forEach(playerId => {
      if (activeIds.has(playerId) && !liveAssigned.has(playerId) && !queuedSet.has(playerId)) {
        queuedSet.add(playerId);
        queuedIds.push(playerId);
      }
    });
    activePlayers.forEach(player => {
      const playerId = String(player.id);
      if (!liveAssigned.has(playerId) && !queuedSet.has(playerId)) {
        queuedSet.add(playerId);
        queuedIds.push(playerId);
      }
    });

    const ratingMatches = [];
    let resultCount = 0;
    let latestResult = null;
    let latestResultTime = -Infinity;
    let ratingSequence = 0;
    const processGame = (game, round, courtIndex, completedGameIndex = null) => {
      const teamOne = (game.teamA || []).map(String);
      const teamTwo = (game.teamB || []).map(String);
      if (game.winner === 'A' || game.winner === 'B') {
        resultCount += 1;
        ratingMatches.push({
          matchId: game.matchId || '',
          roundNo: Number(round?.round_no || 0),
          courtIndex,
          completedGameIndex,
          teamA: teamOne,
          teamB: teamTwo,
          winner: game.winner,
          resultAt: game.resultAt || '',
          sequence: ratingSequence++,
        });
        const resultAt = game.resultAt || null;
        const parsedResultTime = Date.parse(resultAt || '');
        const parsedRoundTime = Date.parse(round?.created_at || '');
        const resultTime = Number.isFinite(parsedResultTime)
          ? parsedResultTime
          : (Number.isFinite(parsedRoundTime) ? parsedRoundTime : 0);
        if (resultTime >= latestResultTime) {
          const courtName = game.courtName || `Court ${courtIndex + 1}`;
          latestResultTime = resultTime;
          latestResult = {
            eventId: [
              Number(round?.round_no || 0),
              courtName,
              resultAt || '',
              game.winner,
            ].join(':'),
            roundNo: Number(round?.round_no || 0),
            courtIndex,
            courtName,
            team1: teamOne.map(playerId => playerById.get(playerId) || 'Player'),
            team2: teamTwo.map(playerId => playerById.get(playerId) || 'Player'),
            winner: game.winner,
            resultAt,
          };
        }
      }
    };
    rounds.forEach(round => {
      (round.assignments || []).forEach((game, courtIndex) => {
        (game.completedGames || []).forEach((completedGame, completedGameIndex) => {
          processGame(completedGame, round, courtIndex, completedGameIndex);
        });
        processGame(game, round, courtIndex, null);
      });
    });
    const activeIdSet = new Set(activePlayers.map(player => String(player.id)));
    const standings = window.PBOpenPlayRating?.calculateStandings
      ? window.PBOpenPlayRating
          .calculateStandings(sessionPlayers, ratingMatches, {
            minGames: Number(session.performance_rating_min_games || 3),
            mode: rankingMode,
          })
          .filter(row => activeIdSet.has(String(row.id)) || row.games > 0)
          .map(row => ({
            name: row.name,
            rating: row.rating,
            ratingExact: row.ratingExact,
            points: row.points,
            pointsExact: row.pointsExact,
            games: row.games,
            wins: row.wins,
            losses: row.losses,
            winRate: row.winRate,
            winPercentage: row.winPercentage,
            mode: row.mode,
            eligible: row.eligible,
            rank: row.rank,
            averageOpponentRating: row.averageOpponentRating,
            averageOpponentRatingExact: row.averageOpponentRatingExact,
            bestUpset: row.bestUpset,
            bestUpsetExact: row.bestUpsetExact,
            headToHeadGames: row.headToHeadGames,
            headToHeadWins: row.headToHeadWins,
            headToHeadLosses: row.headToHeadLosses,
            headToHeadPercentage: row.headToHeadPercentage,
            rankCriterion: row.rankCriterion,
            rankReason: row.rankReason,
            tieBreakReason: row.tieBreakReason,
            requiresPodiumDecider: row.requiresPodiumDecider,
            podiumDeciderGroupId: row.podiumDeciderGroupId,
          }))
      : [];

    return {
      generatedAt: nowIso(),
      session: {
        date: session.date || '',
        timeLabel: session.time_label || '',
        courtNames: session.court_names || [],
        status,
        currentRound: Number(latestRound?.round_no || session.current_round || 0),
      },
      players: activePlayers.map(player => player.full_name || 'Player'),
      latestRound: latestRound ? {
        roundNo: Number(latestRound.round_no || 0),
        assignments: (latestRound.assignments || []).map((game, index) => ({
          courtName: game.courtName || `Court ${index + 1}`,
          team1: (game.teamA || []).map(playerId => playerById.get(String(playerId)) || 'Player'),
          team2: (game.teamB || []).map(playerId => playerById.get(String(playerId)) || 'Player'),
          startedAt: game.startedAt || null,
          winner: game.winner || null,
          gameCount: 1 + (Array.isArray(game.completedGames) ? game.completedGames.length : 0),
        })),
        upNext: publicUpNext,
        queue: queuedIds.map(playerId => playerById.get(playerId) || 'Player'),
      } : null,
      standings,
      ratingSystem: {
        mode: rankingMode,
        name: rankingMode === 'competitive'
          ? 'Competitive Ranking'
          : rankingMode === 'win_percentage'
            ? 'Individual Win Percentage'
            : 'Individual Performance Rating',
        version: rankingMode === 'competitive'
          ? 'competitive-ranking-v2'
          : rankingMode === 'win_percentage'
            ? 'win-percentage-v1'
            : (session.performance_rating_version || 'pr-performance-v1'),
        minGames: Number(session.performance_rating_min_games || 3),
        rankingMetric: rankingMode === 'competitive'
          ? 'competitive'
          : rankingMode === 'win_percentage'
            ? 'win_percentage'
            : 'session_points',
      },
      resultCount,
      latestResult,
    };
  }

  function buildLocalAvailabilityGraphic(date, courtIds = [], options) {
    const session = window.Auth?.getSession?.() || null;
    const role = session?.role || '';
    const guestSafe = options?.guestSafe === true;
    if (!guestSafe && (!['owner', 'court_owner'].includes(role)
        || (session?.status && session.status !== 'active'))) {
      throw new Error('An active Pickle Street owner account is required.');
    }

    const requestedDate = String(date || '').trim();
    const requestedCourtIds = [...new Set((Array.isArray(courtIds) ? courtIds : [])
      .map(id => String(id || '').trim()).filter(Boolean))];
    const excludedBookingRefs = new Set((Array.isArray(options?.excludeBookingRefs)
      ? options.excludeBookingRefs
      : []).map(value => String(value || '').trim()).filter(Boolean));
    const phParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const phToday = `${phParts.year}-${phParts.month}-${phParts.day}`;
    const maxDateValue = new Date(`${phToday}T12:00:00Z`);
    maxDateValue.setUTCDate(maxDateValue.getUTCDate() + 366);
    const maxDate = maxDateValue.toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || requestedDate < phToday
        || requestedDate > maxDate || requestedCourtIds.length > 50) {
      throw new Error('Availability date must be within the next 366 Manila calendar days.');
    }

    const db = readDb();
    const settings = db.settings || {};
    const openHour = Number(settings.open_hour);
    const closeHour = Number(settings.close_hour);
    if (!Number.isInteger(openHour) || !Number.isInteger(closeHour)
        || openHour < 0 || openHour > 23 || closeHour < 1 || closeHour > 24 || closeHour <= openHour) {
      throw new Error('Court operating hours are not configured correctly.');
    }
    const maintenance = _safeJsonParse(String(settings.maintenance_config || ''));
    if (!maintenance || typeof maintenance !== 'object' || Array.isArray(maintenance)
        || (Object.prototype.hasOwnProperty.call(maintenance, 'rules') && !Array.isArray(maintenance.rules))) {
      throw new Error('Maintenance schedule is not configured correctly.');
    }
    const maintenanceRules = Array.isArray(maintenance.rules)
      ? maintenance.rules
      : Object.keys(maintenance).length ? [maintenance] : [];
    const enabled = value => value === true || ['true', '1'].includes(String(value || '').toLowerCase());
    const inRange = (hour, start, end) => Number.isInteger(start) && Number.isInteger(end) && start !== end
      && (start < end ? hour >= start && hour < end : hour >= start || hour < end);
    const appliesToCourt = (rule, courtId) => {
      const ids = Array.isArray(rule?.courtIds) ? rule.courtIds.map(String).filter(Boolean) : [];
      return ids.length === 0 || ids.includes(String(courtId));
    };
    const dayOfWeek = value => new Date(`${value}T12:00:00Z`).getUTCDay();
    const maintenanceMatch = (rule, hour, courtId) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        throw new Error('Maintenance schedule is not configured correctly.');
      }
      if (!['true', 'false', '1', '0'].includes(String(rule.enabled ?? false).toLowerCase())) {
        throw new Error('Maintenance schedule is not configured correctly.');
      }
      if (!enabled(rule.enabled)) return false;
      const start = Number(rule.start), end = Number(rule.end);
      const mode = String(rule.mode || 'specific').toLowerCase();
      if (!Number.isInteger(start) || start < 0 || start > 23 || !Number.isInteger(end)
          || end < 0 || end > 24 || start === end || !['specific', 'weekly', 'monthly'].includes(mode)
          || (Object.prototype.hasOwnProperty.call(rule, 'courtIds') && !Array.isArray(rule.courtIds))) {
        throw new Error('Maintenance schedule is not configured correctly.');
      }
      if (!inRange(hour, start, end) || !appliesToCourt(rule, courtId)) return false;
      if (mode === 'specific') {
        if (!Array.isArray(rule.dates)) throw new Error('Maintenance schedule is not configured correctly.');
        return rule.dates.map(String).includes(requestedDate);
      }
      if (mode === 'weekly') {
        if (!Array.isArray(rule.recurring?.days)) throw new Error('Maintenance schedule is not configured correctly.');
        const days = rule.recurring.days.map(Number);
        if (days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
          throw new Error('Maintenance schedule is not configured correctly.');
        }
        return days.includes(dayOfWeek(requestedDate));
      }
      const monthlyDay = Number(rule.recurring?.day);
      if (!Number.isInteger(monthlyDay) || monthlyDay < 1 || monthlyDay > 31) {
        throw new Error('Maintenance schedule is not configured correctly.');
      }
      return monthlyDay === Number(requestedDate.slice(8, 10));
    };
    const bookingOccupiesSlot = booking => {
      if (['cancelled', 'forfeited'].includes(String(booking?.status || '').toLowerCase())) return false;
      const placeholder = String(booking?.email || '').trim().toLowerCase() === 'reserve@hold.internal'
        && ['reserving...', 'reserving…'].includes(String(booking?.fullName ?? booking?.full_name ?? '').trim().toLowerCase());
      const createdMs = new Date(booking?.createdAt ?? booking?.created_at ?? '').getTime();
      return !(String(booking?.status || '').toLowerCase() === 'verifying' && placeholder
        && Number.isFinite(createdMs) && Date.now() - createdMs >= PB_RESERVATION_HOLD_MINUTES * 60 * 1000);
    };
    const labels = {
      closed: 'Closed', reserved: 'Reserved', blocked: 'Blocked', private: 'Private Event',
      group: 'Group Session', openplay: 'Open Play', maintenance: 'Maintenance',
    };
    const hourLabel = value => {
      const hour = ((Number(value) % 24) + 24) % 24;
      return `${hour % 12 || 12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
    };
    const selected = new Set(requestedCourtIds);
    const courts = (db.courts || []).filter(court => !court.blocked && (!selected.size || selected.has(String(court.id))));
    if (!courts.length || (selected.size && courts.length !== selected.size)) {
      throw new Error('One or more selected courts are unavailable.');
    }
    const blockedDate = (db.blockedDates || []).map(String).includes(requestedDate);
    const currentHour = Number(phParts.hour);
    const snapshotCourts = courts.sort((a, b) => String(a.id).localeCompare(String(b.id))).map(court => {
      const occupied = new Set((db.bookings || [])
        .filter(booking => String(booking.courtId ?? booking.court_id) === String(court.id)
          && String(booking.date) === requestedDate
          && !excludedBookingRefs.has(String(booking.ref || '').trim())
          && bookingOccupiesSlot(booking))
        .flatMap(booking => booking.slots || []).map(Number).filter(Number.isInteger));
      const slots = [];
      for (let hour = openHour; hour < closeHour; hour += 1) {
        let reason = null;
        let label = 'Available';
        if (requestedDate < PB_PUBLIC_COURT_OPENING_DATE) { reason = 'pre_opening'; label = 'Not open yet'; }
        else if (blockedDate) { reason = 'blocked_date'; label = 'Closed'; }
        else if (requestedDate === phToday && hour < currentHour) { reason = 'past'; label = 'Past'; }
        else if (requestedDate === phToday && hour === currentHour) { reason = 'current'; label = 'In progress'; }
        else if (occupied.has(hour)) { reason = 'booked'; label = 'Booked'; }
        else {
          const rule = maintenanceRules.find(item => maintenanceMatch(item, hour, court.id));
          if (rule) { reason = 'maintenance'; label = labels[String(rule.label || 'maintenance').toLowerCase()] || 'Maintenance'; }
        }
        slots.push({ hour, startHour: hour, endHour: hour + 1, startLabel: hourLabel(hour),
          endLabel: hourLabel(hour + 1), state: reason ? 'unavailable' : 'free', reason, label });
      }
      const availableCount = slots.filter(slot => slot.state === 'free').length;
      return { id: String(court.id), name: String(court.name), availableCount, totalSlots: slots.length, slots };
    });
    const asOf = `${phToday}T${phParts.hour}:${phParts.minute}:${phParts.second}.000+08:00`;
    return _pbNormalizeAvailabilityGraphicSnapshot({
      version: 1, date: requestedDate, timezone: 'Asia/Manila', asOf,
      openHour, closeHour, courts: snapshotCourts,
    }, requestedDate, requestedCourtIds);
  }

  function buildLocalAdminRescheduleOptions(ref, date) {
    const session = window.Auth?.getSession?.();
    if (!session || !['owner','court_owner','staff'].includes(session.role)
        || (session.status && session.status !== 'active')) {
      throw new Error('An active dashboard account is required.');
    }
    _pbAssertPublicBookingDate(date);
    const db = readDb();
    const booking = db.bookings.find(row => String(row.ref) === String(ref));
    if (!booking) throw new Error('Booking not found.');
    if (!['confirmed','pending','verifying'].includes(booking.status)) throw new Error('Only an active booking can be rescheduled.');
    if ((db.bookingRescheduleRequests || []).some(request => request.status === 'pending'
        && (request.selectedBookingRefs || request.selected_booking_refs || request.itemRefs || [])
          .map(String).includes(String(ref)))) {
      throw new Error('Review the pending reschedule request before moving this booking.');
    }
    if (!Array.isArray(booking.slots) || booking.slots.some(hour =>
      !/^(?:[0-9]|1[0-9]|2[0-3])$/.test(String(hour)))) {
      throw new Error('The original booking has invalid time slots.');
    }
    const oldSlots = booking.slots.map(Number).sort((a,b) => a-b);
    const duration = oldSlots.length;
    if (!duration || duration > 24 || oldSlots.some((hour,index) => !Number.isInteger(hour)
        || hour < 0 || hour > 23 || (index && hour !== oldSlots[index-1]+1))
        || Number(booking.duration ?? duration) !== duration) {
      throw new Error('The original booking must have a continuous, valid duration.');
    }
    const courtId = String(booking.courtId || booking.court_id || '');
    const snapshot = buildLocalAvailabilityGraphic(date,[courtId],{guestSafe:true,excludeBookingRefs:[String(ref)]});
    const court = snapshot.courts.find(row => row.id === courtId);
    const starts = [];
    for (let hour=snapshot.openHour;hour+duration<=snapshot.closeHour;hour++) {
      if (date === booking.date && hour === oldSlots[0]) continue;
      if (Array.from({length:duration},(_,index) => hour+index)
          .every(slot => court?.slots.some(item => item.hour === slot && item.state === 'free'))) starts.push(hour);
    }
    return {bookingRef:String(ref),courtId,date,duration,starts,oldDate:booking.date,oldSlots};
  }

  const localRescheduleNotificationSummary = () => ({
    pending: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
    retryable: 0,
    exhausted: 0,
  });

  const localRescheduleCutoffHours = db => {
    const configured = Number(db?.settings?.reschedule_cutoff_hours ?? 24);
    return Number.isInteger(configured) ? Math.max(1, Math.min(configured, 720)) : 24;
  };

  const localRescheduleCooldownSeconds = db => {
    const configured = Number(db?.settings?.reschedule_submission_cooldown_seconds ?? 15);
    return Number.isInteger(configured) ? Math.max(5, Math.min(configured, 300)) : 15;
  };

  const localRescheduleFamilyKey = booking => [
    booking?.groupRef,
    booking?.bookingGroupRef,
    booking?.booking_group_ref,
    booking?.ref,
  ].map(value => String(value || '').trim()).find(Boolean) || '';

  function applyLocalAdminGroupedReschedule(ref, changes) {
    const session = window.Auth?.getSession?.();
    if (!session || !['owner','court_owner','staff'].includes(session.role)
        || (session.status && session.status !== 'active')) {
      throw new Error('An active dashboard account is required.');
    }
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 8) {
      throw new Error('Choose between 1 and 8 booking items to reschedule.');
    }
    const db = readDb();
    const anchorRef = String(ref || '').trim();
    const anchor = db.bookings.find(row => String(row.ref) === anchorRef);
    if (!anchor) throw new Error('Booking not found.');
    const familyKey = localRescheduleFamilyKey(anchor);
    if (db.bookings.filter(row => localRescheduleFamilyKey(row) === familyKey).length > 8) {
      throw new Error('This booking group has more than 8 items. Review its records before rescheduling.');
    }
    const selected = new Set();
    const targetSlots = new Set();
    const items = changes.map(change => {
      const bookingRef = String(change?.bookingRef || '').trim();
      if (!bookingRef || selected.has(bookingRef)) throw new Error('Choose distinct booking items.');
      selected.add(bookingRef);
      const booking = db.bookings.find(row => String(row.ref) === bookingRef);
      if (!booking || localRescheduleFamilyKey(booking) !== familyKey) {
        throw new Error('All selected items must belong to the same booking group.');
      }
      const options = buildLocalAdminRescheduleOptions(bookingRef, change.date);
      if (!Array.isArray(change.expectedSlots) || change.expectedSlots.some(hour =>
        !['number','string'].includes(typeof hour) || !/^(?:[0-9]|1[0-9]|2[0-3])$/.test(String(hour)))) {
        throw new Error('The original schedule changed. Reopen rescheduling.');
      }
      const expectedSlots = change.expectedSlots.map(Number).sort((a,b) => a-b);
      if (change.expectedDate !== options.oldDate || change.expectedCourtId !== options.courtId
          || JSON.stringify(expectedSlots) !== JSON.stringify(options.oldSlots)) {
        throw new Error('The original schedule changed. Reopen rescheduling.');
      }
      if (!Number.isInteger(change.startHour) || !options.starts.includes(change.startHour)) {
        throw new Error('That time is no longer available. Choose another slot.');
      }
      const slots = Array.from({length:options.duration},(_,index) => change.startHour+index);
      for (const hour of slots) {
        const key = JSON.stringify([options.courtId,change.date,hour]);
        if (targetSlots.has(key)) throw new Error('Selected booking items overlap on the same court. Choose different times.');
        targetSlots.add(key);
      }
      return {bookingRef,courtId:options.courtId,date:change.date,slots,startTime:_fmtBookingHour(change.startHour),
        endTime:_fmtBookingHour(change.startHour+options.duration),duration:options.duration,
        oldDate:options.oldDate,oldSlots:options.oldSlots,oldStartTime:booking.startTime,oldEndTime:booking.endTime};
    });
    // No storage writes occur until every item and destination has passed.
    for (const item of items) {
      const booking = db.bookings.find(row => String(row.ref) === item.bookingRef);
      Object.assign(booking,{date:item.date,slots:item.slots,startTime:item.startTime,
        endTime:item.endTime,duration:item.duration});
    }
    writeDb(db);
    return {bookingRef:anchorRef,items};
  }

  const localRescheduleCourtId = booking => String(
    booking?.courtId ?? booking?.court_id ?? '',
  ).trim();

  const localRescheduleSlots = booking => (Array.isArray(booking?.slots)
    ? booking.slots
      .map(value => /^(?:[0-9]|1[0-9]|2[0-3])$/.test(String(value).trim())
        ? Number(String(value).trim())
        : Number.NaN)
      .filter(Number.isInteger)
      .sort((left, right) => left - right)
    : []);

  const localRescheduleSameSlots = (left, right) => {
    const firstRaw = Array.isArray(left) ? left : [];
    const secondRaw = Array.isArray(right) ? right : [];
    const first = localRescheduleSlots({ slots: left });
    const second = localRescheduleSlots({ slots: right });
    return first.length === firstRaw.length
      && second.length === secondRaw.length
      && new Set(first).size === first.length
      && new Set(second).size === second.length
      && first.length === second.length
      && first.every((hour, index) => hour === second[index]);
  };

  const localRescheduleValidDate = value => {
    const date = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  };

  const localRescheduleMaxDate = () => {
    const maxDate = new Date(`${_pbManilaToday()}T12:00:00Z`);
    maxDate.setUTCDate(maxDate.getUTCDate() + 366);
    return maxDate.toISOString().slice(0, 10);
  };

  const localRescheduleStartMs = booking => {
    const date = String(booking?.date || '').trim();
    const rawSlots = Array.isArray(booking?.slots) ? booking.slots : [];
    const slots = localRescheduleSlots(booking);
    if (!localRescheduleValidDate(date) || !slots.length
        || slots.length !== rawSlots.length || new Set(slots).size !== slots.length) {
      return Number.NaN;
    }
    return Date.parse(`${date}T${String(slots[0]).padStart(2, '0')}:00:00+08:00`);
  };

  const localRescheduleEligibility = (rows, db) => {
    const cutoffHours = localRescheduleCutoffHours(db);
    const starts = (Array.isArray(rows) ? rows : []).map(localRescheduleStartMs);
    const earliestStartMs = starts.length ? Math.min(...starts) : Number.NaN;
    const allConfirmed = rows.length > 0 && rows.every(row =>
      String(row?.status || '').trim().toLowerCase() === 'confirmed'
    );
    return {
      cutoffHours,
      earliestStartMs,
      earliestStart: Number.isFinite(earliestStartMs)
        ? new Date(earliestStartMs).toISOString()
        : null,
      eligible: allConfirmed && Number.isFinite(earliestStartMs)
        && earliestStartMs > Date.now() + cutoffHours * 60 * 60 * 1000,
    };
  };

  function localRescheduleRequestView(request, includePrivate = false) {
    if (!request) return null;
    const oldSchedule = request.oldSchedule ? {
      ...request.oldSchedule,
      items:(request.oldSchedule.items || []).map(item => {
        if (includePrivate) return { ...item };
        const guestItem = { ...(item || {}) };
        delete guestItem.scheduleFingerprint;
        return guestItem;
      }),
    } : request.oldSchedule;
    const payload = {
      ...request,
      oldSchedule,
      requestedSchedule:request.requestedSchedule ? {
        ...request.requestedSchedule,
        items:(request.requestedSchedule.items || []).map(item => ({ ...item })),
      } : request.requestedSchedule,
      canWithdraw:String(request.status || '').toLowerCase() === 'pending',
      decision:{
        reason:request.decision?.reason || null,
        reviewedAt:request.decision?.reviewedAt || null,
        ...(includePrivate ? { reviewedByRole:request.decision?.reviewedByRole || null } : {}),
      },
    };
    if (!includePrivate) {
      delete payload.customer;
      delete payload.canApprove;
      delete payload.canReject;
      delete payload.notification;
      delete payload.events;
      return payload;
    }
    payload.currentItems = oldSchedule?.items || [];
    payload.requestedItems = payload.requestedSchedule?.items || [];
    payload.notification = localRescheduleNotificationSummary();
    return payload;
  }

  window.DB = {
    async getCourts() { return readDb().courts; },
    async getAvailabilityGraphic(date, courtIds = []) {
      return buildLocalAvailabilityGraphic(date, courtIds);
    },
    async getAvailabilityGraphicSnapshot(date, courtIds = []) {
      return this.getAvailabilityGraphic(date, courtIds);
    },
    async saveCourt(court) {
      const db = readDb();
      const row = { ...court, id: String(court.id || localRef('court')).toLowerCase() };
      const idx = db.courts.findIndex(c => String(c.id) === String(row.id));
      if (idx >= 0) db.courts[idx] = { ...db.courts[idx], ...row };
      else db.courts.push(row);
      writeDb(db);
    },
    async deleteCourt(id) {
      const db = readDb();
      db.courts = db.courts.filter(c => String(c.id) !== String(id));
      writeDb(db);
    },

    async getBookings(filters = {}) {
      const opts = filters || {};
      return readDb().bookings
        .filter(b => !opts.date || b.date === opts.date)
        .filter(b => !opts.courtId || String(b.courtId) === String(opts.courtId))
        .filter(b => !opts.hostUserId || String(b.hostUserId) === String(opts.hostUserId))
        .filter(b => !opts.activeOnly || (b.status !== 'cancelled' && b.status !== 'forfeited'))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async getInsightBookings() {
      const session = window.Auth?.getSession?.();
      if (!session || !['owner', 'court_owner'].includes(session.role)) {
        throw new Error('An active owner session is required to load Pickle Street Insights.');
      }
      return readDb().bookings.map(booking => ({
        ref: booking.ref,
        groupRef: booking.groupRef || null,
        courtId: booking.courtId,
        date: booking.date,
        slots: booking.slots || [],
        startTime: booking.startTime,
        endTime: booking.endTime,
        duration: Number(booking.duration || 0),
        status: booking.status,
        paymentStatus: booking.paymentStatus || 'unpaid',
        createdAt: booking.createdAt,
      })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async getMyHostBookings() {
      const session = window.Auth?.getSession?.();
      if (!session || session.role !== 'host' || (session.status && session.status !== 'active')) {
        throw new Error('An active host account is required to load bookings.');
      }
      return readDb().bookings
        .filter(booking => booking.hostBooking && booking.email !== 'reserve@hold.internal')
        .filter(booking => String(booking.hostUserId || booking.createdByUserId || '') === String(session.id || ''))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async markHostBookingGroupFullyPaid(bookingRef) {
      const db = readDb();
      const primary = db.bookings.find(booking => String(booking.ref) === String(bookingRef) || String(booking.groupRef || '') === String(bookingRef));
      if (!primary) throw new Error('Booking not found.');
      const rows = primary.groupRef ? db.bookings.filter(booking => String(booking.groupRef || '') === String(primary.groupRef)) : [primary];
      if (rows.some(booking => !booking.hostBooking || booking.status !== 'confirmed' || !['downpayment_paid', 'paid'].includes(booking.paymentStatus))) {
        throw new Error('Every row must be an active confirmed host booking.');
      }
      const refs = new Set(rows.map(booking => String(booking.ref)));
      const paidAt = new Date().toISOString();
      db.bookings = db.bookings.map(booking => refs.has(String(booking.ref)) ? {
        ...booking, paymentStatus: 'paid', downpayment: booking.total, paidAt: booking.paidAt || paidAt,
      } : booking);
      writeDb(db);
      return { status: 'confirmed', paymentStatus: 'paid', paidAt, refs: [...refs] };
    },
    async restoreForfeitedHostBookingAsFullyPaid(bookingRef, reason) {
      if (String(reason || '').trim().length < 10) throw new Error('Enter a correction reason of at least 10 characters.');
      const db = readDb();
      const primary = db.bookings.find(booking => String(booking.ref) === String(bookingRef) || String(booking.groupRef || '') === String(bookingRef));
      if (!primary) throw new Error('Booking not found.');
      const rows = primary.groupRef ? db.bookings.filter(booking => String(booking.groupRef || '') === String(primary.groupRef)) : [primary];
      if (rows.some(booking => !booking.hostBooking || booking.status !== 'forfeited' || booking.paymentStatus !== 'deposit_retained')) {
        throw new Error('Every row must still be forfeited with its deposit retained.');
      }
      const refs = new Set(rows.map(booking => String(booking.ref)));
      const paidAt = new Date().toISOString();
      db.bookings = db.bookings.map(booking => refs.has(String(booking.ref)) ? {
        ...booking, status: 'confirmed', paymentStatus: 'paid', downpayment: booking.total,
        paidAt: booking.paidAt || paidAt, forfeitedAt: null, forfeitureReason: null,
      } : booking);
      writeDb(db);
      return { status: 'confirmed', paymentStatus: 'paid', paidAt, refs: [...refs] };
    },
    async addBookings(bookings) {
      const batch = Array.isArray(bookings) ? bookings.filter(Boolean) : [];
      if (batch.length < 1 || batch.length > 8) {
        throw new Error('Choose between one and eight booking items.');
      }
      batch.forEach(booking => _pbAssertPublicBookingDate(booking.date));

      const db = readDb();
      const rows = [];
      for (const booking of batch) {
        const existing = [...db.bookings, ...rows]
          .filter(b => String(b.courtId) === String(booking.courtId) && b.date === booking.date && b.status !== 'cancelled' && b.status !== 'forfeited');
        if (hasSlotConflict(existing, booking)) {
          throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
        }
        const row = {
          ...booking,
          ref: booking.ref || localRef('PB'),
          receivedAccount: receivedAccountForBooking(booking),
          createdAt: booking.createdAt || nowIso(),
        };
        rows.push({
          ...row,
          ...localBookingFeeSnapshot(row, db.settings || {}),
        });
      }

      db.bookings.push(...rows);
      writeDb(db);
      return rows.map(row => row.ref);
    },
    async addBooking(booking) {
      return this.addBookings([booking]);
    },

    async releaseBookingHold(ref) {
      const db = readDb();
      const target = db.bookings.find(booking => String(booking.ref) === String(ref));
      if (!target) return ref;
      const groupKey = String(target.groupRef || target.booking_group_ref || target.ref);
      const group = db.bookings.filter(booking =>
        String(booking.groupRef || booking.booking_group_ref || booking.ref) === groupKey
      );
      const safe = group.length > 0 && group.every(booking => {
        const placeholder = String(booking.email || '').trim().toLowerCase() === 'reserve@hold.internal' &&
          /^reserving(?:\.{3}|…)$/i.test(String(booking.fullName || booking.full_name || '').trim()) &&
          String(booking.contactNumber || booking.contact_number || '').trim() === '00000000000';
        const hasEvidence = !!(
          booking.paymentProvider || booking.payment_provider ||
          booking.paymentSessionId || booking.payment_session_id ||
          booking.paymentCheckoutUrl || booking.payment_checkout_url ||
          booking.paymentFlow || booking.payment_flow ||
          booking.gcashRef || booking.gcash_ref ||
          booking.downpayment || booking.paidAt || booking.paid_at ||
          booking.receiptImageUrl || booking.receipt_image_url ||
          booking.receiptImageHash || booking.receipt_image_hash ||
          booking.receiptPhash || booking.receipt_phash ||
          booking.receiptExtracted || booking.receipt_extracted ||
          booking.receiptVerifiedAt || booking.receipt_verified_at ||
          booking.bookingFeeEarnedAt || booking.booking_fee_earned_at ||
          booking.billedAt || booking.billed_at
        );
        return placeholder && !hasEvidence;
      });
      if (!safe) throw new Error('Only an evidence-free temporary hold can be released.');
      const refs = new Set(group.map(booking => String(booking.ref)));
      db.bookings = db.bookings.filter(booking => !refs.has(String(booking.ref)));
      writeDb(db);
      return ref;
    },
    async getBookingByRef(ref) { return readDb().bookings.find(b => String(b.ref) === String(ref)) || null; },
    async getAdminRescheduleOptions(ref, date) { return buildLocalAdminRescheduleOptions(ref,date); },
    async rescheduleBookingsTransaction(ref, changes) { return applyLocalAdminGroupedReschedule(ref,changes); },
    async rescheduleBookingTransaction(ref, schedule) {
      const options = buildLocalAdminRescheduleOptions(ref,schedule?.date);
      const expectedSlots = [...(schedule.expectedSlots || [])].map(Number).sort((a,b) => a-b);
      if (schedule.expectedDate !== options.oldDate || JSON.stringify(expectedSlots) !== JSON.stringify(options.oldSlots)
          || schedule.expectedCourtId !== options.courtId) {
        throw new Error('The original schedule changed. Reopen rescheduling.');
      }
      if (!options.starts.includes(schedule.startHour)) throw new Error('That time is no longer available. Choose another slot.');
      const db = readDb();
      const booking = db.bookings.find(row => String(row.ref) === String(ref));
      const result = {bookingRef:String(ref),date:schedule.date,
        slots:Array.from({length:options.duration},(_,index) => schedule.startHour+index),
        startTime:_fmtBookingHour(schedule.startHour),endTime:_fmtBookingHour(schedule.startHour+options.duration),
        duration:options.duration,oldDate:options.oldDate,oldSlots:options.oldSlots};
      Object.assign(booking,{date:result.date,slots:result.slots,startTime:result.startTime,endTime:result.endTime,duration:result.duration});
      writeDb(db);
      return result;
    },
    async getBookingManagementViewerContext() {
      const session = window.Auth?.getSession?.() || null;
      const active = Boolean(session) && (!session.status || session.status === 'active');
      return {
        isAuthenticated: active,
        isSystemOwner: active && session.role === 'owner',
      };
    },
    async getBookingForManagement(ref, email, options = {}) {
      const requestedRef = String(ref || '').trim().toUpperCase();
      const requestedEmail = String(email || '').trim().toLowerCase();
      const ownerPreview = options?.ownerPreview === true;
      if (ownerPreview) {
        const session = window.Auth?.getSession?.() || null;
        const activeOwner = Boolean(session)
          && session.role === 'owner'
          && (!session.status || session.status === 'active');
        if (!activeOwner) {
          const denied = new Error('An active System Owner account is required.');
          denied.code = 'OWNER_PREVIEW_UNAUTHORIZED';
          throw denied;
        }
      }
      const matchesReference = booking => {
        const rowRef = String(booking.ref || '').trim().toUpperCase();
        const groupRef = String(booking.groupRef || booking.booking_group_ref || '').trim().toUpperCase();
        return rowRef === requestedRef || groupRef === requestedRef || groupRef === `${requestedRef}-G`
          || groupRef.replace(/-G$/, '') === requestedRef;
      };
      const bookings = readDb().bookings || [];
      const anchor = bookings.find(booking => matchesReference(booking)
        && String(booking.email || '').trim().toLowerCase() === requestedEmail);
      if (!anchor) return [];
      const groupRef = String(anchor.groupRef || anchor.booking_group_ref || '');
      return bookings
        .filter(booking => String(booking.email || '').trim().toLowerCase() === requestedEmail)
        .filter(booking => groupRef
          ? String(booking.groupRef || booking.booking_group_ref || '') === groupRef
          : String(booking.ref || '') === String(anchor.ref || ''))
        .sort((a, b) => `${a.date || ''}|${a.startTime || ''}|${a.courtName || ''}`
          .localeCompare(`${b.date || ''}|${b.startTime || ''}|${b.courtName || ''}`))
        .slice(0, 8)
        .map(booking => ownerPreview
          ? { ...booking, managementAccess: 'owner_preview' }
          : booking);
    },
    async getBookingRescheduleState(ref, email) {
      const rows = await this.getBookingForManagement(ref, email);
      if (!rows.length) throw new Error('Booking not found. Check the reference and booking email.');
      const db = readDb();
      const refs = new Set(rows.map(row => String(row.ref)));
      const request = db.bookingRescheduleRequests
        .filter(item => (item.itemRefs || []).some(itemRef => refs.has(String(itemRef))))
        .sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
      const eligibility = localRescheduleEligibility(rows, db);
      const confirmed = rows.filter(row => String(row.status || '').toLowerCase() === 'confirmed').length;
      const bookingRef = String(ref || '').trim().toUpperCase();
      return {
        ok:true,
        booking:{
          ref:bookingRef,
          bookingRef,
          bookingGroupRef:[rows[0]?.groupRef, rows[0]?.bookingGroupRef, rows[0]?.booking_group_ref]
            .map(value => String(value || '').trim()).find(Boolean) || null,
          status:confirmed === rows.length ? 'confirmed' : 'mixed',
          items:rows.map(row => ({
            ref:row.ref,
            courtId:localRescheduleCourtId(row),
            courtName:row.courtName,
            date:row.date,
            slots:localRescheduleSlots(row).map(String),
            startTime:row.startTime,
            endTime:row.endTime,
            duration:Number(row.duration ?? row.slots?.length ?? 0),
            rate:Number(row.rate || 0),
            total:Number(row.total || 0),
            status:row.status,
            paymentStatus:row.paymentStatus,
          })),
          reschedule:{
            eligible:eligibility.eligible,
            cutoffHours:eligibility.cutoffHours,
            earliestStart:eligibility.earliestStart,
            slotIsHeldWhilePending:false,
            refundAvailable:false,
          },
        },
        request:localRescheduleRequestView(request),
      };
    },
    async getBookingRescheduleOptions(ref, email, itemRefs, date) {
      const requestedDate = String(date || '').trim();
      if (!localRescheduleValidDate(requestedDate)) throw new Error('Choose a valid schedule date.');
      _pbAssertPublicBookingDate(requestedDate);
      if (requestedDate > localRescheduleMaxDate()) {
        throw new Error('Availability is limited to the next 366 Manila calendar days.');
      }
      const rows = await this.getBookingForManagement(ref, email);
      const selectedRefs = [...new Set((Array.isArray(itemRefs) ? itemRefs : [])
        .map(value => String(value || '').trim()).filter(Boolean))].sort();
      const selected = rows.filter(row => selectedRefs.includes(String(row.ref))).sort((left, right) =>
        `${left.courtName || ''}|${left.ref || ''}`.localeCompare(`${right.courtName || ''}|${right.ref || ''}`)
      );
      if (!selected.length || selected.length !== selectedRefs.length || selected.length > 8) {
        throw new Error('Choose between one and eight valid booking items to reschedule.');
      }
      const db = readDb();
      const eligibility = localRescheduleEligibility(selected, db);
      if (!eligibility.eligible) {
        throw _pbApiError(
          `Only confirmed bookings more than ${eligibility.cutoffHours} hours away can be rescheduled.`,
          'RESCHEDULE_NOT_ELIGIBLE',
        );
      }
      const durations = [...new Set(selected.map(row => {
        const slots = localRescheduleSlots(row);
        const duration = Number(row.duration ?? slots.length);
        return Number.isInteger(duration) && duration === slots.length ? duration : Number.NaN;
      }))];
      if (durations.length !== 1 || !Number.isInteger(durations[0]) || durations[0] < 1) {
        throw new Error('Selected booking items must have the same valid duration.');
      }
      const selectedCourtIds = selected.map(localRescheduleCourtId);
      if (selectedCourtIds.some(courtId => !courtId)
          || new Set(selectedCourtIds).size !== selected.length) {
        throw new Error('Select no more than one booking item for each court.');
      }
      const duration = durations[0];
      const snapshot = buildLocalAvailabilityGraphic(requestedDate, selectedCourtIds, {
        guestSafe:true,
        excludeBookingRefs:selectedRefs,
      });
      const courtMap = new Map((snapshot.courts || []).map(court => [String(court.id), court]));
      const options = [];
      for (let hour = Number(snapshot.openHour || 8); hour + duration <= Number(snapshot.closeHour || 24); hour += 1) {
        const hours = Array.from({ length:duration }, (_, index) => hour + index);
        const available = selected.every(row => {
          const court = courtMap.get(localRescheduleCourtId(row));
          return hours.every(slotHour => (court?.slots || [])
            .some(slot => Number(slot.hour) === slotHour && slot.state === 'free'));
        });
        options.push({
          date:requestedDate,
          startTime:_fmtBookingHour(hour),
          endTime:_fmtBookingHour(hour + duration),
          slots:hours.map(String),
          available,
        });
      }
      return {
        ok:true,
        date:requestedDate,
        duration,
        items:selected.map(row => ({ ref:row.ref, courtId:localRescheduleCourtId(row), courtName:row.courtName, duration })),
        slots:Array.from({ length:Number(snapshot.closeHour) - Number(snapshot.openHour) }, (_, index) => {
          const hour = Number(snapshot.openHour) + index;
          const available = selected.every(row => (courtMap.get(localRescheduleCourtId(row))?.slots || [])
            .some(slot => Number(slot.hour) === hour && slot.state === 'free'));
          return {
            hour,
            label:`${_fmtBookingHour(hour)}–${_fmtBookingHour(hour + 1)}`,
            startTime:_fmtBookingHour(hour),
            endTime:_fmtBookingHour(hour + 1),
            available,
          };
        }),
        options,
        slotIsHeldWhilePending:false,
      };
    },
    async submitBookingRescheduleRequest(payload = {}) {
      const rows = await this.getBookingForManagement(payload.bookingRef, payload.email);
      const suppliedRefs = Array.isArray(payload.itemRefs) ? payload.itemRefs : [];
      const itemRefs = [...new Set(suppliedRefs.map(value => String(value || '').trim()).filter(Boolean))].sort();
      const selected = rows.filter(row => itemRefs.includes(String(row.ref))).sort((left, right) =>
        `${left.courtName || ''}|${left.ref || ''}`.localeCompare(`${right.courtName || ''}|${right.ref || ''}`)
      );
      if (!itemRefs.length || itemRefs.length > 8 || itemRefs.length !== suppliedRefs.length
          || selected.length !== itemRefs.length) {
        throw new Error('One or more selected booking items are invalid.');
      }
      if (payload.acknowledgedNoRefund !== true || payload.acknowledgedSlotNotHeld !== true) {
        throw new Error('Confirm both request acknowledgements.');
      }
      const requestedDate = String(payload.requestedDate || '').trim();
      if (!localRescheduleValidDate(requestedDate)) throw new Error('Choose a valid schedule date.');
      _pbAssertPublicBookingDate(requestedDate);
      if (requestedDate > localRescheduleMaxDate()) {
        throw new Error('Availability is limited to the next 366 Manila calendar days.');
      }
      const suppliedSlots = Array.isArray(payload.requestedSlots) ? payload.requestedSlots : [];
      if (!suppliedSlots.length || suppliedSlots.length > 24
          || suppliedSlots.some(value => !/^(?:[0-9]|1[0-9]|2[0-3])$/.test(String(value).trim()))) {
        throw new Error('Choose a valid available schedule.');
      }
      const requestedSlots = [...new Set(suppliedSlots.map(value => Number(String(value).trim())))]
        .sort((left, right) => left - right);
      if (requestedSlots.length !== suppliedSlots.length
          || requestedSlots.some((hour,index) => index > 0 && hour !== requestedSlots[index-1] + 1)) {
        throw new Error('Choose one continuous schedule with no duplicate time slots.');
      }
      const cleanNote = String(payload.note || '').trim();
      if (cleanNote.length > 500) throw new Error('The request note must be 500 characters or less.');

      const db = readDb();
      const groupKey = localRescheduleFamilyKey(selected[0]);
      const existingPending = db.bookingRescheduleRequests.find(item => {
        if (String(item.status || '').toLowerCase() !== 'pending') return false;
        const existingGroup = String(
          item.bookingFamilyKey || item.bookingGroupRef
          || item.oldSchedule?.bookingGroupRef || item.bookingRef || '',
        ).trim();
        return groupKey && existingGroup === groupKey;
      });

      const existingItemRefs = [...(existingPending?.itemRefs || [])].map(String).sort();
      if (existingPending
          && existingItemRefs.length === itemRefs.length
          && existingItemRefs.every((value, index) => value === itemRefs[index])
          && String(existingPending.requestedSchedule?.requestedDate || '') === requestedDate
          && localRescheduleSameSlots(existingPending.requestedSchedule?.requestedSlots, requestedSlots)
          && String(existingPending.note || '').trim() === cleanNote) {
        return { ok:true, idempotent:true, request:localRescheduleRequestView(existingPending) };
      }

      const cooldownSeconds = localRescheduleCooldownSeconds(db);
      const latestSubmissionAt = Math.max(...db.bookingRescheduleRequests
        .filter(item => {
          const itemGroup = String(
            item.bookingFamilyKey || item.bookingGroupRef
            || item.oldSchedule?.bookingGroupRef || item.bookingRef || '',
          ).trim();
          return itemGroup === groupKey;
        })
        .map(item => Date.parse(item.createdAt || ''))
        .filter(Number.isFinite), Number.NEGATIVE_INFINITY);
      if (Number.isFinite(latestSubmissionAt)
          && latestSubmissionAt > Date.now() - cooldownSeconds * 1000) {
        const retryAfterSeconds = Math.max(1, Math.ceil(
          (latestSubmissionAt + cooldownSeconds * 1000 - Date.now()) / 1000,
        ));
        const error = _pbApiError(
          `Please wait ${retryAfterSeconds} seconds before changing this request again.`,
          'TOO_MANY_REQUESTS',
        );
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
      }

      const eligibility = localRescheduleEligibility(selected, db);
      if (!eligibility.eligible) {
        throw _pbApiError(
          `Only confirmed bookings more than ${eligibility.cutoffHours} hours away can be rescheduled.`,
          'RESCHEDULE_NOT_ELIGIBLE',
        );
      }
      const durations = [...new Set(selected.map(row => {
        const slots = localRescheduleSlots(row);
        const duration = Number(row.duration ?? slots.length);
        return Number.isInteger(duration) && duration === slots.length ? duration : Number.NaN;
      }))];
      if (durations.length !== 1 || !Number.isInteger(durations[0]) || durations[0] < 1) {
        throw new Error('Selected booking items must have the same valid duration.');
      }
      const duration = durations[0];
      if (requestedSlots.length !== duration) {
        throw new Error('Choose one continuous schedule with the original duration.');
      }
      const selectedCourtIds = selected.map(localRescheduleCourtId);
      if (selectedCourtIds.some(courtId => !courtId)
          || new Set(selectedCourtIds).size !== selected.length) {
        throw new Error('Select no more than one booking item for each court.');
      }
      const unchangedCount = selected.filter(row =>
        String(row.date || '') === requestedDate
        && localRescheduleSameSlots(row.slots, requestedSlots)
      ).length;
      if (unchangedCount === selected.length) {
        throw new Error('Choose a schedule different from the current booking.');
      }

      const availability = buildLocalAvailabilityGraphic(requestedDate, selectedCourtIds, {
        guestSafe:true,
        excludeBookingRefs:itemRefs,
      });
      const availabilityByCourt = new Map((availability.courts || [])
        .map(court => [String(court.id), court]));
      for (const row of selected) {
        const court = availabilityByCourt.get(localRescheduleCourtId(row));
        const allAvailable = requestedSlots.every(hour => (court?.slots || [])
          .some(slot => Number(slot.hour) === hour && slot.state === 'free'));
        if (!allAvailable) throw _pbApiError(
          'One or more requested slots are no longer available.',
          'SLOT_UNAVAILABLE',
        );
      }

      const createdAt = new Date().toISOString();
      if (existingPending) {
        existingPending.status = 'superseded';
        existingPending.canApprove = false;
        existingPending.canReject = false;
        existingPending.canWithdraw = false;
        existingPending.supersededAt = createdAt;
        existingPending.updatedAt = createdAt;
        existingPending.decision = {
          ...(existingPending.decision || {}),
          reason:'Replaced by a newer player request.',
          reviewedAt:createdAt,
          reviewedByRole:null,
        };
        existingPending.events = [
          ...(existingPending.events || []),
          { id:localRef('event'), eventType:'superseded', createdAt },
        ];
        existingPending.notification = localRescheduleNotificationSummary();
      }
      const request = {
        id:globalThis.crypto?.randomUUID?.() || localRef('reschedule'),
        bookingRef:String(payload.bookingRef || '').trim().toUpperCase(),
        bookingGroupRef:selected[0].groupRef || selected[0].bookingGroupRef || selected[0].booking_group_ref || null,
        bookingFamilyKey:groupKey,
        itemRefs,
        customer:{ name:selected[0].fullName || 'Player', email:String(selected[0].email || '').toLowerCase() },
        status:'pending',
        note:cleanNote,
        oldSchedule:{ bookingRef:String(payload.bookingRef || ''), bookingGroupRef:selected[0].groupRef || selected[0].bookingGroupRef || selected[0].booking_group_ref || null, capturedAt:createdAt, items:selected.map(row => ({ ref:row.ref,courtId:localRescheduleCourtId(row),courtName:row.courtName,date:row.date,slots:localRescheduleSlots(row).map(String),startTime:row.startTime,endTime:row.endTime,duration:Number(row.duration ?? row.slots?.length ?? 0),rate:Number(row.rate || 0),total:Number(row.total || 0),status:row.status,scheduleFingerprint:JSON.stringify([localRescheduleCourtId(row),row.date,localRescheduleSlots(row),Number(row.duration ?? row.slots?.length ?? 0),Number(row.rate || 0),Number(row.total || 0),String(row.status || '')]) })) },
        requestedSchedule:{ requestedDate,requestedSlots:requestedSlots.map(String),startTime:_fmtBookingHour(requestedSlots[0]),endTime:_fmtBookingHour(requestedSlots[requestedSlots.length-1] + 1),duration,items:selected.map(row => ({ ref:row.ref,courtId:localRescheduleCourtId(row),courtName:row.courtName,date:requestedDate,slots:requestedSlots.map(String),startTime:_fmtBookingHour(requestedSlots[0]),endTime:_fmtBookingHour(requestedSlots[requestedSlots.length-1] + 1),duration,rate:Number(row.rate || 0),total:Number(row.total || 0) })) },
        acknowledgements:{ noRefund:true, slotNotHeld:true },
        decision:{ reason:null, reviewedAt:null, reviewedByRole:null },
        createdAt,
        updatedAt:createdAt,
        canApprove:true,
        canReject:true,
        canWithdraw:true,
        notification:localRescheduleNotificationSummary(),
        events:[{ id:localRef('event'), eventType:'submitted', createdAt }],
      };
      db.bookingRescheduleRequests.push(request);
      writeDb(db);
      this.dispatchBookingRescheduleNotifications({ requestId:request.id, allowFailure:true }).catch(() => {});
      return { ok:true, request:localRescheduleRequestView(request) };
    },
    async withdrawBookingRescheduleRequest(payload = {}) {
      const rows = await this.getBookingForManagement(payload.bookingRef, payload.email);
      const ownedRefs = new Set(rows.map(row => String(row.ref || '')));
      const normalizedEmail = String(payload.email || '').trim().toLowerCase();
      const db = readDb();
      const request = db.bookingRescheduleRequests.find(item => String(item.id) === String(payload.requestId));
      const ownsRequest = request
        && String(request?.customer?.email || '').trim().toLowerCase() === normalizedEmail
        && (request.itemRefs || []).some(itemRef => ownedRefs.has(String(itemRef)));
      if (!ownsRequest || request.status !== 'pending') throw new Error('This request can no longer be withdrawn.');
      request.status = 'withdrawn';
      request.canApprove = false;
      request.canReject = false;
      request.canWithdraw = false;
      request.updatedAt = new Date().toISOString();
      request.withdrawnAt = request.updatedAt;
      request.decision = {
        reason:'Withdrawn by the player before review.',
        reviewedAt:null,
        reviewedByRole:null,
      };
      request.events = [...(request.events || []), { id:localRef('event'), eventType:'withdrawn', createdAt:request.updatedAt }];
      request.notification = localRescheduleNotificationSummary();
      writeDb(db);
      return { ok:true, request:localRescheduleRequestView(request) };
    },
    async listBookingRescheduleRequests(status = null, limit = 100) {
      const session = window.Auth?.getSession?.() || null;
      if (!session || !['owner','court_owner'].includes(String(session.role || '')) || (session.status && session.status !== 'active')) throw new Error('Only an active owner can review schedule requests.');
      const db = readDb();
      const normalizedStatus = String(status || '').toLowerCase();
      const all = [...db.bookingRescheduleRequests].sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const safeLimit = Math.max(1,Math.min(Number(limit)||100,200));
      const requests = (normalizedStatus && normalizedStatus !== 'all'
        ? all.filter(item => String(item.status) === normalizedStatus)
        : all)
        .slice(0,safeLimit)
        .map(item => localRescheduleRequestView(item, true));
      const pendingRequests = all
        .filter(item => String(item.status || '').toLowerCase() === 'pending')
        .slice(0,safeLimit)
        .map(item => localRescheduleRequestView(item, true));
      const historyRequests = all
        .filter(item => String(item.status || '').toLowerCase() !== 'pending')
        .slice(0,safeLimit)
        .map(item => localRescheduleRequestView(item, true));
      const counts = all.reduce((out,item) => { const key=String(item.status || 'pending'); out[key]=(out[key]||0)+1; return out; }, { pending:0,approved:0,rejected:0,withdrawn:0,conflicted:0,superseded:0 });
      return { ok:true, counts, requests, pendingRequests, historyRequests };
    },
    async getBookingRescheduleRequest(requestId) {
      const result = await this.listBookingRescheduleRequests(null,250);
      const request = result.requests.find(item => String(item.id) === String(requestId));
      if (!request) throw new Error('Schedule request not found.');
      return { ok:true, request, events:[...(request.events || [])] };
    },
    async reviewBookingRescheduleRequest(requestId, decision, reason = '') {
      const session = window.Auth?.getSession?.() || null;
      if (!session || !['owner','court_owner'].includes(String(session.role || '')) || (session.status && session.status !== 'active')) throw new Error('Only an active owner can review schedule requests.');
      const db = readDb();
      const request = db.bookingRescheduleRequests.find(item => String(item.id) === String(requestId));
      if (!request || request.status !== 'pending') throw new Error('This request is no longer pending.');
      const normalizedDecision = String(decision || '').toLowerCase();
      const note = String(reason || '').trim();
      if (!['approved','rejected'].includes(normalizedDecision)) throw new Error('Choose approve or decline.');
      if (note.length > 500) throw new Error('The decision note must be 500 characters or less.');
      if (normalizedDecision === 'rejected' && note.length < 5) throw new Error('Enter a clear reason before declining.');

      const markConflicted = (decisionReason, errorMessage) => {
        const reviewedAt = new Date().toISOString();
        request.status = 'conflicted';
        request.canApprove = false;
        request.canReject = false;
        request.canWithdraw = false;
        request.updatedAt = reviewedAt;
        request.conflictedAt = reviewedAt;
        request.decision = {
          reason:decisionReason,
          reviewedAt,
          reviewedByRole:session.role,
        };
        request.events = [
          ...(request.events || []),
          {
            id:localRef('event'),
            eventType:'conflicted',
            fromStatus:'pending',
            toStatus:'conflicted',
            createdAt:reviewedAt,
          },
        ];
        request.notification = localRescheduleNotificationSummary();
        writeDb(db);
        return {
          ok:false,
          code:'SLOT_CONFLICT',
          error:errorMessage,
          request:localRescheduleRequestView(request, true),
        };
      };

      if (normalizedDecision === 'approved') {
        const refs = new Set((request.itemRefs || []).map(String));
        const oldByRef = new Map((request.oldSchedule?.items || []).map(item => [String(item.ref),item]));
        const expectedFamilyKey = String(
          request.bookingFamilyKey || request.bookingGroupRef
          || request.oldSchedule?.bookingGroupRef || request.bookingRef || '',
        ).trim();
        if (!refs.size || refs.size > 8 || oldByRef.size !== refs.size) {
          return markConflicted(
            'The saved request evidence is incomplete. Nothing was moved.',
            'The saved request no longer has a complete booking selection.',
          );
        }
        for (const ref of refs) {
          const current = db.bookings.find(row => String(row.ref) === ref);
          const old = oldByRef.get(ref);
          const currentDuration = Number(current?.duration ?? current?.slots?.length ?? 0);
          const oldDuration = Number(old?.duration ?? old?.slots?.length ?? 0);
          const customerEmail = String(request.customer?.email || '').trim().toLowerCase();
          const currentEmail = String(current?.email || '').trim().toLowerCase();
          const snapshotMatches = current && old
            && String(current.status || '').toLowerCase() === 'confirmed'
            && localRescheduleCourtId(current) === String(old.courtId || '')
            && String(current.date || '') === String(old.date || '')
            && localRescheduleSameSlots(current.slots, old.slots)
            && Number.isInteger(currentDuration) && currentDuration === oldDuration
            && currentDuration === localRescheduleSlots(current).length
            && Number(current.rate || 0) === Number(old.rate || 0)
            && Number(current.total || 0) === Number(old.total || 0)
            && (!customerEmail || currentEmail === customerEmail)
            && (!expectedFamilyKey || localRescheduleFamilyKey(current) === expectedFamilyKey);
          if (!snapshotMatches) {
            return markConflicted(
              'The original booking changed after this request was submitted. Nothing was moved.',
              'The current booking changed after this request was submitted.',
            );
          }
        }

        const eligibility = localRescheduleEligibility(
          db.bookings.filter(row => refs.has(String(row.ref))),
          db,
        );
        if (!eligibility.eligible) {
          return markConflicted(
            `The original booking is now inside the ${eligibility.cutoffHours}-hour reschedule cutoff. Nothing was moved.`,
            'The booking is now too close to its start time to reschedule.',
          );
        }

        const requestedItems = Array.isArray(request.requestedSchedule?.items)
          ? request.requestedSchedule.items
          : [];
        const requestedByRef = new Map(requestedItems.map(item => [String(item.ref),item]));
        const requestedDate = String(request.requestedSchedule?.requestedDate || '').trim();
        const requestedRawSlots = Array.isArray(request.requestedSchedule?.requestedSlots)
          ? request.requestedSchedule.requestedSlots
          : [];
        const requestedSlots = localRescheduleSlots({
          slots:requestedRawSlots,
        });
        const requestedEvidenceValid = requestedItems.length === refs.size
          && requestedByRef.size === refs.size
          && localRescheduleValidDate(requestedDate)
          && requestedDate >= _pbMinimumPublicBookingDate()
          && requestedDate <= localRescheduleMaxDate()
          && requestedSlots.length > 0
          && requestedSlots.length <= 24
          && requestedSlots.length === requestedRawSlots.length
          && new Set(requestedSlots).size === requestedSlots.length
          && requestedSlots.every((hour, index) => index === 0 || hour === requestedSlots[index - 1] + 1)
          && [...refs].every(ref => {
            const old = oldByRef.get(ref);
            const requested = requestedByRef.get(ref);
            return requested && old
              && String(requested.date || '') === requestedDate
              && localRescheduleSameSlots(requested.slots, requestedSlots)
              && localRescheduleCourtId(requested) === String(old.courtId || '')
              && Number(requested.duration ?? requested.slots?.length ?? 0) === Number(old.duration ?? old.slots?.length ?? 0)
              && Number(requested.duration ?? requested.slots?.length ?? 0) === requestedSlots.length
              && Number(requested.rate || 0) === Number(old.rate || 0)
              && Number(requested.total || 0) === Number(old.total || 0);
          });
        if (!requestedEvidenceValid
            || new Set(requestedItems.map(localRescheduleCourtId)).size !== requestedItems.length) {
          return markConflicted(
            'The saved requested schedule is no longer valid. Nothing was moved.',
            'The saved requested schedule is invalid.',
          );
        }

        const noScheduleChange = [...refs].every(ref => {
          const current = db.bookings.find(row => String(row.ref) === ref);
          const requested = requestedByRef.get(ref);
          return String(current?.date || '') === String(requested?.date || '')
            && localRescheduleSameSlots(current?.slots, requested?.slots);
        });
        if (noScheduleChange) {
          return markConflicted(
            'The requested schedule is identical to the current reservation. Nothing was moved.',
            'The request does not change the booking schedule.',
          );
        }

        const availability = buildLocalAvailabilityGraphic(
          requestedDate,
          requestedItems.map(localRescheduleCourtId),
          { guestSafe:true, excludeBookingRefs:[...refs] },
        );
        const availabilityByCourt = new Map((availability.courts || [])
          .map(court => [String(court.id), court]));
        const unavailable = requestedItems.some(item => {
          const court = availabilityByCourt.get(localRescheduleCourtId(item));
          return requestedSlots.some(hour => !(court?.slots || [])
            .some(slot => Number(slot.hour) === hour && slot.state === 'free'));
        });
        if (unavailable) {
          return markConflicted(
            'The requested schedule is no longer available. Nothing was moved.',
            'A requested slot was booked or blocked after this request was submitted.',
          );
        }

        db.bookings = db.bookings.map(row => {
          const requested = requestedByRef.get(String(row.ref));
          return requested ? { ...row,date:requested.date,slots:[...(requested.slots || [])].map(Number),startTime:requested.startTime,endTime:requested.endTime,duration:Number(requested.duration || requested.slots?.length || row.duration) } : row;
        });
      }
      request.status = normalizedDecision;
      request.canApprove = false;
      request.canReject = false;
      request.canWithdraw = false;
      request.updatedAt = new Date().toISOString();
      request.reviewedAt = request.updatedAt;
      if (normalizedDecision === 'approved') request.approvedAt = request.updatedAt;
      else request.rejectedAt = request.updatedAt;
      request.decision = {
        reason:note || (normalizedDecision === 'approved' ? 'Approved by Pickle Street.' : null),
        reviewedAt:request.updatedAt,
        reviewedByRole:session.role,
      };
      request.events = [...(request.events || []), { id:localRef('event'),eventType:normalizedDecision,createdAt:request.updatedAt }];
      request.notification = localRescheduleNotificationSummary();
      writeDb(db);
      return { ok:true, request:localRescheduleRequestView(request, true) };
    },
    async dispatchBookingRescheduleNotifications() { return { ok:true,skipped:true,reason:'Local data mode' }; },
    async updateBooking(ref, updates) {
      if (updates.date !== undefined) _pbAssertPublicBookingDate(updates.date);
      const db = readDb();
      let updated = false;
      db.bookings = db.bookings.map(b => {
        if (String(b.ref) !== String(ref)) return b;
        updated = true;
        const next = { ...b, ...updates };
        if (updates.receivedAccount === undefined && updates.paymentMethod !== undefined) {
          next.receivedAccount = receivedAccountForBooking(next);
        }
        if (!next.receivedAccount) next.receivedAccount = receivedAccountForBooking(next);
        return next;
      });
      if (!updated) {
        const missing = new Error(`Booking ${ref} was not updated because it no longer exists.`);
        missing.code = 'BOOKING_UPDATE_NOT_ALLOWED';
        throw missing;
      }
      writeDb(db);
    },
    async confirmBookingTransaction(ref) {
      const bookingRef = String(ref || '').trim();
      if (!bookingRef) throw new Error('A booking reference is required.');

      const session = window.Auth?.getSession?.() || null;
      if (!session || !['owner', 'court_owner'].includes(String(session.role || '')) ||
          (session.status && session.status !== 'active')) {
        throw new Error('Only an active owner or court owner can confirm a booking payment.');
      }

      const db = readDb();
      const target = db.bookings.find(booking => String(booking.ref) === bookingRef);
      if (!target) throw new Error('Booking not found.');

      const groupRef = String(target.groupRef || target.bookingGroupRef || '').trim();
      const items = groupRef
        ? db.bookings.filter(booking =>
            String(booking.groupRef || booking.bookingGroupRef || '').trim() === groupRef)
        : [target];
      const refs = items.map(booking => String(booking.ref)).sort();
      if (!items.length || new Set(refs).size !== refs.length) {
        throw new Error('The logical booking has invalid or duplicate rows.');
      }

      const lowerValue = value => String(value || '').toLowerCase().trim();
      const singleValue = (values, message) => {
        const unique = [...new Set(values)];
        if (unique.length !== 1) throw new Error(message);
        return unique[0];
      };
      const bookingStatus = singleValue(
        items.map(item => lowerValue(item.status)),
        'Grouped booking statuses are mixed. Review the booking details before confirming.',
      );
      const paymentStatus = singleValue(
        items.map(item => lowerValue(item.paymentStatus ?? item.payment_status)),
        'Grouped payment statuses are mixed. Review the payment details before confirming.',
      );
      const hostBooking = singleValue(
        items.map(item => !!(item.hostBooking ?? item.host_booking)),
        'Grouped booking ownership types are mixed. Review the booking details before confirming.',
      );
      const paymentMethod = singleValue(
        items.map(item => lowerValue(item.paymentMethod ?? item.payment_method)),
        'Grouped payment methods are mixed. Review the payment details before confirming.',
      );

      if (['cancelled', 'completed', 'forfeited'].includes(bookingStatus)) {
        throw new Error('This booking is already in a terminal state and cannot be confirmed.');
      }
      if (!['pending', 'verifying', 'confirmed'].includes(bookingStatus)) {
        throw new Error('This booking is not ready for confirmation.');
      }
      if (['failed', 'rejected', 'deposit_retained'].includes(paymentStatus)) {
        throw new Error('This payment is already rejected or otherwise terminal.');
      }
      const supportedMethods = ['cash', ...PB_DIGITAL_PAYMENT_METHODS];
      if (!supportedMethods.includes(paymentMethod)) {
        throw new Error('This payment method cannot use one-tap confirmation.');
      }
      const digitalPayment = PB_DIGITAL_PAYMENT_METHODS.includes(paymentMethod);
      if (digitalPayment && !['for_verification', 'paid', 'downpayment_paid'].includes(paymentStatus)) {
        throw new Error('This digital payment is not ready for confirmation.');
      }
      if (!digitalPayment && !['unpaid', 'pending', 'paid', 'downpayment_paid'].includes(paymentStatus)) {
        throw new Error('This cash booking payment state is not ready for confirmation.');
      }
      if (items.some(item => lowerValue(item.email) === 'reserve@hold.internal')) {
        throw new Error('This reservation hold has not been completed by the customer.');
      }

      const normalizeReference = (method, typedReference) => {
        const provider = lowerValue(method);
        const raw = String(typedReference || '');
        const normalized = provider === 'gcash'
          ? raw.replace(/[^0-9]/g, '')
          : raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!normalized) throw new Error('A payment reference is required before confirming payment.');
        if (provider === 'gcash' && !/^[0-9]{13}$/.test(normalized)) {
          throw new Error('The GCash reference must contain exactly 13 digits.');
        }
        if (provider === 'bdopay' && !/^BN[0-9]{16}$/.test(normalized)) {
          throw new Error('The BDO Pay reference is invalid.');
        }
        if (provider === 'maya' && !/^[A-Z0-9]{12}$/.test(normalized)) {
          throw new Error('The Maya reference is invalid.');
        }
        if (provider === 'bpi' && !/^[0-9]{10,20}$/.test(normalized)) {
          throw new Error('The BPI confirmation number is invalid.');
        }
        return provider === 'gcash' ? normalized : `${provider}:${normalized}`;
      };

      let paymentReferenceKey = '';
      if (digitalPayment) {
        paymentReferenceKey = singleValue(
          items.map(item => normalizeReference(
            item.paymentMethod ?? item.payment_method,
            item.gcashRef ?? item.gcash_ref,
          )),
          'The payment reference is missing or inconsistent across this booking.',
        );
      }

      const amountRows = items.map(item => {
        const total = Number(item.total);
        const hasDownpayment = item.downpayment !== undefined &&
          item.downpayment !== null && item.downpayment !== '';
        const downpayment = hasDownpayment ? Number(item.downpayment) : total;
        if (!Number.isFinite(total) || total <= 0 ||
            !Number.isFinite(downpayment) || downpayment <= 0 ||
            downpayment > total + 0.01 || (hostBooking && !hasDownpayment)) {
          throw new Error('Stored booking payment amounts require manual review.');
        }
        return { item, total, downpayment };
      });
      const expectedTotal = amountRows.reduce((sum, row) => sum + row.total, 0);
      const expectedDue = amountRows.reduce((sum, row) => sum + row.downpayment, 0);
      if (expectedDue <= 0 || expectedDue > expectedTotal + 0.01) {
        throw new Error('Stored booking payment amounts require manual review.');
      }

      let targetPaymentStatus = paymentStatus;
      if (digitalPayment || ['paid', 'downpayment_paid'].includes(paymentStatus)) {
        const fullRows = amountRows.filter(row => Math.abs(row.downpayment - row.total) <= 0.01);
        const partialRows = amountRows.filter(row => row.downpayment < row.total - 0.01);
        if (hostBooking) {
          if (fullRows.length === amountRows.length) {
            targetPaymentStatus = 'paid';
          } else if (partialRows.length === amountRows.length) {
            const settings = db.settings || {};
            const feeRate = Number(
              settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee ?? 0,
            );
            const flatFee = ['flat', 'booking', 'per_booking', 'per_transaction'].includes(
              lowerValue(settings.fee_type),
            );
            const hasUnderpayment = amountRows.some(({ item, total, downpayment }) => {
              const slotCount = Array.isArray(item.slots) ? item.slots.length : 0;
              const configuredServiceFee = Number.isFinite(feeRate) && feeRate >= 0
                ? feeRate * (flatFee ? 1 : slotCount)
                : 0;
              const storedServiceFee = item.bookingFeeAmountSnapshot ?? item.booking_fee_amount_snapshot;
              const parsedStoredServiceFee = Number(storedServiceFee);
              const requestedServiceFee = storedServiceFee !== null && storedServiceFee !== undefined
                  && Number.isFinite(parsedStoredServiceFee)
                ? parsedStoredServiceFee
                : configuredServiceFee;
              const serviceFee = Math.min(Math.max(requestedServiceFee, 0), total);
              const required = Math.round(
                (serviceFee + ((total - serviceFee) * 0.25)) * 100,
              ) / 100;
              return Math.abs(downpayment - required) > 0.01;
            });
            if (hasUnderpayment) {
              throw new Error('The host reservation payment is lower than the required amount.');
            }
            targetPaymentStatus = 'downpayment_paid';
          } else {
            throw new Error('Grouped host payment amounts are mixed. Review the payment details before confirming.');
          }
        } else {
          if (fullRows.length !== amountRows.length || Math.abs(expectedDue - expectedTotal) > 0.01) {
            throw new Error('Regular bookings require full payment before confirmation.');
          }
          targetPaymentStatus = 'paid';
        }
      }

      if (['paid', 'downpayment_paid'].includes(paymentStatus) && paymentStatus !== targetPaymentStatus) {
        throw new Error('The settled payment state does not match the stored amount.');
      }
      if (bookingStatus === 'confirmed' && paymentStatus !== targetPaymentStatus) {
        throw new Error('The confirmed booking has an inconsistent payment state.');
      }

      const receiptUrls = new Set();
      const receiptHashes = new Set();
      items.forEach(item => {
        const receiptUrl = String(item.receiptImageUrl ?? item.receipt_image_url ?? '').trim();
        const receiptHash = String(item.receiptImageHash ?? item.receipt_image_hash ?? '').trim();
        if (receiptUrl) receiptUrls.add(receiptUrl);
        if (receiptHash) receiptHashes.add(receiptHash);
      });
      if (receiptUrls.size > 1 || receiptHashes.size > 1) {
        throw new Error('Grouped receipt evidence is inconsistent. Review the payment details before confirming.');
      }
      if (digitalPayment && paymentStatus === 'for_verification' && receiptUrls.size === 0) {
        throw new Error('A receipt image is required before confirming this payment.');
      }

      if (digitalPayment) {
        const currentRefs = new Set(refs);
        const safeReferenceKey = item => {
          const method = lowerValue(item.paymentMethod ?? item.payment_method);
          if (!PB_DIGITAL_PAYMENT_METHODS.includes(method)) return '';
          try {
            return normalizeReference(method, item.gcashRef ?? item.gcash_ref);
          } catch (_) {
            return '';
          }
        };
        const duplicateBooking = db.bookings.some(item =>
          !currentRefs.has(String(item.ref)) && safeReferenceKey(item) === paymentReferenceKey,
        );
        const duplicateSettledExternal = [
          ...(db.openPlayRegistrations || []),
          ...(db.openPlayHostSessionRegistrations || []),
        ].some(item => {
          const state = lowerValue(item.paymentStatus ?? item.payment_status);
          return ['paid', 'downpayment_paid', 'deposit_retained'].includes(state) &&
            safeReferenceKey(item) === paymentReferenceKey;
        });
        if (duplicateBooking || duplicateSettledExternal) {
          throw new Error('This payment reference has already been used for another payment.');
        }
      }

      if (bookingStatus === 'confirmed' && paymentStatus === targetPaymentStatus) {
        return {
          transitioned: false,
          booking: { ...target },
          paymentStatus: targetPaymentStatus,
          status: 'confirmed',
          refs,
        };
      }

      const refSet = new Set(refs);
      const confirmedAt = nowIso();
      db.bookings = db.bookings.map(booking => {
        if (!refSet.has(String(booking.ref))) return booking;
        const next = {
          ...booking,
          status: 'confirmed',
          paymentStatus: targetPaymentStatus,
        };
        if (['paid', 'downpayment_paid'].includes(targetPaymentStatus)) {
          next.paidAt = booking.paidAt || booking.paid_at || confirmedAt;
          next.bookingFeeEarnedAt = booking.bookingFeeEarnedAt
            || booking.booking_fee_earned_at
            || confirmedAt;
        }
        return next;
      });
      writeDb(db);
      const confirmedBooking = db.bookings.find(booking => String(booking.ref) === bookingRef);
      return {
        transitioned: true,
        ...(confirmedBooking ? { booking: confirmedBooking } : {}),
        paymentStatus: targetPaymentStatus,
        status: 'confirmed',
        refs,
      };
    },
    async transferCancelledBookingPayment(sourceRef, targetRef, reason, noRefundConfirmed, idempotencyKey) {
      const sourceBookingRef = String(sourceRef || '').trim();
      const targetBookingRef = String(targetRef || '').trim();
      const transferReason = String(reason || '').trim();
      const requestKey = String(idempotencyKey || '').trim();
      if (!sourceBookingRef || !targetBookingRef || sourceBookingRef === targetBookingRef) {
        throw new Error('Choose two different source and destination bookings.');
      }
      if (transferReason.length < 10 || transferReason.length > 1000) {
        throw new Error('Enter a transfer reason between 10 and 1000 characters.');
      }
      if (noRefundConfirmed !== true) {
        throw new Error('Confirm that no refund or chargeback was issued for the cancelled booking.');
      }
      if (!requestKey) throw new Error('A payment-transfer idempotency key is required.');

      const session = window.Auth?.getSession?.() || null;
      if (!session || !['owner', 'court_owner'].includes(String(session.role || '')) ||
          (session.status && session.status !== 'active')) {
        throw new Error('Only an active owner or court owner can move a cancelled booking payment.');
      }

      const db = readDb();
      db.bookingPaymentTransfers = Array.isArray(db.bookingPaymentTransfers)
        ? db.bookingPaymentTransfers
        : [];
      const replay = db.bookingPaymentTransfers.find(item => String(item.idempotencyKey) === requestKey);
      if (replay) {
        if (replay.sourceBookingRef !== sourceBookingRef || replay.targetBookingRef !== targetBookingRef ||
            replay.reason !== transferReason || replay.noRefundConfirmed !== true) {
          throw new Error('This payment-transfer request key was already used for different details.');
        }
        return {
          transitioned: false,
          transferId: replay.id,
          sourceBookingRef,
          targetBookingRef,
          targetBookingStatus: replay.targetBookingStatus,
          targetPaymentStatus: replay.targetPaymentStatus,
          sourceBookingRefs: [...replay.sourceBookingRefs],
          targetBookingRefs: [...replay.targetBookingRefs],
        };
      }

      const logicalGroup = booking => {
        const groupRef = String(booking?.groupRef || booking?.bookingGroupRef || booking?.booking_group_ref || '').trim();
        return groupRef
          ? db.bookings.filter(item => String(item.groupRef || item.bookingGroupRef || item.booking_group_ref || '').trim() === groupRef)
          : booking ? [booking] : [];
      };
      const source = db.bookings.find(booking => String(booking.ref) === sourceBookingRef);
      const target = db.bookings.find(booking => String(booking.ref) === targetBookingRef);
      if (!source || !target) throw new Error('The source or destination booking was not found.');
      const sourceItems = logicalGroup(source);
      const targetItems = logicalGroup(target);
      const sourceRefs = sourceItems.map(item => String(item.ref)).sort();
      const targetRefs = targetItems.map(item => String(item.ref)).sort();
      if (sourceRefs.some(ref => targetRefs.includes(ref))) {
        throw new Error('The source and destination must be different logical bookings.');
      }
      if (!sourceItems.length || sourceItems.length !== targetItems.length) {
        throw new Error('The complete cancelled and replacement booking groups must have the same number of rows.');
      }

      const lower = value => String(value || '').trim().toLowerCase();
      const normalizedName = value => lower(value).replace(/\s+/g, ' ');
      const digits = value => String(value || '').replace(/\D/g, '');
      const one = (items, value, message) => {
        const values = [...new Set(items.map(value))];
        if (values.length !== 1) throw new Error(message);
        return values[0];
      };
      const sourceStatus = one(sourceItems, item => lower(item.status), 'The cancelled booking group has mixed reservation states.');
      const targetStatus = one(targetItems, item => lower(item.status), 'The new booking group has mixed reservation states.');
      const sourcePaymentStatus = one(sourceItems, item => lower(item.paymentStatus ?? item.payment_status), 'The cancelled booking group has mixed payment states.');
      const targetPaymentStatus = one(targetItems, item => lower(item.paymentStatus ?? item.payment_status), 'The new booking group has mixed payment states.');
      const sourceMethod = one(sourceItems, item => lower(item.paymentMethod ?? item.payment_method), 'The cancelled booking group has mixed payment methods.');
      const targetMethod = one(targetItems, item => lower(item.paymentMethod ?? item.payment_method), 'The new booking group has mixed payment methods.');
      if (sourceStatus !== 'cancelled') throw new Error('The source booking must already be cancelled.');
      if (!['pending', 'verifying'].includes(targetStatus)) throw new Error('The new booking is no longer awaiting confirmation.');
      if (!['unpaid', 'paid', 'downpayment_paid'].includes(sourcePaymentStatus)) {
        throw new Error('The cancelled source must contain a durably accepted payment.');
      }
      if (targetPaymentStatus !== 'for_verification') throw new Error('The new booking payment must still be For Verification.');
      const sourceHasSettlementEvidence = sourceItems.every(item =>
        Boolean(String(item.paidAt || item.paid_at || '').trim()) &&
        Boolean(String(item.bookingFeeEarnedAt || item.booking_fee_earned_at || '').trim()),
      );
      if (!sourceHasSettlementEvidence) {
        throw new Error('The cancelled booking lacks durable prior-acceptance timestamps.');
      }
      if (sourceMethod !== targetMethod || !PB_DIGITAL_PAYMENT_METHODS.includes(sourceMethod)) {
        throw new Error('Both bookings must use the same digital payment method.');
      }

      const normalizeReference = (method, typedReference) => {
        const raw = String(typedReference || '');
        const normalized = method === 'gcash'
          ? raw.replace(/[^0-9]/g, '')
          : raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
        return normalized ? (method === 'gcash' ? normalized : `${method}:${normalized}`) : '';
      };
      const sourcePaymentRef = one(sourceItems, item => normalizeReference(sourceMethod, item.gcashRef ?? item.gcash_ref), 'The cancelled booking reference is inconsistent.');
      const targetPaymentRef = one(targetItems, item => normalizeReference(targetMethod, item.gcashRef ?? item.gcash_ref), 'The new booking reference is inconsistent.');
      if (!sourcePaymentRef || sourcePaymentRef !== targetPaymentRef) {
        throw new Error('Both bookings must carry the same payment reference.');
      }

      const sourceEmail = one(sourceItems, item => lower(item.email), 'The cancelled booking group has mixed customer emails.');
      const targetEmail = one(targetItems, item => lower(item.email), 'The new booking group has mixed customer emails.');
      const sourcePhone = one(sourceItems, item => digits(item.contactNumber ?? item.contact_number), 'The cancelled booking group has mixed contact numbers.');
      const targetPhone = one(targetItems, item => digits(item.contactNumber ?? item.contact_number), 'The new booking group has mixed contact numbers.');
      const sourceName = one(sourceItems, item => normalizedName(item.fullName ?? item.full_name), 'The cancelled booking group has mixed customer names.');
      const targetName = one(targetItems, item => normalizedName(item.fullName ?? item.full_name), 'The new booking group has mixed customer names.');
      if (!sourceEmail || sourceEmail !== targetEmail || sourcePhone !== targetPhone || !sourceName || sourceName !== targetName) {
        throw new Error('Both bookings must belong to the same player.');
      }
      const sourceHost = one(sourceItems, item => !!(item.hostBooking ?? item.host_booking), 'The cancelled booking group has mixed booking types.');
      const targetHost = one(targetItems, item => !!(item.hostBooking ?? item.host_booking), 'The new booking group has mixed booking types.');
      if (sourceHost !== targetHost) throw new Error('Both bookings must have the same booking type.');
      const sourceHostId = one(sourceItems, item => String(item.hostUserId ?? item.host_user_id ?? ''), 'The cancelled booking has mixed host ownership.');
      const targetHostId = one(targetItems, item => String(item.hostUserId ?? item.host_user_id ?? ''), 'The new booking has mixed host ownership.');
      if (sourceHostId !== targetHostId) throw new Error('Both bookings must have the same host ownership.');

      const roundMoney = value => Math.round(Number(value) * 100) / 100;
      const signatureMoney = value => {
        if (value === null || value === undefined || value === '') return '';
        const parsed = Number(value);
        return Number.isFinite(parsed) ? roundMoney(parsed).toFixed(2) : 'invalid';
      };
      const snapshotBoolean = value => value === true || value === 1 || lower(value) === 'true';
      const paymentShape = items => {
        let total = 0;
        let paid = 0;
        let fullRows = 0;
        let partialRows = 0;
        const signatures = items.map(item => {
          const rowTotal = Number(item.total);
          const hasDownpayment = item.downpayment !== null && item.downpayment !== undefined && item.downpayment !== '';
          const rowPaid = hasDownpayment ? Number(item.downpayment) : NaN;
          if (!Number.isFinite(rowTotal) || rowTotal <= 0 || !Number.isFinite(rowPaid) || rowPaid <= 0 || rowPaid > rowTotal + 0.01) {
            throw new Error('Stored booking payment amounts require manual review.');
          }
          total += rowTotal;
          paid += rowPaid;
          if (Math.abs(rowPaid - rowTotal) <= 0.01) fullRows += 1;
          else if (rowPaid < rowTotal - 0.01) partialRows += 1;
          const slots = Array.isArray(item.slots) ? item.slots : [];
          const duration = item.duration ?? slots.length ?? 0;
          const bookingFeeAmountSnapshot = item.bookingFeeAmountSnapshot ?? item.booking_fee_amount_snapshot;
          const bookingFeeRateSnapshot = item.bookingFeeRateSnapshot ?? item.booking_fee_rate_snapshot;
          const bookingFeeTypeSnapshot = item.bookingFeeTypeSnapshot ?? item.booking_fee_type_snapshot ?? '';
          const bookingFeeUnitsSnapshot = item.bookingFeeUnitsSnapshot ?? item.booking_fee_units_snapshot;
          const bookingFeeLedgerEligibleSnapshot = item.bookingFeeLedgerEligibleSnapshot ?? item.booking_fee_ledger_eligible_snapshot ?? false;
          return [
            signatureMoney(rowTotal),
            signatureMoney(rowPaid),
            String(duration),
            String(slots.length),
            signatureMoney(bookingFeeAmountSnapshot),
            signatureMoney(bookingFeeRateSnapshot),
            String(bookingFeeTypeSnapshot),
            bookingFeeUnitsSnapshot === null || bookingFeeUnitsSnapshot === undefined ? '' : String(bookingFeeUnitsSnapshot),
            String(snapshotBoolean(bookingFeeLedgerEligibleSnapshot)),
          ].join('|');
        }).sort();
        return { total: roundMoney(total), paid: roundMoney(paid), fullRows, partialRows, signatures };
      };
      const sourceAmount = paymentShape(sourceItems);
      const targetAmount = paymentShape(targetItems);
      if (sourceAmount.total !== targetAmount.total || sourceAmount.paid !== targetAmount.paid ||
          JSON.stringify(sourceAmount.signatures) !== JSON.stringify(targetAmount.signatures)) {
        throw new Error('The cancelled and replacement court-hour or fee snapshots do not match.');
      }
      let resolvedTargetPaymentStatus = '';
      if (targetAmount.fullRows === targetItems.length) {
        resolvedTargetPaymentStatus = 'paid';
      } else if (targetHost && targetAmount.partialRows === targetItems.length) {
        const settings = db.settings || {};
        const feeRate = Number(settings.maintenance_fee ?? settings.service_fee_rate ?? settings.booking_fee ?? 0);
        const flatFee = ['flat', 'booking', 'per_booking', 'per_transaction'].includes(lower(settings.fee_type));
        const underpaid = targetItems.some(item => {
          const total = Number(item.total);
          const paid = Number(item.downpayment);
          const slots = Array.isArray(item.slots) ? item.slots : [];
          const storedFee = item.bookingFeeAmountSnapshot ?? item.booking_fee_amount_snapshot;
          const parsedStoredFee = Number(storedFee);
          const configuredFee = Number.isFinite(feeRate) && feeRate >= 0 ? feeRate * (flatFee ? 1 : slots.length) : 0;
          const requestedFee = storedFee !== null && storedFee !== undefined && Number.isFinite(parsedStoredFee)
            ? parsedStoredFee : configuredFee;
          const serviceFee = Math.min(Math.max(requestedFee, 0), total);
          const required = roundMoney(serviceFee + ((total - serviceFee) * 0.25));
          return Math.abs(paid - required) > 0.01;
        });
        if (underpaid) throw new Error('The replacement host payment is lower than the required amount.');
        resolvedTargetPaymentStatus = 'downpayment_paid';
      } else {
        throw new Error('The replacement payment amount cannot be accepted as stored.');
      }
      if (['paid', 'downpayment_paid'].includes(sourcePaymentStatus) && sourcePaymentStatus !== resolvedTargetPaymentStatus) {
        throw new Error('The accepted source payment state does not match the replacement amount.');
      }

      const allRefs = new Set([...sourceRefs, ...targetRefs]);
      const alreadyTransferredOrRejected = [...sourceItems, ...targetItems].some(item =>
        item.paymentTransferId || item.payment_transfer_id || item.paymentReassignedFromRef || item.payment_reassigned_from_ref ||
        item.paymentReassignedToRef || item.payment_reassigned_to_ref || lower(item.receiptStatus ?? item.receipt_status) === 'rejected',
      );
      if (alreadyTransferredOrRejected) throw new Error('A previously transferred or rejected receipt cannot be moved.');

      const distinctEvidence = (items, camelKey, snakeKey) => [...new Set(items
        .map(item => String(item[camelKey] ?? item[snakeKey] ?? '').trim())
        .filter(Boolean))];
      const sourceReceiptHashes = distinctEvidence(sourceItems, 'receiptImageHash', 'receipt_image_hash');
      const targetReceiptHashes = distinctEvidence(targetItems, 'receiptImageHash', 'receipt_image_hash');
      const sourceReceiptPhashes = distinctEvidence(sourceItems, 'receiptPhash', 'receipt_phash');
      const targetReceiptPhashes = distinctEvidence(targetItems, 'receiptPhash', 'receipt_phash');
      const sourceReceiptHash = sourceReceiptHashes[0] || '';
      const targetReceiptHash = targetReceiptHashes[0] || '';
      const sourceReceiptPhash = sourceReceiptPhashes[0] || '';
      const targetReceiptPhash = targetReceiptPhashes[0] || '';
      const consistentReceiptEvidence = sourceReceiptHashes.length <= 1 && targetReceiptHashes.length <= 1 &&
        sourceReceiptPhashes.length <= 1 && targetReceiptPhashes.length <= 1;
      const exactReceiptEvidence = (sourceReceiptHash && targetReceiptHash && sourceReceiptHash === targetReceiptHash) ||
        (sourceReceiptPhash && targetReceiptPhash && sourceReceiptPhash === targetReceiptPhash);
      if (!consistentReceiptEvidence || !exactReceiptEvidence) {
        throw new Error('The cancelled and replacement bookings must contain the same stored receipt fingerprint.');
      }

      const sourceGroupRef = String(source.groupRef || source.bookingGroupRef || source.booking_group_ref || '').trim();
      const targetGroupRef = String(target.groupRef || target.bookingGroupRef || target.booking_group_ref || '').trim();
      const sourceClaimScope = sourceGroupRef ? 'booking_group' : 'booking';
      const targetClaimScope = targetGroupRef ? 'booking_group' : 'booking';
      const sourceClaimOwnerId = sourceGroupRef || sourceBookingRef;
      const targetClaimOwnerId = targetGroupRef || targetBookingRef;
      const localReferenceLedger = Array.isArray(db.usedGcashRefs)
        ? db.usedGcashRefs
        : Array.isArray(db.used_gcash_refs) ? db.used_gcash_refs : null;
      let canonicalLedgerClaim = null;
      if (localReferenceLedger) {
        const canonicalClaims = localReferenceLedger.filter(item =>
          String(item.gcashRef ?? item.gcash_ref ?? '').trim() === sourcePaymentRef,
        );
        if (canonicalClaims.length !== 1) {
          throw new Error('The accepted source does not uniquely own its canonical payment reference.');
        }
        canonicalLedgerClaim = canonicalClaims[0];
        const ledgerScope = lower(canonicalLedgerClaim.claimScope ?? canonicalLedgerClaim.claim_scope);
        const ledgerOwnerId = String(canonicalLedgerClaim.claimOwnerId ?? canonicalLedgerClaim.claim_owner_id ?? '').trim();
        const ledgerProvider = lower(canonicalLedgerClaim.provider);
        if (ledgerScope !== sourceClaimScope || ledgerOwnerId !== sourceClaimOwnerId || ledgerProvider !== sourceMethod) {
          throw new Error('The canonical payment reference belongs to another booking.');
        }
      }
      const balanceHistory = (db.hostBookingBalancePayments || []).some(payment => {
        const bookingRefs = Array.isArray(payment.bookingRefs ?? payment.booking_refs) ? (payment.bookingRefs ?? payment.booking_refs).map(String) : [];
        const bookingRef = String(payment.bookingRef ?? payment.booking_ref ?? '');
        const bookingGroupRef = String(payment.bookingGroupRef ?? payment.booking_group_ref ?? '');
        return allRefs.has(bookingRef) || bookingRefs.some(ref => allRefs.has(ref)) ||
          Boolean(bookingGroupRef && (bookingGroupRef === sourceGroupRef || bookingGroupRef === targetGroupRef));
      });
      if (balanceHistory) throw new Error('A booking with Payment 2 or balance history cannot move its initial payment.');

      const remittanceHistory = (db.bookingFeeRemittanceItems || []).some(item => allRefs.has(String(item.bookingRef ?? item.booking_ref ?? '')));
      const billedBooking = [...sourceItems, ...targetItems].some(item =>
        item.weeklyFeeId || item.weekly_fee_id || item.billedAt || item.billed_at,
      );
      const statementContainsRef = (db.weeklyFees || []).some(statement => {
        let billedRefs = statement.billedRefs ?? statement.billed_refs ?? [];
        if (typeof billedRefs === 'string') {
          try { billedRefs = JSON.parse(billedRefs); } catch (_) { billedRefs = []; }
        }
        return Array.isArray(billedRefs) && billedRefs.some(ref => allRefs.has(String(ref)));
      });
      if (remittanceHistory || billedBooking || statementContainsRef) {
        throw new Error('A remitted or prepared booking payment cannot be moved.');
      }

      const transferHistory = db.bookingPaymentTransfers.some(transfer => {
        const refs = [
          transfer.sourceBookingRef,
          transfer.targetBookingRef,
          ...(Array.isArray(transfer.sourceBookingRefs) ? transfer.sourceBookingRefs : []),
          ...(Array.isArray(transfer.targetBookingRefs) ? transfer.targetBookingRefs : []),
        ].map(String);
        return refs.some(ref => allRefs.has(ref));
      });
      if (transferHistory) throw new Error('One of these bookings already has payment transfer history.');

      const thirdBookingClaim = db.bookings.some(item =>
        !allRefs.has(String(item.ref)) &&
        normalizeReference(lower(item.paymentMethod ?? item.payment_method), item.gcashRef ?? item.gcash_ref) === sourcePaymentRef,
      );
      const thirdOpenPlayClaim = (db.openPlayRegistrations || []).some(item =>
        normalizeReference(lower(item.paymentMethod ?? item.payment_method), item.gcashRef ?? item.gcash_ref) === sourcePaymentRef,
      );
      const thirdHostSessionClaim = (db.openPlayHostSessionRegistrations || []).some(item =>
        normalizeReference(lower(item.paymentMethod ?? item.payment_method), item.gcashRef ?? item.gcash_ref) === sourcePaymentRef,
      );
      const thirdBalanceClaim = (db.hostBookingBalancePayments || []).some(item =>
        normalizeReference(lower(item.paymentProvider ?? item.payment_provider), item.paymentReference ?? item.payment_reference) === sourcePaymentRef,
      );
      if (thirdBookingClaim || thirdOpenPlayClaim || thirdHostSessionClaim || thirdBalanceClaim) {
        throw new Error('This payment reference is also attached to a third payment.');
      }

      const transferId = globalThis.crypto?.randomUUID?.() || `local-transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const transferredAt = nowIso();
      const sourceRefSet = new Set(sourceRefs);
      const targetRefSet = new Set(targetRefs);
      const receiptSource = sourceItems.find(item => item.receiptImageUrl || item.receipt_image_url) || sourceItems[0];
      if (canonicalLedgerClaim) {
        const usesSnakeCase = Object.prototype.hasOwnProperty.call(canonicalLedgerClaim, 'claim_scope');
        if (usesSnakeCase) {
          canonicalLedgerClaim.booking_ref = targetBookingRef;
          canonicalLedgerClaim.claim_scope = targetClaimScope;
          canonicalLedgerClaim.claim_owner_id = targetClaimOwnerId;
        } else {
          canonicalLedgerClaim.bookingRef = targetBookingRef;
          canonicalLedgerClaim.claimScope = targetClaimScope;
          canonicalLedgerClaim.claimOwnerId = targetClaimOwnerId;
        }
      }
      db.bookings = db.bookings.map(booking => {
        const bookingRef = String(booking.ref);
        if (sourceRefSet.has(bookingRef)) {
          return {
            ...booking,
            paymentTransferId: transferId,
            paymentReassignedToRef: targetBookingRef,
          };
        }
        if (!targetRefSet.has(bookingRef)) return booking;
        return {
          ...booking,
          status: 'confirmed',
          paymentStatus: resolvedTargetPaymentStatus,
          paidAt: booking.paidAt || booking.paid_at || receiptSource.paidAt || receiptSource.paid_at || transferredAt,
          bookingFeeEarnedAt: booking.bookingFeeEarnedAt || booking.booking_fee_earned_at || transferredAt,
          paymentTransferId: transferId,
          paymentReassignedFromRef: sourceBookingRef,
          receiptImageUrl: booking.receiptImageUrl || booking.receipt_image_url || receiptSource.receiptImageUrl || receiptSource.receipt_image_url || null,
          receiptImageHash: booking.receiptImageHash || booking.receipt_image_hash || receiptSource.receiptImageHash || receiptSource.receipt_image_hash || null,
          receiptPhash: booking.receiptPhash || booking.receipt_phash || receiptSource.receiptPhash || receiptSource.receipt_phash || null,
          receiptExtracted: booking.receiptExtracted || booking.receipt_extracted || receiptSource.receiptExtracted || receiptSource.receipt_extracted || null,
          receiptConfidence: booking.receiptConfidence ?? booking.receipt_confidence ?? receiptSource.receiptConfidence ?? receiptSource.receipt_confidence ?? null,
          receiptVerifiedAt: booking.receiptVerifiedAt || booking.receipt_verified_at || receiptSource.receiptVerifiedAt || receiptSource.receipt_verified_at || null,
        };
      });
      const audit = {
        id: transferId,
        idempotencyKey: requestKey,
        sourceBookingRef,
        targetBookingRef,
        sourceBookingRefs: sourceRefs,
        targetBookingRefs: targetRefs,
        sourceBookingGroupRef: sourceGroupRef || null,
        targetBookingGroupRef: targetGroupRef || null,
        paymentMethod: sourceMethod,
        paymentReferenceKey: sourcePaymentRef,
        evidenceLedgerKeys: [sourcePaymentRef],
        amount: targetAmount.paid,
        sourcePaymentStatus,
        targetBookingStatus: 'confirmed',
        targetPaymentStatus: resolvedTargetPaymentStatus,
        reason: transferReason,
        noRefundConfirmed: true,
        createdAt: transferredAt,
        actorUserId: session.userId || session.id || null,
        actorRole: session.role,
      };
      db.bookingPaymentTransfers.push(audit);
      writeDb(db);
      return {
        transitioned: true,
        transferId,
        sourceBookingRef,
        targetBookingRef,
        targetBookingStatus: 'confirmed',
        targetPaymentStatus: resolvedTargetPaymentStatus,
        sourceBookingRefs: sourceRefs,
        targetBookingRefs: targetRefs,
      };
    },
    async rejectBookingPaymentTransaction(ref, reason) {
      const bookingRef = String(ref || '').trim();
      const reviewReason = String(reason || '').trim();
      if (!bookingRef) throw new Error('A booking reference is required.');
      if (reviewReason.length < 3) throw new Error('A Not Received reason of at least 3 characters is required.');

      const session = window.Auth?.getSession?.() || null;
      if (!session || !['owner', 'court_owner'].includes(String(session.role || '')) ||
          (session.status && session.status !== 'active')) {
        throw new Error('Only an active owner or court owner can mark a booking payment as not received.');
      }

      const db = readDb();
      const target = db.bookings.find(booking => String(booking.ref) === bookingRef);
      if (!target) throw new Error('Booking not found.');
      const groupRef = String(target.groupRef || target.bookingGroupRef || '').trim();
      const items = groupRef
        ? db.bookings.filter(booking =>
            String(booking.groupRef || booking.bookingGroupRef || '').trim() === groupRef)
        : [target];
      const refs = items.map(booking => String(booking.ref)).sort();
      const statuses = [...new Set(items.map(item => String(item.status || '').toLowerCase()))];
      const paymentStatuses = [...new Set(items.map(item =>
        String(item.paymentStatus ?? item.payment_status ?? '').toLowerCase(),
      ))];
      const methods = [...new Set(items.map(item =>
        String(item.paymentMethod ?? item.payment_method ?? '').toLowerCase(),
      ))];
      if (statuses.length === 1 && statuses[0] === 'cancelled' &&
          paymentStatuses.length === 1 && paymentStatuses[0] === 'rejected') {
        return { transitioned: false, status: 'cancelled', paymentStatus: 'rejected', refs };
      }
      if (statuses.length !== 1 || paymentStatuses.length !== 1 || methods.length !== 1) {
        throw new Error('Grouped booking payment states are mixed.');
      }
      if (!['verifying', 'pending'].includes(statuses[0]) ||
          !['unpaid', 'pending', 'for_verification'].includes(paymentStatuses[0])) {
        throw new Error('This payment is no longer awaiting review.');
      }
      if (!PB_DIGITAL_PAYMENT_METHODS.includes(methods[0])) {
        throw new Error('Only a digital payment review can use Not Received.');
      }

      const refSet = new Set(refs);
      db.bookings = db.bookings.map(booking => refSet.has(String(booking.ref))
        ? {
          ...booking,
          status: 'cancelled',
          paymentStatus: 'rejected',
          receiptStatus: 'rejected',
          paidAt: null,
          paymentReviewReason: reviewReason,
        }
        : booking);
      writeDb(db);
      return { transitioned: true, status: 'cancelled', paymentStatus: 'rejected', refs };
    },
    async markBookingsBilled(refs, weeklyFeeId) {
      if (!Array.isArray(refs) || refs.length === 0) return;
      const db = readDb();
      db.bookings = db.bookings.map(b => refs.includes(b.ref) ? { ...b, billedAt: nowIso(), weeklyFeeId } : b);
      writeDb(db);
    },
    async deleteBooking(ref) {
      const db = readDb();
      const existing = db.bookings.find(b => String(b.ref) === String(ref));
      if (existing) {
        db.deletedBookingArchive.unshift({
          id: localRef('del'),
          bookingRef: existing.ref,
          source: 'local_delete',
          originalBooking: { ...existing },
          originalBookingRow: { ...existing },
          recoveredBooking: null,
          recoveredBookingRow: null,
          recoveryStatus: 'deleted',
          recoveredFrom: null,
          notes: 'Automatically archived before local delete.',
          deletedAt: nowIso(),
          archivedAt: nowIso(),
          restoredAt: null,
          restoredBy: null,
          createdAt: nowIso(),
        });
      }
      db.bookings = db.bookings.filter(b => String(b.ref) !== String(ref));
      writeDb(db);
    },

    async voidDeleteBookingGroup(ref, reason) {
      if (Auth.getSession()?.role !== 'owner') throw new Error('Only the System Owner can void and delete a booking.');
      if (String(reason || '').trim().length < 3) throw new Error('A void reason of at least 3 characters is required.');
      const db = readDb();
      const target = db.bookings.find(b => String(b.ref) === String(ref));
      if (!target) throw new Error('Booking not found.');
      const groupKey = target.groupRef || target.bookingGroupRef || target.ref;
      const matches = db.bookings.filter(b => String(b.groupRef || b.bookingGroupRef || b.ref) === String(groupKey));
      const refs = new Set(matches.map(b => String(b.ref)));
      const now = nowIso();
      let voidedFee = 0;
      matches.forEach(b => {
        const fee = b.bookingFeeEarnedAt || b.booking_fee_earned_at
          ? Number(b.bookingFeeAmountSnapshot ?? b.booking_fee_amount_snapshot ?? 0) : 0;
        voidedFee += Math.max(fee, 0);
        db.deletedBookingArchive.unshift({
          id: localRef('del'), bookingRef: b.ref, source: 'owner_void',
          originalBooking: { ...b }, originalBookingRow: { ...b },
          recoveryStatus: 'voided',
          notes: `System Owner voided and deleted this booking. Fee excluded from future computation. Reason: ${String(reason).trim()}`,
          voidedFeeAmount: Math.max(fee, 0), voidReason: String(reason).trim(),
          voidedAt: now, voidedBy: Auth.getSession()?.id || null,
          deletedAt: now, archivedAt: now, createdAt: now,
        });
      });
      db.bookings = db.bookings.filter(b => !refs.has(String(b.ref)));
      writeDb(db);
      return { deleted_count: matches.length, voided_fee_amount: voidedFee };
    },

    async getDeletedBookingArchive(filters = {}) {
      const opts = filters || {};
      return readDb().deletedBookingArchive
        .filter(r => !opts.status || r.recoveryStatus === opts.status)
        .filter(r => !opts.bookingRef || String(r.bookingRef) === String(opts.bookingRef))
        .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')))
        .slice(0, Number(opts.limit || 250));
    },

    async restoreDeletedBookingArchive(id) {
      const db = readDb();
      const idx = db.deletedBookingArchive.findIndex(r => String(r.id) === String(id));
      if (idx < 0) throw new Error('Deleted booking archive row not found.');
      const entry = db.deletedBookingArchive[idx];
      if (entry.recoveryStatus === 'voided' || entry.source === 'owner_void') {
        throw new Error('A voided booking is final and cannot be restored.');
      }
      const booking = { ...(entry.originalBooking || entry.originalBookingRow || {}) };
      if (!booking.ref) throw new Error('Archive row has no booking reference.');
      if (db.bookings.some(b => String(b.ref) === String(booking.ref))) {
        throw new Error(`Booking ${booking.ref} already exists in active bookings.`);
      }
      const existing = db.bookings
        .filter(b => String(b.courtId) === String(booking.courtId) && b.date === booking.date && b.status !== 'cancelled' && b.status !== 'forfeited');
      if (hasSlotConflict(existing, booking)) {
        throw new Error('Cannot restore because one or more slots are already booked.');
      }
      db.bookings.push(booking);
      db.deletedBookingArchive[idx] = {
        ...entry,
        recoveryStatus: 'restored',
        recoveredBooking: { ...booking },
        recoveredBookingRow: { ...booking },
        recoveredFrom: entry.recoveredFrom || 'archive_restore',
        restoredAt: nowIso(),
        restoredBy: Auth.getSession()?.id || null,
        notes: [entry.notes, 'Restored from deleted booking archive.'].filter(Boolean).join('\n'),
      };
      writeDb(db);
      return booking;
    },

    async getOpenPlayRegistrations() {
      return readDb().openPlayRegistrations.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    },
    async addOpenPlayRegistration(reg) {
      _pbAssertPublicBookingDate(reg.date);
      const db = readDb();
      let config = null;
      try { config = JSON.parse(db.settings.open_play_config || 'null'); } catch (_) {}
      if (!config || config.enabled === false) throw new Error('Open Play is not currently accepting registrations.');

      const sessionStart = Number(config.start);
      const sessionEnd = Number(config.end);
      const dateParts = String(reg.date || '').split('-').map(Number);
      const requestedDay = dateParts.length === 3
        ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2]).getDay()
        : -1;
      const enabledDays = Array.isArray(config.days) ? config.days.map(Number) : [];
      const specificDates = Array.isArray(config.specificDates) ? config.specificDates.map(String) : [];
      const enabledCourts = Array.isArray(config.courtIds) ? config.courtIds.map(String).filter(Boolean) : [];
      if (!Number.isInteger(sessionStart) || !Number.isInteger(sessionEnd) || sessionEnd <= sessionStart || Number(reg.hour) !== sessionStart) {
        throw new Error('This is not an active Open Play session.');
      }
      if (!enabledDays.includes(requestedDay) && !specificDates.includes(String(reg.date))) {
        throw new Error('Open Play is not enabled on this date.');
      }
      if (enabledCourts.length && !enabledCourts.includes(String(reg.courtId))) {
        throw new Error('This court is not enabled for Open Play.');
      }

      const court = db.courts.find(c => String(c.id) === String(reg.courtId));
      if (!court || court.blocked) throw new Error('This court is not currently available.');
      const paymentMethod = String(reg.paymentMethod || 'cash').toLowerCase();
      if (db.settings[`payment_method_${paymentMethod}`] === '0') {
        throw new Error('This payment method is not currently enabled.');
      }
      const paymentType = '100%';

      const openPlayFee = Number(config.fee ?? db.settings.open_play_fee ?? 100);
      const serviceFee = Number(db.settings.maintenance_fee ?? db.settings.service_fee_rate ?? db.settings.booking_fee ?? 0);
      const total = Math.round((openPlayFee + serviceFee) * 100) / 100;
      const canonicalAmount = total;
      const maxPlayers = Math.max(1, Number(config.maxPlayers || 40));
      const activeCount = db.openPlayRegistrations.filter(r =>
        r.date === reg.date &&
        String(r.court_id) === String(reg.courtId) &&
        r.payment_status !== 'rejected'
      ).length;
      if (activeCount >= maxPlayers) throw new Error('This Open Play session is already full.');

      const formatHour = value => {
        const hour = ((Number(value) % 24) + 24) % 24;
        return `${hour % 12 || 12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
      };
      const row = {
        id: localRef('op'),
        full_name: reg.fullName,
        court_id: String(reg.courtId),
        court_name: court.name,
        date: reg.date,
        hour: sessionStart,
        time_label: `${formatHour(sessionStart)} - ${formatHour(sessionEnd)}`,
        payment_type: paymentType,
        payment_method: paymentMethod,
        gcash_ref: reg.gcashRef || null,
        payment_status: 'pending',
        amount: canonicalAmount,
        receipt_image_url: reg.receiptImageUrl || null,
        receipt_image_hash: null,
        receipt_phash: null,
        receipt_status: paymentMethod === 'cash' ? 'none' : 'manual_review',
        receipt_flags: [],
        receipt_extracted: null,
        receipt_confidence: null,
        receipt_verified_at: null,
        created_at: nowIso(),
      };
      db.openPlayRegistrations.push(row);
      writeDb(db);
      return {
        id: row.id,
        courtId: row.court_id,
        courtName: row.court_name,
        date: row.date,
        hour: row.hour,
        timeLabel: row.time_label,
        paymentType: row.payment_type,
        paymentMethod: row.payment_method,
        paymentStatus: row.payment_status,
        amount: Number(row.amount || 0),
        receiptStatus: row.receipt_status,
        createdAt: row.created_at,
      };
    },
    async updateOpenPlayRegistration(id, updates) {
      const db = readDb();
      db.openPlayRegistrations = db.openPlayRegistrations.map(r => {
        if (String(r.id) !== String(id)) return r;
        return {
          ...r,
          payment_status: updates.paymentStatus !== undefined ? updates.paymentStatus : r.payment_status,
          gcash_ref: updates.gcashRef !== undefined ? updates.gcashRef : r.gcash_ref,
          receipt_image_url: updates.receiptImageUrl !== undefined ? updates.receiptImageUrl : r.receipt_image_url,
          receipt_image_hash: updates.receiptImageHash !== undefined ? updates.receiptImageHash : r.receipt_image_hash,
          receipt_phash: updates.receiptPhash !== undefined ? updates.receiptPhash : r.receipt_phash,
          receipt_status: updates.receiptStatus !== undefined ? updates.receiptStatus : r.receipt_status,
          receipt_flags: updates.receiptFlags !== undefined ? updates.receiptFlags : r.receipt_flags,
          receipt_extracted: updates.receiptExtracted !== undefined ? updates.receiptExtracted : r.receipt_extracted,
          receipt_confidence: updates.receiptConfidence !== undefined ? updates.receiptConfidence : r.receipt_confidence,
          receipt_verified_at: updates.receiptVerifiedAt !== undefined ? updates.receiptVerifiedAt : r.receipt_verified_at,
        };
      });
      writeDb(db);
    },
    async getOpenPlayCountForDate(date, courtId = null) {
      return readDb().openPlayRegistrations.filter(r =>
        r.date === date &&
        (!courtId || String(r.court_id) === String(courtId)) &&
        r.payment_status !== 'rejected'
      ).length;
    },
    async getOpenPlayCountsForDate(date) {
      return readDb().openPlayRegistrations
        .filter(r => r.date === date && r.payment_status !== 'rejected')
        .reduce((counts, row) => {
          const key = String(row.court_id || '');
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {});
    },
    async deleteOpenPlayRegistration(id) {
      const db = readDb();
      db.openPlayRegistrations = db.openPlayRegistrations.filter(r => String(r.id) !== String(id));
      writeDb(db);
    },

    async getOpenPlayHostApplications() {
      return readDb().openPlayHostApplications.sort((a, b) => String(b.createdAt || b.created_at || '').localeCompare(String(a.createdAt || a.created_at || '')));
    },
    async addOpenPlayHostApplication(app) {
      const db = readDb();
      db.openPlayHostApplications.unshift({
        id: localRef('hostapp'),
        fullName: app.fullName,
        contactNumber: app.contactNumber,
        email: app.email,
        gcashNumber: app.gcashNumber || '',
        validIdFileName: app.validIdFileName || '',
        validIdFileType: app.validIdFileType || '',
        validIdFileSize: app.validIdFileSize || null,
        validIdPath: app.validIdPath || '',
        preferredSchedule: app.preferredSchedule || '',
        notes: app.notes || '',
        status: 'pending',
        reviewNote: '',
        reviewedBy: null,
        reviewedAt: null,
        emailVerifiedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      writeDb(db);
    },
    async updateOpenPlayHostApplication(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayHostApplications = db.openPlayHostApplications.map(app => {
        if (String(app.id) !== String(id)) return app;
        saved = { ...app, ...updates, updatedAt: nowIso() };
        return saved;
      });
      writeDb(db);
      return saved;
    },
    async reviewOpenPlayHostApplication(id, status, reviewNote = '') {
      const db = readDb();
      const appIndex = db.openPlayHostApplications.findIndex(app => String(app.id) === String(id));
      if (appIndex < 0) throw new Error('Host application not found.');
      const existing = db.openPlayHostApplications[appIndex];
      const account = db.accounts.find(acc =>
        acc.role === 'host' && (
          (existing.hostUserId && String(acc.id) === String(existing.hostUserId)) ||
          String(acc.email || '').toLowerCase() === String(existing.email || '').toLowerCase()
        )
      );
      if (status === 'approved' && !account) {
        throw new Error('No matching host login exists for this application.');
      }
      if (account) account.status = status === 'approved' ? 'active' : 'suspended';
      const saved = {
        ...existing,
        hostUserId: account?.id || existing.hostUserId || null,
        status,
        reviewNote,
        reviewedBy: Auth.getSession()?.id || null,
        reviewedAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.openPlayHostApplications[appIndex] = saved;
      writeDb(db);
      return {
        ok: true,
        status,
        hostUserId: saved?.hostUserId || null,
        loginLinked: !!account,
        accountStatus: account?.status || null,
      };
    },
    async repairOpenPlayHostActivation(id) {
      const db = readDb();
      const appIndex = db.openPlayHostApplications.findIndex(app => String(app.id) === String(id));
      if (appIndex < 0) throw new Error('Host application not found.');
      const app = db.openPlayHostApplications[appIndex];
      const account = db.accounts.find(acc =>
        acc.role === 'host' && (
          (app.hostUserId && String(acc.id) === String(app.hostUserId)) ||
          String(acc.email || '').toLowerCase() === String(app.email || '').toLowerCase()
        )
      );
      if (!account) throw new Error('No matching host login exists for this application.');
      account.status = 'active';
      app.hostUserId = account.id;
      app.status = 'approved';
      app.updatedAt = nowIso();
      writeDb(db);
      return {
        ok: true,
        status: app.status,
        hostUserId: account.id,
        loginLinked: true,
        accountStatus: 'active',
      };
    },
    async getOpenPlayHostSessions(options = {}) {
      const opts = options || {};
      const sessions = readDb().openPlayHostSessions
        .filter(session => !opts.id || String(session.id) === String(opts.id))
        .filter(session => !opts.publicOnly || (session.status || 'published') === 'published')
        .map(session => opts.publicOnly ? {
          ...session,
          hostUserId: null,
          hostEmail: '',
        } : session);
      return sessions.sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) ||
        Number(a.startHour || a.start_hour || 0) - Number(b.startHour || b.start_hour || 0)
      );
    },
    async createOpenPlayHostSession(session) {
      _pbAssertPublicBookingDate(session.date);
      const db = readDb();
      const row = {
        id: localRef('hosts'),
        hostUserId: session.hostUserId || null,
        hostName: session.hostName,
        hostEmail: session.hostEmail || '',
        title: session.title,
        date: session.date,
        startHour: session.startHour,
        endHour: session.endHour,
        courtIds: session.courtIds || [],
        courtNames: session.courtNames || [],
        maxPlayers: session.maxPlayers || 16,
        feePerPlayer: session.feePerPlayer || 0,
        status: session.status || 'published',
        notes: session.notes || '',
        paymentInstructions: session.paymentInstructions || '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.openPlayHostSessions.unshift(row);
      writeDb(db);
      return row;
    },
    async updateOpenPlayHostSession(id, updates) {
      if (updates.date !== undefined) _pbAssertPublicBookingDate(updates.date);
      const db = readDb();
      let saved = null;
      db.openPlayHostSessions = db.openPlayHostSessions.map(session => {
        if (String(session.id) !== String(id)) return session;
        saved = { ...session, ...updates, updatedAt: nowIso() };
        return saved;
      });
      writeDb(db);
      return saved;
    },

    async getOpenPlayHostSessionRegistrations(sessionId = null) {
      return (readDb().openPlayHostSessionRegistrations || [])
        .filter(r => !sessionId || String(r.sessionId || r.session_id) === String(sessionId))
        .sort((a, b) => String(b.createdAt || b.created_at || '').localeCompare(String(a.createdAt || a.created_at || '')));
    },
    async getOpenPlayHostSessionRegistrationCount(sessionId) {
      return (readDb().openPlayHostSessionRegistrations || [])
        .filter(r => String(r.sessionId || r.session_id) === String(sessionId) && r.paymentStatus !== 'rejected' && r.payment_status !== 'rejected')
        .length;
    },
    async addOpenPlayHostSessionRegistration(reg) {
      const db = readDb();
      if (!Array.isArray(db.openPlayHostSessionRegistrations)) db.openPlayHostSessionRegistrations = [];
      const paymentMethod = String(reg.paymentMethod || 'gcash').toLowerCase();
      const digitalPayment = PB_DIGITAL_PAYMENT_METHODS.includes(paymentMethod);
      const row = {
        id: localRef('hostreg'),
        sessionId: reg.sessionId,
        fullName: reg.fullName,
        contactNumber: reg.contactNumber || '',
        paymentMethod,
        gcashRef: reg.gcashRef || null,
        paymentStatus: digitalPayment ? 'pending' : (reg.paymentStatus || 'paid'),
        amount: reg.amount || 0,
        receiptImageUrl: reg.receiptImageUrl || null,
        receiptImageHash: reg.receiptImageHash || null,
        receiptPhash: reg.receiptPhash || null,
        receiptStatus: digitalPayment ? 'manual_review' : 'none',
        receiptFlags: reg.receiptFlags || [],
        receiptExtracted: reg.receiptExtracted || null,
        receiptConfidence: reg.receiptConfidence ?? null,
        receiptVerifiedAt: reg.receiptVerifiedAt || null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.openPlayHostSessionRegistrations.unshift(row);
      writeDb(db);
      return row;
    },
    async updateOpenPlayHostSessionRegistration(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayHostSessionRegistrations = (db.openPlayHostSessionRegistrations || []).map(registration => {
        if (String(registration.id) !== String(id)) return registration;
        saved = { ...registration, ...updates, updatedAt: nowIso() };
        return saved;
      });
      writeDb(db);
      if (!saved) throw new Error('Hosted Open Play registration not found.');
      return saved;
    },

    async getOpenPlayGameSessions() {
      return readDb().openPlayGameSessions.sort((a, b) =>
        String(b.date || '').localeCompare(String(a.date || '')) ||
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      );
    },
    async setOpenPlayGamePublicShare(sessionId, enabled) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        const token = mutateLocalOpenPlayGamePublicShare(db, sessionId, enabled, false);
        writeDb(db);
        return token;
      });
    },
    async rotateOpenPlayGamePublicShare(sessionId) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        const token = mutateLocalOpenPlayGamePublicShare(db, sessionId, true, true);
        writeDb(db);
        return token;
      });
    },
    async getPublicOpenPlayGameLiveBoard(shareToken) {
      return localOpenPlayLiveBoard(readDb(), shareToken);
    },
    async createOpenPlayGameSession(session) {
      const db = readDb();
      const row = {
        id: localRef('gm'),
        date: session.date,
        time_label: session.timeLabel || null,
        court_ids: session.courtIds || [],
        court_names: session.courtNames || [],
        mode: session.mode || 'smart_random_mixer',
        ranking_mode: normalizeOpenPlayRankingMode(
          session.rankingMode ?? session.ranking_mode
        ),
        status: session.status || 'draft',
        current_round: session.currentRound || 0,
        performance_rating_version: 'pr-performance-v1',
        performance_rating_k: 24,
        performance_rating_scale: 400,
        performance_rating_min_games: 3,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.openPlayGameSessions.unshift(row);
      writeDb(db);
      return row;
    },
    async updateOpenPlayGameSession(id, updates) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        let saved = null;
        db.openPlayGameSessions = db.openPlayGameSessions.map(s => {
          if (String(s.id) !== String(id)) return s;
          const nextStatus = updates.status !== undefined ? updates.status : s.status;
          if (
            ['completed', 'cancelled'].includes(String(s.status || ''))
            && String(nextStatus || '') !== String(s.status || '')
          ) {
            throw new Error('PLAY_MANAGER_SESSION_TERMINAL');
          }
          saved = {
            ...s,
            date: updates.date !== undefined ? updates.date : s.date,
            time_label: updates.timeLabel !== undefined ? updates.timeLabel : s.time_label,
            court_ids: updates.courtIds !== undefined ? updates.courtIds : s.court_ids,
            court_names: updates.courtNames !== undefined ? updates.courtNames : s.court_names,
            mode: updates.mode !== undefined ? updates.mode : s.mode,
            ranking_mode: updates.rankingMode !== undefined || updates.ranking_mode !== undefined
              ? normalizeOpenPlayRankingMode(updates.rankingMode ?? updates.ranking_mode)
              : normalizeOpenPlayRankingMode(s.ranking_mode),
            status: nextStatus,
            current_round: updates.currentRound !== undefined ? updates.currentRound : s.current_round,
            updated_at: nowIso(),
          };
          return saved;
        });
        if (!saved) throw new Error('PLAY_MANAGER_SESSION_NOT_FOUND');
        writeDb(db);
        return saved;
      });
    },
    async getOpenPlayGamePlayers(sessionId) {
      return readDb().openPlayGamePlayers
        .filter(p => String(p.session_id) === String(sessionId))
        .sort((a, b) => Number(a.seed_order || 0) - Number(b.seed_order || 0));
    },
    async addOpenPlayGamePlayer(sessionId, player) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        requireLocalPlayManagerSession(db, sessionId, ['draft', 'active']);
        const row = {
          id: localRef('gmp'),
          session_id: sessionId,
          full_name: player.fullName || player.full_name,
          source_registration_id: player.sourceRegistrationId || player.source_registration_id || null,
          status: player.status || 'active',
          seed_order: Number(player.seedOrder ?? player.seed_order ?? 0),
          skill_level: normalizeOpenPlaySkillLevel(player.skillLevel ?? player.skill_level),
          performance_seed_rating: openPlayPerformanceSeed(
            player.skillLevel ?? player.skill_level
          ),
          queue_entered_at: player.queueEnteredAt || player.queue_entered_at || null,
          created_at: nowIso(),
        };
        db.openPlayGamePlayers.push(row);
        writeDb(db);
        return row;
      });
    },
    async updateOpenPlayGamePlayer(id, updates) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        const index = db.openPlayGamePlayers.findIndex(player => String(player.id) === String(id));
        if (index < 0) throw new Error('PLAY_MANAGER_PLAYER_NOT_FOUND');
        const current = db.openPlayGamePlayers[index];
        requireLocalPlayManagerSession(db, current.session_id, ['draft', 'active']);
        const nextSkillLevel = updates.skillLevel !== undefined || updates.skill_level !== undefined
          ? normalizeOpenPlaySkillLevel(updates.skillLevel ?? updates.skill_level)
          : normalizeOpenPlaySkillLevel(current.skill_level);
        const saved = {
          ...current,
          full_name: updates.fullName !== undefined || updates.full_name !== undefined
            ? String(updates.fullName ?? updates.full_name).trim()
            : current.full_name,
          skill_level: nextSkillLevel,
          performance_seed_rating: localOpenPlayPlayerHasRatedGame(db, current)
            ? Number(current.performance_seed_rating || openPlayPerformanceSeed(current.skill_level))
            : openPlayPerformanceSeed(nextSkillLevel),
        };
        db.openPlayGamePlayers[index] = saved;
        writeDb(db);
        return saved;
      });
    },
    async replaceOpenPlayGamePlayers(sessionId, players) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        requireLocalPlayManagerSession(db, sessionId, ['draft', 'active']);
        db.openPlayGamePlayers = db.openPlayGamePlayers.filter(p => String(p.session_id) !== String(sessionId));
        const rows = players.map((p, i) => {
          const skillLevel = normalizeOpenPlaySkillLevel(p.skillLevel ?? p.skill_level);
          return {
            id: localRef('gmp'),
            session_id: sessionId,
            full_name: p.fullName || p.full_name,
            source_registration_id: p.sourceRegistrationId || p.source_registration_id || null,
            status: p.status || 'active',
            seed_order: i,
            skill_level: skillLevel,
            performance_seed_rating: openPlayPerformanceSeed(skillLevel),
            queue_entered_at: p.queueEnteredAt || p.queue_entered_at || null,
            created_at: nowIso(),
          };
        });
        db.openPlayGamePlayers.push(...rows);
        writeDb(db);
        return rows;
      });
    },
    async syncOpenPlayGameQueueWaitTimes(sessionId, queuePlayerIds) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        requireLocalPlayManagerSession(db, sessionId, ['active']);
        const queuedIds = new Set((queuePlayerIds || []).map(String));
        const enteredAt = nowIso();
        db.openPlayGamePlayers = db.openPlayGamePlayers.map(player => {
          if (String(player.session_id) !== String(sessionId)) return player;
          const isQueued = player.status === 'active' && queuedIds.has(String(player.id));
          return {
            ...player,
            queue_entered_at: isQueued ? (player.queue_entered_at || enteredAt) : null,
          };
        });
        writeDb(db);
        return db.openPlayGamePlayers
          .filter(player => String(player.session_id) === String(sessionId))
          .sort((a, b) =>
            Number(a.seed_order || 0) - Number(b.seed_order || 0) ||
            String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
            String(a.id).localeCompare(String(b.id))
          );
      });
    },
    async getOpenPlayGameRounds(sessionId) {
      return readDb().openPlayGameRounds
        .filter(r => String(r.session_id) === String(sessionId))
        .sort((a, b) => Number(a.round_no || 0) - Number(b.round_no || 0));
    },
    async addOpenPlayGameRound(round) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        const session = requireLocalPlayManagerSession(db, round.sessionId, ['draft', 'active']);
        if (Number(round.roundNo) !== Number(session.current_round || 0) + 1) {
          throw new Error('PLAY_MANAGER_ROUND_CONFLICT');
        }
        const row = {
          id: localRef('gmr'),
          session_id: round.sessionId,
          round_no: round.roundNo,
          assignments: round.assignments || [],
          queue_snapshot: round.queueSnapshot || [],
          partner_history: round.partnerHistory || {},
          opponent_history: round.opponentHistory || {},
          created_at: nowIso(),
          completed_at: round.completedAt || null,
        };
        db.openPlayGameRounds.push(row);
        db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
          String(s.id) === String(round.sessionId)
            ? { ...s, current_round: round.roundNo, status: 'active', updated_at: nowIso() }
            : s
        );
        writeDb(db);
        return row;
      });
    },
    async updateOpenPlayGameRound(id, updates) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        const current = db.openPlayGameRounds.find(r => String(r.id) === String(id));
        if (!current) throw new Error('Open Play round not found.');
        const session = requireLocalPlayManagerSession(db, current.session_id, ['active']);
        if (Number(current.round_no || 0) !== Number(session.current_round || 0)) {
          throw new Error('PLAY_MANAGER_SESSION_NOT_ACTIVE');
        }
        const saved = {
          ...current,
          assignments: updates.assignments !== undefined ? updates.assignments : current.assignments,
          queue_snapshot: updates.queueSnapshot !== undefined ? updates.queueSnapshot : current.queue_snapshot,
          partner_history: updates.partnerHistory !== undefined ? updates.partnerHistory : current.partner_history,
          opponent_history: updates.opponentHistory !== undefined ? updates.opponentHistory : current.opponent_history,
          completed_at: updates.completedAt !== undefined ? updates.completedAt : current.completed_at,
        };
        db.openPlayGameRounds = db.openPlayGameRounds.map(r =>
          String(r.id) === String(id) ? saved : r
        );
        writeDb(db);
        return saved;
      });
    },
    async updateOpenPlayGameRoundIfCurrent(id, expected, updates) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
      const index = db.openPlayGameRounds.findIndex(r => String(r.id) === String(id));
      if (index < 0) throw new Error('Open Play round not found.');
      const current = db.openPlayGameRounds[index];
      const session = requireLocalPlayManagerSession(db, current.session_id, ['active']);
      if (Number(current.round_no || 0) !== Number(session.current_round || 0)) {
        throw new Error('PLAY_MANAGER_SESSION_NOT_ACTIVE');
      }
      const expectedAssignments = expected.assignments || [];
      const expectedQueue = expected.queueSnapshot ?? expected.queue_snapshot ?? [];
      if (
        JSON.stringify(current.assignments || []) !== JSON.stringify(expectedAssignments) ||
        JSON.stringify(current.queue_snapshot || []) !== JSON.stringify(expectedQueue)
      ) {
        throw new Error('PLAY_MANAGER_ROUND_CONFLICT');
      }
      const saved = {
        ...current,
        assignments: updates.assignments !== undefined ? updates.assignments : current.assignments,
        queue_snapshot: updates.queueSnapshot !== undefined ? updates.queueSnapshot : current.queue_snapshot,
      };
      db.openPlayGameRounds[index] = saved;
      writeDb(db);
        return saved;
      });
    },
    async replaceOpenPlayGameCourtPlayer(id, expected, replacement) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
      const roundIndex = db.openPlayGameRounds.findIndex(r => String(r.id) === String(id));
      if (roundIndex < 0) throw new Error('Open Play round not found.');
      const current = db.openPlayGameRounds[roundIndex];
      const expectedAssignments = expected.assignments || [];
      const expectedQueue = expected.queueSnapshot ?? expected.queue_snapshot ?? [];
      if (
        JSON.stringify(current.assignments || []) !== JSON.stringify(expectedAssignments) ||
        JSON.stringify(current.queue_snapshot || []) !== JSON.stringify(expectedQueue)
      ) {
        throw new Error('PLAY_MANAGER_ROUND_CONFLICT');
      }
      const session = db.openPlayGameSessions.find(item => String(item.id) === String(current.session_id));
      const hasNewerRound = db.openPlayGameRounds.some(round =>
        String(round.session_id) === String(current.session_id) &&
        Number(round.round_no || 0) > Number(current.round_no || 0)
      );
      if (
        !session ||
        session.status !== 'active' ||
        current.completed_at ||
        hasNewerRound
      ) {
        throw new Error('PLAY_MANAGER_SESSION_NOT_ACTIVE');
      }
      const courtIndex = Number(replacement.courtIndex);
      const slotIndex = Number(replacement.slotIndex);
      const teamKey = replacement.team === 'B' ? 'teamB' : replacement.team === 'A' ? 'teamA' : '';
      if (!Number.isInteger(courtIndex) || courtIndex < 0 || !Number.isInteger(slotIndex) || slotIndex < 0 || !teamKey) {
        throw new Error('PLAY_MANAGER_REPLACEMENT_SLOT_INVALID');
      }
      const assignments = JSON.parse(JSON.stringify(current.assignments || []));
      const game = assignments[courtIndex];
      if (!game || game.winner || String(game[teamKey]?.[slotIndex]) !== String(replacement.outgoingPlayerId)) {
        throw new Error('PLAY_MANAGER_REPLACEMENT_SLOT_CHANGED');
      }

      const outgoingIndex = db.openPlayGamePlayers.findIndex(player =>
        String(player.id) === String(replacement.outgoingPlayerId) &&
        String(player.session_id) === String(current.session_id) &&
        player.status === 'active'
      );
      if (outgoingIndex < 0) throw new Error('PLAY_MANAGER_REPLACEMENT_PLAYER_NOT_ACTIVE');

      const incomingName = String(replacement.incomingPlayerName || '').trim();
      const incomingId = replacement.incomingPlayerId ? String(replacement.incomingPlayerId) : '';
      if ((!incomingId && !incomingName) || (incomingId && incomingName)) {
        throw new Error('PLAY_MANAGER_REPLACEMENT_PLAYER_REQUIRED');
      }

      let incoming = null;
      if (incomingName) {
        if (incomingName.length > 90) throw new Error('Player name is too long.');
        if (db.openPlayGamePlayers.some(player =>
          String(player.session_id) === String(current.session_id) &&
          String(player.full_name || '').trim().toLowerCase() === incomingName.toLowerCase()
        )) {
          throw new Error('That player is already in the session.');
        }
        incoming = {
          id: localRef('gmp'),
          session_id: current.session_id,
          full_name: incomingName,
          source_registration_id: null,
          status: 'active',
          skill_level: normalizeOpenPlaySkillLevel(
            replacement.incomingPlayerSkillLevel ?? replacement.incoming_player_skill_level
          ),
          performance_seed_rating: openPlayPerformanceSeed(
            replacement.incomingPlayerSkillLevel ?? replacement.incoming_player_skill_level
          ),
          seed_order: db.openPlayGamePlayers
            .filter(player => String(player.session_id) === String(current.session_id))
            .reduce((highest, player) => Math.max(highest, Number(player.seed_order || 0) + 1), 0),
          created_at: nowIso(),
        };
      } else {
        if (String(replacement.outgoingPlayerId) === incomingId) {
          throw new Error('Replacement player must be different.');
        }
        incoming = db.openPlayGamePlayers.find(player =>
          String(player.id) === incomingId &&
          String(player.session_id) === String(current.session_id) &&
          player.status === 'active'
        );
        if (!incoming) throw new Error('PLAY_MANAGER_REPLACEMENT_PLAYER_NOT_ACTIVE');
        const alreadyPlaying = assignments
          .filter(assignment => !assignment.winner)
          .some(assignment =>
            [...(assignment.teamA || []), ...(assignment.teamB || [])]
              .some(playerId => String(playerId) === incomingId)
          );
        if (alreadyPlaying) throw new Error('PLAY_MANAGER_REPLACEMENT_PLAYER_ALREADY_PLAYING');
      }

      game[teamKey][slotIndex] = String(incoming.id);
      game.startedAt = nowIso();
      const players = db.openPlayGamePlayers.map(player =>
        replacement.markOutgoingRemoved === true && String(player.id) === String(replacement.outgoingPlayerId)
          ? { ...player, status: 'removed' }
          : player
      );
      if (incomingName) players.push(incoming);

      const assignedIds = assignments
        .filter(assignment => !assignment.winner)
        .flatMap(assignment =>
          [...(assignment.teamA || []), ...(assignment.teamB || [])].map(String)
        );
      if (assignedIds.length !== new Set(assignedIds).size) {
        throw new Error('PLAY_MANAGER_REPLACEMENT_DUPLICATE_ASSIGNMENT');
      }
      const activeIds = new Set(players
        .filter(player =>
          String(player.session_id) === String(current.session_id) &&
          player.status === 'active'
        )
        .map(player => String(player.id))
      );
      if (assignedIds.some(playerId => !activeIds.has(playerId))) {
        throw new Error('PLAY_MANAGER_REPLACEMENT_PLAYER_NOT_ACTIVE');
      }

      const assignedSet = new Set(assignedIds);
      const outgoingId = String(replacement.outgoingPlayerId);
      const queueSnapshot = [];
      const queueIds = new Set();
      (current.queue_snapshot || []).map(String).forEach(playerId => {
        if (
          playerId !== outgoingId &&
          activeIds.has(playerId) &&
          !assignedSet.has(playerId) &&
          !queueIds.has(playerId)
        ) {
          queueIds.add(playerId);
          queueSnapshot.push(playerId);
        }
      });
      players
        .filter(player =>
          String(player.session_id) === String(current.session_id) &&
          player.status === 'active' &&
          String(player.id) !== outgoingId &&
          !assignedSet.has(String(player.id))
        )
        .sort((a, b) =>
          Number(a.seed_order || 0) - Number(b.seed_order || 0) ||
          String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
          String(a.id).localeCompare(String(b.id))
        )
        .forEach(player => {
          const playerId = String(player.id);
          if (!queueIds.has(playerId)) {
            queueIds.add(playerId);
            queueSnapshot.push(playerId);
          }
        });
      if (!replacement.markOutgoingRemoved) {
        queueIds.add(outgoingId);
        queueSnapshot.push(outgoingId);
      }

      const saved = {
        ...current,
        assignments,
        queue_snapshot: queueSnapshot,
      };
      db.openPlayGameRounds[roundIndex] = saved;
      db.openPlayGamePlayers = players;
      writeDb(db);
        return {
          round: saved,
          incoming_player: incoming,
          created_walk_in: Boolean(incomingName),
        };
      });
    },
    async correctOpenPlayGameMatchWinner(id, expected, correction) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        const roundIndex = db.openPlayGameRounds.findIndex(round => String(round.id) === String(id));
        if (roundIndex < 0) throw new Error('PLAY_MANAGER_ROUND_NOT_FOUND');
        const current = db.openPlayGameRounds[roundIndex];
        if (JSON.stringify(current.assignments || []) !== JSON.stringify(expected.assignments || [])) {
          throw new Error('PLAY_MANAGER_ROUND_CONFLICT');
        }

        const session = db.openPlayGameSessions.find(item =>
          String(item.id) === String(current.session_id)
        );
        const role = window.Auth?.getSession?.()?.role || '';
        const staffRoles = new Set(['owner', 'court_owner', 'staff']);
        if (
          !session ||
          (['active', 'paused'].includes(session.status) && !staffRoles.has(role)) ||
          (session.status === 'completed' && role !== 'owner') ||
          !['active', 'paused', 'completed'].includes(session.status)
        ) {
          throw new Error('PLAY_MANAGER_WINNER_CORRECTION_FORBIDDEN');
        }

        const courtIndex = Number(correction.courtIndex);
        const completedGameIndex = correction.completedGameIndex === null ||
          correction.completedGameIndex === undefined
          ? null
          : Number(correction.completedGameIndex);
        const expectedWinner = correction.expectedWinner;
        const newWinner = correction.newWinner;
        if (
          !Number.isInteger(courtIndex) ||
          courtIndex < 0 ||
          (completedGameIndex !== null && (!Number.isInteger(completedGameIndex) || completedGameIndex < 0)) ||
          !['A', 'B'].includes(expectedWinner) ||
          !['A', 'B'].includes(newWinner) ||
          expectedWinner === newWinner
        ) {
          throw new Error('PLAY_MANAGER_WINNER_CORRECTION_INVALID');
        }

        const assignments = JSON.parse(JSON.stringify(current.assignments || []));
        const game = assignments[courtIndex];
        const result = completedGameIndex === null
          ? game
          : game?.completedGames?.[completedGameIndex];
        if (!result || result.winner !== expectedWinner) {
          throw new Error('PLAY_MANAGER_WINNER_CORRECTION_CHANGED');
        }

        const correctedAt = nowIso();
        result.winnerCorrections = [
          ...(Array.isArray(result.winnerCorrections) ? result.winnerCorrections : []),
          {
            previousWinner: expectedWinner,
            winner: newWinner,
            correctedAt,
            correctedBy: window.Auth?.getSession?.()?.id || null,
          },
        ];
        result.winner = newWinner;
        const saved = { ...current, assignments };
        db.openPlayGameRounds[roundIndex] = saved;
        writeDb(db);
        return saved;
      });
    },
    async deleteLatestOpenPlayGameRound(sessionId) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        requireLocalPlayManagerSession(db, sessionId, ['active']);
        const rounds = db.openPlayGameRounds
          .filter(r => String(r.session_id) === String(sessionId))
          .sort((a, b) => Number(a.round_no || 0) - Number(b.round_no || 0));
        const last = rounds[rounds.length - 1];
        if (!last) return null;
        db.openPlayGameRounds = db.openPlayGameRounds.filter(r => String(r.id) !== String(last.id));
        db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
          String(s.id) === String(sessionId)
            ? { ...s, current_round: Math.max(0, Number(last.round_no || 1) - 1), updated_at: nowIso() }
            : s
        );
        writeDb(db);
        return last;
      });
    },
    async clearOpenPlayGameRounds(sessionId) {
      return withLocalPlayManagerLock(async () => {
        const db = readDb();
        requireLocalPlayManagerSession(db, sessionId, ['draft', 'active']);
        db.openPlayGameRounds = db.openPlayGameRounds.filter(r => String(r.session_id) !== String(sessionId));
        db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
          String(s.id) === String(sessionId)
            ? { ...s, current_round: 0, status: 'draft', updated_at: nowIso() }
            : s
        );
        writeDb(db);
      });
    },

    async getBlockedDates() { return readDb().blockedDates; },
    async addBlockedDate(date) {
      const db = readDb();
      if (!db.blockedDates.includes(date)) db.blockedDates.push(date);
      db.blockedDates.sort();
      writeDb(db);
    },
    async removeBlockedDate(date) {
      const db = readDb();
      db.blockedDates = db.blockedDates.filter(d => d !== date);
      writeDb(db);
    },

    async getAccounts() { return readDb().accounts; },
    async getHostFinanceAccounts() {
      const role = window.Auth?.getSession?.()?.role || '';
      if (!['owner', 'court_owner'].includes(role)) {
        const error = new Error('Only system owners and court owners can view host finance accounts.');
        error.code = 'HOST_ACCOUNTS_VIEW_NOT_ALLOWED';
        throw error;
      }
      return readDb().accounts
        .filter(account => account.role === 'host')
        .map(rowToHostFinanceAccount)
        .filter(account => account.id)
        .sort((a, b) =>
          String(a.fullName || '').localeCompare(String(b.fullName || '')) ||
          String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        );
    },
    async getHostFinanceBookings(hostUserId) {
      const role = window.Auth?.getSession?.()?.role || '';
      if (!['owner', 'court_owner'].includes(role)) {
        const error = new Error('Only system owners and court owners can view host finance bookings.');
        error.code = 'HOST_FINANCE_VIEW_NOT_ALLOWED';
        throw error;
      }
      const id = String(hostUserId || '').trim();
      if (!id || !readDb().accounts.some(account => account.role === 'host' && String(account.id) === id)) {
        throw new Error('Host account not found.');
      }
      return readDb().bookings
        .filter(booking => booking.hostBooking && booking.email !== 'reserve@hold.internal')
        .filter(booking => String(booking.hostUserId || booking.createdByUserId || '') === id)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async saveAccount(account) {
      const db = readDb();
      const idx = db.accounts.findIndex(a => String(a.id) === String(account.id));
      if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...account };
      else db.accounts.push({ ...account, id: account.id || localRef('acc'), createdAt: account.createdAt || nowIso() });
      writeDb(db);
    },
    async deleteAccount(id) {
      const db = readDb();
      db.accounts = db.accounts.filter(a => String(a.id) !== String(id));
      writeDb(db);
    },

    async getSettings() { return readDb().settings; },
    async saveSetting(key, value) {
      const db = readDb();
      db.settings[key] = value;
      writeDb(db);
    },
    clearCache() {},

    async createPaymentSession() { throw new Error('Online checkout is disabled in local data mode.'); },
    async sendConfirmationEmail() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendHostBalanceNotice() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async processHostBalanceDeadlines() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async getBookingBalanceNotifications() { return []; },
    async sendRescheduleEmail() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendGroupedRescheduleEmail() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendBookingStatusEmail() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendTelegramNotification() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async confirmOpenPlayHostVerification() { return { ok: true, reviewable: true, skipped: true, reason: 'Local data mode' }; },
    async dispatchOpenPlayHostReviewNotifications() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendOpenPlayHostTelegramTest() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async notifyBookingSubmitted() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async notifyBookingUpdate() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async getIntegrationStatus() {
      return {
        ok: true,
        local: true,
        services: [
          { id: 'email', label: 'Email confirmations (Maileroo)', configured: false, required: ['MAILEROO_API_KEY', 'MAILEROO_FROM_ADDRESS'], missing: ['MAILEROO_API_KEY', 'MAILEROO_FROM_ADDRESS'], note: 'Local data mode' },
          { id: 'telegram', label: 'Telegram admin alerts', configured: false, required: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], missing: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], note: 'Local data mode' },
          { id: 'payments', label: 'PayMongo checkout', configured: false, required: ['PAYMONGO_SECRET_KEY', 'PAYMENT_SUCCESS_URL', 'PAYMENT_CANCEL_URL'], missing: ['PAYMONGO_SECRET_KEY', 'PAYMENT_SUCCESS_URL', 'PAYMENT_CANCEL_URL'], note: 'Local data mode' },
          { id: 'ocr', label: 'Receipt OCR', configured: false, required: ['GOOGLE_VISION_API_KEY'], missing: ['GOOGLE_VISION_API_KEY'], note: 'Local data mode' },
          { id: 'service_role', label: 'Server database access', configured: false, required: ['SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY'], missing: ['SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY'], note: 'Local data mode' },
        ],
      };
    },
    async stageBookingReceipt(payload) {
      const bookingRef = String(payload?.bookingRef || '').trim();
      if (!bookingRef || !payload?.imageFile) throw new Error('Booking reference and receipt are required.');
      const imageFile = await _pbPrepareReceiptImage(payload.imageFile);
      const stagedReceiptPath = `local:${bookingRef}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const contentType = imageFile.type || payload.contentType || 'image/jpeg';
      const size = Number(imageFile.size || 0);
      const stagedAt = nowIso();
      const receiptImageUrl = await _pbFileToDataUrl(imageFile);
      const db = readDb();
      const target = db.bookings.find(booking => String(booking.ref) === bookingRef);
      if (!target) throw new Error('Booking not found.');
      const groupRef = String(target.groupRef || target.bookingGroupRef || '');
      db.bookings = db.bookings.map(booking => {
        const sameBooking = String(booking.ref) === bookingRef;
        const sameGroup = groupRef && String(booking.groupRef || booking.bookingGroupRef || '') === groupRef;
        return sameBooking || sameGroup
          ? {
            ...booking,
            receiptImageUrl,
            receiptImageHash: null,
            receiptStatus: 'manual_review',
            receiptFlags: [],
            receiptExtracted: null,
            receiptConfidence: null,
            receiptVerifiedAt: null,
            receiptStagedPath: stagedReceiptPath,
            receiptStagedAt: stagedAt,
            receiptContentType: contentType,
            receiptImageSize: size,
          }
          : booking;
      });
      writeDb(db);
      _pbLocalStagedReceipts.set(stagedReceiptPath, {
        bookingRef,
        imageFile,
        receiptImageUrl,
        contentType,
        size,
        stagedAt,
      });
      return {
        ok: true,
        found: true,
        bookingRef,
        stagedReceiptPath,
        receiptImageUrl,
        receiptImageHash: null,
        receiptStatus: 'manual_review',
        receiptFlags: [],
        receiptVerifiedAt: null,
        verified: false,
        contentType,
        size,
        stagedAt,
      };
    },
    async recoverBookingReceipt(bookingRef) {
      const normalizedRef = String(bookingRef || '').trim();
      if (!normalizedRef) throw new Error('Booking reference is required.');
      const db = readDb();
      const target = db.bookings.find(booking => String(booking.ref) === normalizedRef);
      if (!target) return null;
      const groupRef = String(target.groupRef || target.bookingGroupRef || '');
      const stagedBooking = db.bookings.find(booking => {
        const sameBooking = String(booking.ref) === normalizedRef;
        const sameGroup = groupRef && String(booking.groupRef || booking.bookingGroupRef || '') === groupRef;
        return (sameBooking || sameGroup) &&
          !!booking.receiptStagedPath &&
          !booking.receiptVerifiedAt;
      });
      if (!stagedBooking) return null;
      const stagedReceiptPath = String(stagedBooking.receiptStagedPath || '');
      const memoryStage = _pbLocalStagedReceipts.get(stagedReceiptPath) || {};
      const receiptImageUrl = String(
        memoryStage.receiptImageUrl || stagedBooking.receiptImageUrl || '',
      );
      if (!memoryStage.bookingRef && receiptImageUrl) {
        _pbLocalStagedReceipts.set(stagedReceiptPath, {
          bookingRef: normalizedRef,
          imageFile: null,
          receiptImageUrl,
          contentType: stagedBooking.receiptContentType || '',
          size: Number(stagedBooking.receiptImageSize || 0),
          stagedAt: stagedBooking.receiptStagedAt || null,
        });
      }
      return {
        ok: true,
        found: true,
        bookingRef: normalizedRef,
        stagedReceiptPath,
        receiptImageUrl,
        receiptImageHash: stagedBooking.receiptImageHash || null,
        receiptStatus: String(stagedBooking.receiptStatus || 'manual_review'),
        receiptFlags: Array.isArray(stagedBooking.receiptFlags) ? stagedBooking.receiptFlags : [],
        receiptVerifiedAt: null,
        verified: false,
        contentType: String(memoryStage.contentType || stagedBooking.receiptContentType || ''),
        size: Number(memoryStage.size || stagedBooking.receiptImageSize || 0),
        stagedAt: memoryStage.stagedAt || stagedBooking.receiptStagedAt || null,
      };
    },
    async discardBookingReceipt(payload = {}) {
      const bookingRef = String(payload?.bookingRef || '').trim();
      const stagedReceiptPath = String(payload?.stagedReceiptPath || '').trim();
      if (!bookingRef || !stagedReceiptPath) {
        throw new Error('Booking reference and staged receipt path are required.');
      }
      const db = readDb();
      const target = db.bookings.find(booking => String(booking.ref) === bookingRef);
      const groupRef = String(target?.groupRef || target?.bookingGroupRef || '');
      let discarded = false;
      db.bookings = db.bookings.map(booking => {
        const sameBooking = String(booking.ref) === bookingRef;
        const sameGroup = groupRef && String(booking.groupRef || booking.bookingGroupRef || '') === groupRef;
        const unverifiedStage = (sameBooking || sameGroup) &&
          String(booking.receiptStagedPath || '') === stagedReceiptPath &&
          !booking.receiptVerifiedAt;
        if (!unverifiedStage) return booking;
        discarded = true;
        return {
          ...booking,
          receiptImageUrl: null,
          receiptImageHash: null,
          receiptStatus: 'none',
          receiptFlags: [],
          receiptExtracted: null,
          receiptConfidence: null,
          receiptVerifiedAt: null,
          receiptStagedPath: null,
          receiptStagedAt: null,
          receiptContentType: null,
          receiptImageSize: null,
        };
      });
      if (discarded) writeDb(db);
      _pbLocalStagedReceipts.delete(stagedReceiptPath);
      return { ok: true, bookingRef, stagedReceiptPath, discarded };
    },
    async verifyGcashReceipt(payload = {}) {
      const bookingRef = String(payload?.bookingRef || '').trim();
      let imageFile = payload?.imageFile || null;
      const stagedReceiptPath = String(payload?.stagedReceiptPath || '');
      let receiptImageUrl = '';
      if (stagedReceiptPath) {
        const staged = _pbLocalStagedReceipts.get(stagedReceiptPath);
        const db = readDb();
        const target = db.bookings.find(booking => String(booking.ref) === bookingRef);
        const persistedStageMatches = target &&
          String(target.receiptStagedPath || '') === stagedReceiptPath &&
          !target.receiptVerifiedAt;
        if ((!staged || staged.bookingRef !== bookingRef) && !persistedStageMatches) {
          throw new Error('The staged receipt is no longer available.');
        }
        imageFile = staged?.imageFile || null;
        receiptImageUrl = String(staged?.receiptImageUrl || target?.receiptImageUrl || '');
      }
      if (!receiptImageUrl && imageFile) receiptImageUrl = await _pbFileToDataUrl(imageFile);
      if (!receiptImageUrl) throw new Error('Receipt screenshot is required.');
      if (stagedReceiptPath) _pbLocalStagedReceipts.delete(stagedReceiptPath);
      const receiptVerifiedAt = nowIso();
      const db = readDb();
      const target = db.bookings.find(b => String(b.ref) === bookingRef);
      const groupRef = target?.groupRef || target?.bookingGroupRef || '';
      db.bookings = db.bookings.map(booking => {
        const sameBooking = String(booking.ref) === bookingRef;
        const sameGroup = groupRef && String(booking.groupRef || booking.bookingGroupRef || '') === String(groupRef);
        return sameBooking || sameGroup
          ? {
            ...booking,
            status: 'pending',
            paymentStatus: 'for_verification',
            receiptImageUrl,
            receiptStatus: 'manual_review',
            receiptFlags: ['local_data_mode'],
            receiptExtracted: {},
            receiptConfidence: 0,
            receiptVerifiedAt,
            receiptStagedPath: null,
            receiptStagedAt: null,
            receiptContentType: null,
            receiptImageSize: null,
          }
          : booking;
      });
      writeDb(db);
      return {
        ok: true,
        status: 'manual_review',
        flags: ['local_data_mode'],
        extracted: {},
        confidence: 0,
        receiptImageUrl,
        receiptVerifiedAt,
        message: 'Local data mode: receipt stored for manual review; OCR is not sent to Supabase.',
      };
    },
    async getReceiptSignedUrl() { throw new Error('No stored receipt in local data mode.'); },
    async getOpenPlayReceiptSignedUrl() { throw new Error('No stored receipt in local data mode.'); },

    async seedDefaultData() { readDb(); },
    async getAgreement(userId, version = 1) {
      return readDb().agreements.find(a => String(a.userId) === String(userId) && Number(a.version) === Number(version)) || null;
    },
    async saveAgreement(data) {
      const db = readDb();
      const version = data.version || 1;
      const idx = db.agreements.findIndex(a => String(a.userId) === String(data.userId) && Number(a.version || 1) === Number(version));
      const row = { ...data, version, agreedAt: nowIso() };
      if (idx >= 0) db.agreements[idx] = row;
      else db.agreements.push(row);
      writeDb(db);
    },
    async getBookingFeeRemittanceDashboard() {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth() + (now.getDate() > 14 ? 1 : 0), 14);
      const role = Auth.getSession()?.role || 'court_owner';
      const roundLedger = value => Math.round((Number(value) || 0) * 100) / 100;
      const reservationKeyFor = booking => {
        const groupRef = String(
          booking.groupRef || booking.bookingGroupRef || booking.booking_group_ref || '',
        ).trim();
        const bookingRef = String(booking.ref || '').trim();
        return groupRef ? `group:${groupRef}` : bookingRef ? `booking:${bookingRef}` : '';
      };
      const earned = readDb().bookings.filter(booking => {
        const earnedAt = booking.bookingFeeEarnedAt || booking.booking_fee_earned_at;
        const transferredOut = booking.paymentReassignedToRef || booking.payment_reassigned_to_ref;
        const eligible = booking.bookingFeeLedgerEligibleSnapshot
          ?? booking.booking_fee_ledger_eligible_snapshot;
        const amount = Number(
          booking.bookingFeeAmountSnapshot ?? booking.booking_fee_amount_snapshot ?? 0,
        );
        return !!earnedAt && !transferredOut && eligible !== false && Number.isFinite(amount) && amount > 0;
      });
      const reservations = new Set(earned.map(reservationKeyFor).filter(Boolean));
      const breakdown = new Map();
      const courtBreakdown = new Map();
      let billableHours = 0;
      let accumulatedAmount = 0;
      earned.forEach(booking => {
        const reservationKey = reservationKeyFor(booking);
        const type = String(
          booking.bookingFeeTypeSnapshot ?? booking.booking_fee_type_snapshot ?? 'per_hour',
        ).toLowerCase() === 'flat' ? 'flat' : 'per_hour';
        const rate = Math.max(0, Number(
          booking.bookingFeeRateSnapshot ?? booking.booking_fee_rate_snapshot ?? 0,
        ) || 0);
        const units = Math.max(0, Number(
          booking.bookingFeeUnitsSnapshot ?? booking.booking_fee_units_snapshot ?? 0,
        ) || 0);
        const amount = Math.max(0, Number(
          booking.bookingFeeAmountSnapshot ?? booking.booking_fee_amount_snapshot ?? 0,
        ) || 0);
        const courtId = String(
          booking.courtId ?? booking.court_id ?? '',
        ).trim();
        const courtName = String(booking.courtName ?? booking.court_name ?? '').trim();
        const courtKey = courtId
          ? `court-id:${courtId}`
          : courtName
            ? `court-name:${courtName.toLowerCase().replace(/\s+/g, ' ')}`
            : 'court-unknown';
        const courtKeySource = courtId
          ? 'court_id'
          : courtName
            ? 'court_name_fallback'
            : 'unknown';
        const key = `${type}|${rate.toFixed(2)}`;
        const row = breakdown.get(key) || {
          fee_type: type,
          fee_rate: rate,
          booking_rows_count: 0,
          reservation_count: 0,
          fee_units: 0,
          billable_hours: 0,
          amount: 0,
          _reservationKeys: new Set(),
        };
        row.booking_rows_count += 1;
        if (reservationKey) row._reservationKeys.add(reservationKey);
        row.fee_units += units;
        row.billable_hours += type === 'per_hour' ? units : 0;
        row.amount += amount;
        breakdown.set(key, row);

        const court = courtBreakdown.get(courtKey) || {
          court_key: courtKey,
          court_key_source: courtKeySource,
          court_id: courtId || null,
          court_name: courtName || null,
          booking_rows_count: 0,
          reservation_count: 0,
          billable_hours: 0,
          court_hours: 0,
          flat_fee_booking_count: 0,
          gross_booking_fee_amount: 0,
          adjustment_count: 0,
          adjustment_amount: 0,
          net_contribution: 0,
          fee_breakdown: new Map(),
          _reservationKeys: new Set(),
        };
        court.booking_rows_count += 1;
        if (reservationKey) court._reservationKeys.add(reservationKey);
        court.billable_hours += type === 'per_hour' ? units : 0;
        court.court_hours = court.billable_hours;
        court.flat_fee_booking_count += type === 'flat' ? 1 : 0;
        court.gross_booking_fee_amount += amount;
        court.net_contribution += amount;

        const courtRate = court.fee_breakdown.get(key) || {
          fee_type: type,
          fee_rate: rate,
          booking_rows_count: 0,
          reservation_count: 0,
          fee_units: 0,
          unit_count: 0,
          billable_hours: 0,
          court_hours: 0,
          flat_fee_booking_count: 0,
          amount: 0,
          _reservationKeys: new Set(),
        };
        courtRate.booking_rows_count += 1;
        if (reservationKey) courtRate._reservationKeys.add(reservationKey);
        courtRate.fee_units += units;
        courtRate.unit_count = courtRate.fee_units;
        courtRate.billable_hours += type === 'per_hour' ? units : 0;
        courtRate.court_hours = courtRate.billable_hours;
        courtRate.flat_fee_booking_count += type === 'flat' ? 1 : 0;
        courtRate.amount += amount;
        court.fee_breakdown.set(key, courtRate);
        courtBreakdown.set(courtKey, court);

        billableHours += type === 'per_hour' ? units : 0;
        accumulatedAmount += amount;
      });
      for (const row of breakdown.values()) {
        row.reservation_count = row._reservationKeys.size;
        row.booking_count = row.booking_rows_count;
        row.item_count = row.booking_rows_count;
        row.flat_fee_booking_count = row.fee_type === 'flat' ? row.booking_rows_count : 0;
        row.fee_units = roundLedger(row.fee_units);
        row.unit_count = row.fee_units;
        row.billable_hours = roundLedger(row.billable_hours);
        row.court_hours = row.billable_hours;
        row.amount = roundLedger(row.amount);
        delete row._reservationKeys;
      }
      const rateRows = [...breakdown.values()].sort((a, b) => {
        const typeOrder = value => value === 'per_hour' ? 1 : 2;
        return typeOrder(a.fee_type) - typeOrder(b.fee_type) || a.fee_rate - b.fee_rate;
      });
      const courtRows = [...courtBreakdown.values()].map(court => {
        court.reservation_count = court._reservationKeys.size;
        court.billable_hours = roundLedger(court.billable_hours);
        court.court_hours = court.billable_hours;
        court.gross_booking_fee_amount = roundLedger(court.gross_booking_fee_amount);
        court.adjustment_amount = roundLedger(court.adjustment_amount);
        court.net_contribution = roundLedger(court.gross_booking_fee_amount + court.adjustment_amount);
        court.fee_breakdown = [...court.fee_breakdown.values()].map(rateRow => {
          rateRow.reservation_count = rateRow._reservationKeys.size;
          rateRow.booking_count = rateRow.booking_rows_count;
          rateRow.item_count = rateRow.booking_rows_count;
          rateRow.fee_units = roundLedger(rateRow.fee_units);
          rateRow.unit_count = rateRow.fee_units;
          rateRow.billable_hours = roundLedger(rateRow.billable_hours);
          rateRow.court_hours = rateRow.billable_hours;
          rateRow.amount = roundLedger(rateRow.amount);
          delete rateRow._reservationKeys;
          return rateRow;
        }).sort((a, b) => {
          const typeOrder = value => value === 'per_hour' ? 1 : 2;
          return typeOrder(a.fee_type) - typeOrder(b.fee_type) || a.fee_rate - b.fee_rate;
        });
        court.rate_type_breakdown = court.fee_breakdown;
        delete court._reservationKeys;
        return court;
      }).sort((a, b) => String(a.court_name || a.court_id || a.court_key)
        .localeCompare(String(b.court_name || b.court_id || b.court_key))
        || a.court_key.localeCompare(b.court_key));
      const earnedTimes = earned
        .map(booking => booking.bookingFeeEarnedAt || booking.booking_fee_earned_at)
        .filter(Boolean)
        .sort();
      const accumulatedGross = roundLedger(accumulatedAmount);
      const flatFeeBookingCount = rateRows.reduce(
        (sum, row) => sum + (Number(row.flat_fee_booking_count) || 0),
        0,
      );
      const courtTotals = courtRows.reduce((totals, row) => ({
        booking_rows_count: totals.booking_rows_count + row.booking_rows_count,
        billable_hours: totals.billable_hours + row.billable_hours,
        flat_fee_booking_count: totals.flat_fee_booking_count + row.flat_fee_booking_count,
        gross_booking_fee_amount: totals.gross_booking_fee_amount + row.gross_booking_fee_amount,
        attributed_adjustment_amount: totals.attributed_adjustment_amount + row.adjustment_amount,
        net_contribution: totals.net_contribution + row.net_contribution,
      }), {
        booking_rows_count: 0,
        billable_hours: 0,
        flat_fee_booking_count: 0,
        gross_booking_fee_amount: 0,
        attributed_adjustment_amount: 0,
        net_contribution: 0,
      });
      Object.keys(courtTotals).forEach(key => { courtTotals[key] = roundLedger(courtTotals[key]); });
      courtTotals.court_hours = courtTotals.billable_hours;
      const live = {
        bookings_count: earned.length,
        reservation_count: reservations.size,
        booking_rows_count: earned.length,
        billable_hours: roundLedger(billableHours),
        court_hours: roundLedger(billableHours),
        flat_fee_booking_count: flatFeeBookingCount,
        fee_breakdown: rateRows,
        rate_type_breakdown: rateRows,
        court_breakdown: courtRows,
        court_breakdown_meta: {
          version: 1,
          basis: 'local_earned_booking_fee_snapshots',
          court_grouping: 'court_id_then_normalized_court_name_then_unknown',
          reservation_count_scope: 'distinct_within_each_court',
          reservation_count_additive: false,
          adjustment_attribution: {
            basis: 'not_available_local_data',
            coverage: 'not_applicable',
            exactly_attributed_rows_included: true,
            top_level_count: 0,
            top_level_amount: 0,
            attributed_count: 0,
            attributed_amount: 0,
            unattributed_count: 0,
            unattributed_amount: 0,
            unknown_court_count: 0,
          },
          court_totals: courtTotals,
          reconciliation: {
            booking_rows_match: courtTotals.booking_rows_count === earned.length,
            billable_hours_match: courtTotals.billable_hours === roundLedger(billableHours),
            flat_fee_booking_count_match: courtTotals.flat_fee_booking_count === flatFeeBookingCount,
            gross_booking_fee_amount_match: courtTotals.gross_booking_fee_amount === accumulatedGross,
            adjustment_amount_match: courtTotals.attributed_adjustment_amount === 0,
            net_amount_match: courtTotals.net_contribution === accumulatedGross,
          },
        },
        gross_booking_fee_amount: accumulatedGross,
        adjustment_count: 0,
        adjustment_amount: 0,
        net_amount: accumulatedGross,
        credit_carryforward: 0,
        amount: accumulatedGross,
        coverage_start_at: earnedTimes[0] || null,
      };
      return {
        server_now: now.toISOString(),
        timezone: 'Asia/Manila',
        role,
        next_due_on: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-14`,
        can_prepare: false,
        can_owner_override: role === 'owner',
        accumulated: live,
        live,
        open_remaining_balance: 0,
        total_outstanding_balance: live.amount,
        accepted_total: 0,
        settled_total: 0,
        open_remittances: [],
        active: [],
        history: [],
      };
    },
    async getBookingFeeRemittanceHistory() { return []; },
    async getBookingFeeRemittanceDetail() { return null; },
    async prepareBookingFeeRemittance() { throw new Error('Remittance preparation requires Supabase.'); },
    async submitBookingFeeRemittance() { throw new Error('Remittance submission requires Supabase.'); },
    async getBookingFeeRemittanceProofUrl() { throw new Error('No remittance receipt is stored in local data mode.'); },
    async getBookingFeeRemittanceProofSignedUrl() { throw new Error('No remittance receipt is stored in local data mode.'); },
    async reviewBookingFeeRemittancePayment() { throw new Error('Remittance review requires Supabase.'); },
    async cancelBookingFeeRemittance() { throw new Error('Remittance cancellation requires Supabase.'); },
    async getWeeklyFees() { return readDb().weeklyFees; },
    async saveWeeklyFee(statement) {
      const db = readDb();
      const row = { ...statement, id: statement.id || localRef('fee'), generatedAt: statement.generatedAt || nowIso() };
      db.weeklyFees.unshift(row);
      writeDb(db);
      return row;
    },
    async updateWeeklyFee(id, updates) {
      const db = readDb();
      db.weeklyFees = db.weeklyFees.map(f => String(f.id) === String(id) ? { ...f, ...updates } : f);
      writeDb(db);
    },
    async submitWeeklyFeePayment(id, data) {
      await this.updateWeeklyFee(id, { ...data, status: 'submitted', submittedAt: nowIso() });
    },
  };

  window.PB_RESET_LOCAL_DATA = function resetLocalData() {
    localStorage.removeItem(STORE_KEY);
    return readDb();
  };

  console.info('[Pickle Street Tugbok] Local data mode enabled. Supabase writes are bypassed in this browser.');
})();

window.Auth = {

  // ── Role model ──────────────────────────────────────────
  // owner       → System Owner   (full access: everything + accounts)
  // court_owner → Court Owner    (operations + payment settings, no account mgmt)
  // staff       → Court Staff    (front-desk: bookings, payment review, open play)
  ROLES: ['owner', 'court_owner', 'staff', 'host'],
  ROLE_LABELS: { owner: 'System Owner', court_owner: 'Court Owner', staff: 'Court Staff', host: 'Open Play Host' },
  ROLE_PERMISSIONS: {
    owner:       ['dashboard', 'insights', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'host_accounts_view', 'remittances', 'maintenance', 'payments', 'accounts', 'booking_delete', 'export', 'settings', 'owner_only'],
    court_owner: ['dashboard', 'insights', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'host_accounts_view', 'remittances', 'maintenance', 'payments', 'export', 'settings', 'court_owner_only'],
    staff:       ['bookings', 'open_play', 'payment_review'],
    host:        ['host_open_play'],
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
    const { data: authData, error } = await _sb.auth.getUser();
    if (error || !authData?.user) {
      this._lastLoginMessage = error
        ? 'Could not verify your sign-in right now. Please check your connection and try again.'
        : 'Your sign-in session is no longer available. Please log in again.';
      return null;
    }

    const { data: acc, error: accountErr } = await _sb
      .from('accounts')
      .select('*')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (accountErr) {
      console.error('refreshSessionFromAuth account lookup:', accountErr);
      this._lastLoginMessage = 'Could not verify your account status right now. Please try again in a moment.';
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      return null;
    }

    if (!acc) {
      const meta = authData.user.user_metadata || {};
      if (meta.role === 'host' && meta.account_status === 'pending') {
        this._lastLoginMessage = 'Your host application is pending review.';
      } else if (meta.role === 'host' && meta.account_status === 'suspended') {
        this._lastLoginMessage = 'Your host application was not approved. Please contact the court owner.';
      } else {
        this._lastLoginMessage = 'This login is not linked to a dashboard account.';
      }
      await _sb.auth.signOut();
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      return null;
    }

    const session = { ...rowToAccount(acc), loginAt: new Date().toISOString() };

    if (session.status && session.status !== 'active') {
      this._lastLoginMessage = session.status === 'pending'
        ? 'Your host application is pending review.'
        : 'This account is not active. Please contact the court owner.';
      await _sb.auth.signOut();
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      return null;
    }

    const shouldRemember = remember === null ? localStorage.getItem('pb_remember') === '1' : !!remember;
    sessionStorage.removeItem('pb_session');
    localStorage.removeItem('pb_session');
    const store = shouldRemember ? localStorage : sessionStorage;
    store.setItem('pb_session', JSON.stringify(session));
    if (shouldRemember) localStorage.setItem('pb_remember', '1');
    else localStorage.removeItem('pb_remember');
    return session;
  },

  async login(email, password, remember = false) {
    // Sign in via Supabase Auth — establishes a verified JWT session.
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { ok: false, msg: error?.message || 'Invalid email or password.' };
    this._lastLoginMessage = '';
    const session = await this.refreshSessionFromAuth({ remember });
    return session ? { ok: true } : { ok: false, msg: this._lastLoginMessage || 'Account is not active.' };
  },

  getSession() {
    // Check localStorage first (remembered), then sessionStorage (tab-only).
    const s = localStorage.getItem('pb_session') || sessionStorage.getItem('pb_session');
    if (!s) return null;
    try { return JSON.parse(s); }
    catch (_) {
      localStorage.removeItem('pb_session');
      sessionStorage.removeItem('pb_session');
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
    sessionStorage.removeItem('pb_session');
    localStorage.removeItem('pb_session');
    localStorage.removeItem('pb_remember');
    window.location.href = 'login.html';
  },

  // Used by admin.html account management
  async getAll() {
    return DB.getAccounts();
  },

  async add(d) {
    try {
      await _invokeEdgeFunction('manage-account', {
        action: 'create',
        fullName: d.fullName,
        username: d.username,
        email: d.email,
        password: d.password,
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
        status: d.status || 'active',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account create failed.') };
    }
  },

  async update(id, d) {
    try {
      await _invokeEdgeFunction('manage-account', {
        action: 'update',
        id,
        fullName: d.fullName,
        username: d.username,
        email: d.email,
        password: d.password || '',
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
        status: d.status || 'active',
      });
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
    if (!newPassword || newPassword.length < 6) return { ok: false, msg: 'New password must be at least 6 characters.' };

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
      await _invokeEdgeFunction('manage-account', { action: 'delete', id });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account delete failed.') };
    }
  },
};

if (window.PB_USE_LOCAL_DATA) {
  Object.assign(window.Auth, {
    async login(usernameOrEmail, password, remember = false) {
      const accounts = await DB.getAccounts();
      const user = accounts.find(a =>
        (a.username === usernameOrEmail || a.email === usernameOrEmail) &&
        (!a.password || a.password === password)
      );
      if (!user) return { ok: false, msg: 'Invalid email or password.' };
      if (user.status && user.status !== 'active') {
        return {
          ok: false,
          msg: user.status === 'pending'
            ? 'Your host application is pending review.'
            : 'This account is not active. Please contact the court owner.',
        };
      }
      const session = { ...user, loginAt: new Date().toISOString(), isLocalData: true };
      const store = remember ? localStorage : sessionStorage;
      store.setItem('pb_session', JSON.stringify(session));
      if (remember) localStorage.setItem('pb_remember', '1');
      return { ok: true };
    },

    async logout() {
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      localStorage.removeItem('pb_remember');
      window.location.href = 'login.html';
    },

    async add(d) {
      const all = await DB.getAccounts();
      if (all.find(x => x.username === d.username || x.email === d.email)) return { ok: false, msg: 'Username or email already exists.' };
      const acc = {
        id: `local_${Date.now().toString(36)}`,
        fullName: d.fullName,
        username: d.username,
        password: d.password,
        email: d.email,
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
        status: d.status || 'active',
        createdAt: new Date().toISOString(),
      };
      await DB.saveAccount(acc);
      return { ok: true };
    },

    async changePassword(currentPassword, newPassword) {
      const sess = this.getSession();
      if (!sess) return { ok: false, msg: 'No active session. Please sign in again.' };
      const accounts = await DB.getAccounts();
      const user = accounts.find(a => String(a.id) === String(sess.id));
      if (user?.password && user.password !== currentPassword) return { ok: false, msg: 'Current password is incorrect.' };
      if (!newPassword || newPassword.length < 6) return { ok: false, msg: 'New password must be at least 6 characters.' };
      await DB.saveAccount({ ...user, password: newPassword });
      return { ok: true };
    },
  });
}
