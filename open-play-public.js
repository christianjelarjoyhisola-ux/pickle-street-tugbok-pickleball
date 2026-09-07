(function initOpenPlayPublic(global) {
  'use strict';

  if (!global || global.OpenPlayPublic) return;

  const doc = global.document;
  const SECTION_ID = 'openPlayPublic';
  const OVERLAY_ID = 'openPlayPublicOverlay';
  const STYLE_ID = 'openPlayPublicStyles';
  const TURNSTILE_ACTION = 'open_play_reserve';
  const MANILA_TIME_ZONE = 'Asia/Manila';
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const state = {
    mounted: false,
    mountPending: false,
    section: null,
    sessionsRoot: null,
    recoveryRoot: null,
    sectionLive: null,
    overlay: null,
    dialog: null,
    dialogTitle: null,
    dialogDescription: null,
    dialogBody: null,
    dialogLive: null,
    closeButton: null,
    sessions: [],
    currentSession: null,
    registration: null,
    paymentMethods: [],
    selectedPaymentMethod: '',
    receiptFile: null,
    receiptPreviewUrl: '',
    recovery: null,
    joinQuantity: 1,
    joinLimit: 1,
    joinRequestId: '',
    turnstileWidgetId: null,
    turnstileToken: '',
    turnstileGeneration: 0,
    refreshSequence: 0,
    statusSequence: 0,
    refreshPromise: null,
    cutoffTimer: null,
    holdTimer: null,
    serverClockOffsetMs: 0,
    serverClockAnchorMs: 0,
    serverClockAnchorMonotonicMs: 0,
    serverClockReady: false,
    isOpen: false,
    busy: false,
    lastFocus: null,
    backgroundState: [],
    bodyStyle: null,
    scrollY: 0,
    injectedStylesheet: false,
  };

  const scriptUrl = doc && doc.currentScript && doc.currentScript.src
    ? doc.currentScript.src
    : '';

  function featureRequested() {
    return global.PB_TENANT_CONFIG?.openPlayEnabled === true;
  }

  function featureEnabled() {
    return featureRequested() && global.PB_OPEN_PLAY_SERVER_ENABLED === true;
  }

  function canMountFeature() {
    return featureEnabled() || readRecoveries().length > 0;
  }

  function asText(value, maxLength) {
    const max = Number.isFinite(maxLength) ? maxLength : 500;
    return String(value == null ? '' : value).trim().slice(0, max);
  }

  function asNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : (fallback == null ? 0 : fallback);
  }

  function asInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) ? number : (fallback == null ? 0 : fallback);
  }

  function monotonicNow() {
    const value = global.performance?.now?.();
    return Number.isFinite(value) ? value : Date.now();
  }

  function clockSampleStarted() {
    return { wallMs: Date.now(), monotonicMs: monotonicNow() };
  }

  function updateServerClock(serverTime, started) {
    const raw = asText(serverTime, 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return false;
    const serverMs = Date.parse(raw);
    const receivedMonotonicMs = monotonicNow();
    const roundTripMs = receivedMonotonicMs - Number(started?.monotonicMs);
    if (!Number.isFinite(serverMs) || !Number.isFinite(roundTripMs) ||
        roundTripMs < 0 || roundTripMs > 15000) return false;
    // Treat the full bounded round trip as elapsed after the server timestamp.
    // This intentionally closes cutoff/payment UI early rather than ever late.
    const conservativeServerNow = serverMs + roundTripMs;
    state.serverClockOffsetMs = conservativeServerNow - Date.now();
    state.serverClockAnchorMs = conservativeServerNow;
    state.serverClockAnchorMonotonicMs = receivedMonotonicMs;
    state.serverClockReady = true;
    return true;
  }

  function updateServerClockFromResult(result, started) {
    return updateServerClock(result && result.serverTime, started);
  }

  function serverNow() {
    if (!state.serverClockReady) return Date.now();
    const elapsed = monotonicNow() - state.serverClockAnchorMonotonicMs;
    return Number.isFinite(elapsed) && elapsed >= 0
      ? state.serverClockAnchorMs + elapsed
      : Date.now() + state.serverClockOffsetMs;
  }

  function element(tagName, className, textContent) {
    const node = doc.createElement(tagName);
    if (className) node.className = className;
    if (textContent != null) node.textContent = String(textContent);
    return node;
  }

  function clear(node) {
    if (node) node.replaceChildren();
  }

  function methodAvailable(name) {
    return Boolean(global.DB && typeof global.DB[name] === 'function');
  }

  function friendlyError(error, fallback) {
    const raw = asText(error && (error.message || error.error || error), 220)
      .replace(/\s+/g, ' ');
    if (!raw) return fallback;
    if (/failed to fetch|networkerror|network request/i.test(raw)) {
      return 'The connection was interrupted. Check your internet connection and try again.';
    }
    return raw;
  }

  function createRequestId() {
    const cryptoApi = global.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      cryptoApi.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }

  function tenantSlug() {
    return asText(
      global.PB_TENANT_SLUG ||
      (global.PB_TENANT_CONFIG && global.PB_TENANT_CONFIG.tenantSlug) ||
      'tenant',
      80
    ).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  }

  function recoveryStorageKey() {
    return `pb:${tenantSlug()}:open-play-registration:v2`;
  }

  function readRecoveries() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(recoveryStorageKey());
      const parsed = raw ? JSON.parse(raw) : null;
      const source = parsed && parsed.entries && typeof parsed.entries === 'object'
        ? parsed.entries
        : parsed && parsed.reference
          ? { [asText(parsed.reference, 80).toUpperCase()]: parsed }
          : {};
      const entries = Object.entries(source).map(([key, entry]) => {
        const reference = asText(entry && entry.reference || key, 80).toUpperCase();
        const accessToken = asText(entry && entry.accessToken, 500);
        return reference && accessToken ? { reference, accessToken } : null;
      }).filter(Boolean);
      if (parsed?.reference && !parsed?.entries && entries.length) writeRecoveries(entries);
      if (state.recovery && !entries.some(entry => entry.reference === state.recovery.reference)) {
        entries.unshift(state.recovery);
      }
      return entries;
    } catch (_) {
      return state.recovery ? [state.recovery] : [];
    }
  }

  function readRecovery(reference) {
    const target = asText(reference, 80).toUpperCase();
    const entries = readRecoveries();
    return target ? entries.find(entry => entry.reference === target) || null : entries[0] || null;
  }

  function writeRecoveries(entries) {
    const keyed = {};
    entries.forEach(entry => {
      const reference = asText(entry && entry.reference, 80).toUpperCase();
      const accessToken = asText(entry && entry.accessToken, 500);
      if (reference && accessToken) keyed[reference] = { reference, accessToken };
    });
    try {
      if (Object.keys(keyed).length) {
        global.localStorage.setItem(recoveryStorageKey(), JSON.stringify({ entries: keyed }));
      } else {
        global.localStorage.removeItem(recoveryStorageKey());
      }
    } catch (_) {
      // Storage may be unavailable; callers still retain their in-memory handle.
    }
  }

  function saveRecovery(reference, accessToken) {
    const safe = {
      reference: asText(reference, 80).toUpperCase(),
      accessToken: asText(accessToken, 500),
    };
    if (!safe.reference || !safe.accessToken) return null;
    const entries = readRecoveries().filter(entry => entry.reference !== safe.reference);
    entries.unshift(safe);
    writeRecoveries(entries);
    state.recovery = safe;
    return safe;
  }

  function removeRecovery(reference) {
    const target = asText(reference || state.recovery?.reference, 80).toUpperCase();
    if (!target) return;
    writeRecoveries(readRecoveries().filter(entry => entry.reference !== target));
    if (state.recovery?.reference === target) state.recovery = null;
    renderRecoveryCard();
  }

  function hasRefundLiability(registration) {
    if (!registration) return false;
    const liability = registration.refundLiability;
    const closedStates = ['resolved', 'refunded', 'none', 'not_applicable', 'not_required'];
    const liabilityExists = liability === true ||
      (typeof liability === 'number' && liability > 0) ||
      (typeof liability === 'string' && liability !== '' && !closedStates.includes(liability)) ||
      (liability && typeof liability === 'object' &&
        (Number(liability.amount) > 0 || !closedStates.includes(String(liability.status || ''))));
    const refundStatusOpen = ['required', 'review_required'].includes(registration.refundStatus);
    return registration.refundRequired === true ||
      registration.refundReviewRequired === true ||
      Boolean(liabilityExists) ||
      Boolean(refundStatusOpen);
  }

  function shouldRemoveTerminalRecovery(registration) {
    return ['cancelled', 'expired', 'completed', 'rejected'].includes(registration?.status) &&
      !hasRefundLiability(registration);
  }

  function todayInManila() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: MANILA_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const values = {};
      parts.forEach(part => { values[part.type] = part.value; });
      return `${values.year}-${values.month}-${values.day}`;
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function dateFromKey(value) {
    const key = asText(value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const date = new Date(`${key}T12:00:00+08:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value, options) {
    const date = dateFromKey(value);
    if (!date) return asText(value, 40) || 'Date to be announced';
    try {
      return new Intl.DateTimeFormat('en-PH', {
        timeZone: MANILA_TIME_ZONE,
        weekday: options && options.short ? 'short' : 'long',
        month: options && options.short ? 'short' : 'long',
        day: 'numeric',
        year: options && options.year ? 'numeric' : undefined,
      }).format(date);
    } catch (_) {
      return value;
    }
  }

  function dateHeading(value) {
    const today = todayInManila();
    const todayDate = dateFromKey(today);
    const targetDate = dateFromKey(value);
    let prefix = '';
    if (value === today) {
      prefix = 'Today';
    } else if (todayDate && targetDate) {
      const days = Math.round((targetDate.getTime() - todayDate.getTime()) / 86400000);
      if (days === 1) prefix = 'Tomorrow';
    }
    const formatted = formatDate(value, { short: false });
    return prefix ? `${prefix} · ${formatted}` : formatted;
  }

  function formatTime(value) {
    const raw = asText(value, 60);
    if (!raw) return 'TBD';
    const clock = raw.match(/(?:T|\s|^)(\d{1,2}):(\d{2})/);
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed) && /T|Z|[+-]\d{2}:?\d{2}/.test(raw)) {
      try {
        return new Intl.DateTimeFormat('en-PH', {
          timeZone: MANILA_TIME_ZONE,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date(parsed));
      } catch (_) {
        // Fall through to the clock formatter.
      }
    }
    if (clock) {
      const hour = Number(clock[1]);
      const minute = clock[2];
      if (hour >= 0 && hour <= 23) {
        return `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
      }
    }
    return raw;
  }

  function formatTimeRange(session) {
    return `${formatTime(session.startsAt)} – ${formatTime(session.endsAt)}`;
  }

  function formatDateTime(value) {
    const parsed = Date.parse(asText(value, 60));
    if (Number.isNaN(parsed)) return '';
    try {
      return new Intl.DateTimeFormat('en-PH', {
        timeZone: MANILA_TIME_ZONE,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(parsed));
    } catch (_) {
      return '';
    }
  }

  function safeCurrency(value) {
    const currency = asText(value, 3).toUpperCase();
    return /^[A-Z]{3}$/.test(currency) ? currency : 'PHP';
  }

  function formatMoney(value, currency) {
    const amount = Math.max(0, asNumber(value));
    if (amount === 0) return 'Free';
    try {
      return new Intl.NumberFormat('en-PH', {
        style: 'currency',
        currency: safeCurrency(currency),
        minimumFractionDigits: amount % 1 ? 2 : 0,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch (_) {
      return `₱${amount.toLocaleString('en-PH')}`;
    }
  }

  function normalizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = asText(raw.id, 100);
    const date = asText(raw.date, 10);
    const courtNames = Array.isArray(raw.courtNames)
      ? raw.courtNames.map(name => asText(name, 120)).filter(Boolean).slice(0, 2)
      : [];
    const capacity = Math.max(0, asInteger(raw.capacity));
    const spotsRemaining = Math.max(0, Math.min(
      capacity || Number.MAX_SAFE_INTEGER,
      asInteger(raw.spotsRemaining)
    ));
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !courtNames.length) return null;
    return {
      id,
      title: asText(raw.title, 120) || 'Open Play',
      date,
      startsAt: asText(raw.startsAt, 60),
      endsAt: asText(raw.endsAt, 60),
      courtNames,
      pricePerPerson: Math.max(0, asNumber(raw.pricePerPerson)),
      serviceFeePerPerson: Math.max(0, asNumber(
        raw.serviceFeePerPerson ??
        raw.service_fee_per_person ??
        raw.openPlayServiceFeePerPerson ??
        raw.open_play_service_fee_per_person ??
        raw.serviceFee ??
        raw.service_fee
      )),
      currency: safeCurrency(raw.currency),
      capacity,
      spotsRemaining,
      refundRequiredCount: Math.max(0, asInteger(raw.refundRequiredCount ?? raw.refundCount)),
      refundRequiredTotal: Math.max(0, asNumber(
        raw.refundRequiredTotal ?? raw.refundRequiredAmount ?? raw.refundLiabilityTotal ?? raw.refundAmount
      )),
      refundReviewRequiredCount: Math.max(0, asInteger(
        raw.refundReviewRequiredCount ?? raw.refundReviewCount
      )),
      refundReviewRequiredTotal: Math.max(0, asNumber(
        raw.refundReviewRequiredTotal ?? raw.refundReviewRequiredAmount ?? raw.refundReviewTotal
      )),
      status: asText(raw.status, 40).toLowerCase(),
      statusReason: asText(raw.statusReason, 1000),
      skillLevel: asText(raw.skillLevel, 80),
      notes: asText(raw.notes, 2000),
    };
  }

  function normalizeRegistration(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const reference = asText(raw.reference, 80).toUpperCase();
    if (!reference) return null;
    const session = normalizeSession(raw.session) || null;
    let status = asText(raw.status, 40).toLowerCase();
    const sessionEnded = session && (
      session.status === 'completed' ||
      (!Number.isNaN(Date.parse(session.endsAt)) && Date.parse(session.endsAt) <= serverNow())
    );
    if (sessionEnded && ['confirmed', 'checked_in'].includes(status)) status = 'completed';
    const rawLiability = raw.refundLiability;
    const refundLiability = rawLiability && typeof rawLiability === 'object'
      ? {
          amount: Math.max(0, asNumber(rawLiability.amount ?? rawLiability.refundAmount)),
          currency: safeCurrency(rawLiability.currency),
          status: asText(rawLiability.status, 40).toLowerCase(),
        }
      : rawLiability === true
        ? true
        : typeof rawLiability === 'string' && !Number.isFinite(Number(rawLiability))
          ? asText(rawLiability, 40).toLowerCase()
        : Number.isFinite(Number(rawLiability)) && Number(rawLiability) >= 0
          ? Number(rawLiability)
          : null;
    return {
      reference,
      accessToken: asText(raw.accessToken, 500),
      sessionId: asText(raw.sessionId, 100),
      quantity: Math.max(1, asInteger(raw.quantity, 1)),
      unitPrice: Math.max(0, asNumber(raw.unitPrice)),
      subtotal: Math.max(0, asNumber(raw.subtotal)),
      serviceFee: Math.max(0, asNumber(
        raw.serviceFee ??
        raw.service_fee ??
        raw.openPlayServiceFee ??
        raw.open_play_service_fee
      )),
      total: Math.max(0, asNumber(raw.total)),
      status,
      paymentStatus: asText(raw.paymentStatus, 40).toLowerCase(),
      paymentMethod: asText(raw.paymentMethod, 40).toLowerCase(),
      paymentReference: asText(raw.paymentReference, 120),
      statusReason: asText(raw.statusReason, 1000),
      refundRequired: raw.refundRequired === true,
      refundReviewRequired: raw.refundReviewRequired === true,
      refundLiability,
      refundStatus: asText(raw.refundStatus, 40).toLowerCase(),
      remittancePrepared: raw.remittancePrepared === true,
      expiresAt: asText(raw.expiresAt, 60),
      session,
    };
  }

  function normalizePaymentMethods(raw) {
    const source = Array.isArray(raw) ? raw : [];
    return source.map(method => {
      if (!method || typeof method !== 'object') return null;
      const code = asText(method.code, 40).toLowerCase();
      if (!code || code === 'cash') return null;
      return {
        code,
        displayName: asText(method.displayName, 80) || code.toUpperCase(),
        accountName: asText(method.accountName, 120),
        accountReference: asText(method.accountReference, 120),
        qrImageUrl: safeImageUrl(method.qrImageUrl),
        instructions: asText(method.instructions, 1000),
      };
    }).filter(method => method && method.accountName && method.accountReference);
  }

  function applyStatusResult(result) {
    const source = result && typeof result === 'object' ? result : {};
    if (Object.prototype.hasOwnProperty.call(source, 'paymentMethods')) {
      const restored = normalizePaymentMethods(source.paymentMethods);
      state.paymentMethods = restored;
      if (!restored.some(method => method.code === state.selectedPaymentMethod)) {
        state.selectedPaymentMethod = restored[0]?.code || '';
      }
    }
    return normalizeRegistration(source.registration || result);
  }

  function safeImageUrl(value) {
    const raw = asText(value, 1200);
    if (!raw) return '';
    try {
      const url = new URL(raw, global.location && global.location.href);
      if (url.username || url.password) return '';
      if (url.protocol === 'https:') return url.href;
      if (url.protocol === 'http:' && global.location && url.origin === global.location.origin) {
        return url.href;
      }
    } catch (_) {
      return '';
    }
    return '';
  }

  function isPastSession(session) {
    const end = Date.parse(session.endsAt);
    return !Number.isNaN(end) && end <= serverNow();
  }

  function joinCutoffAt(session) {
    const start = Date.parse(session?.startsAt);
    return Number.isNaN(start) ? NaN : start - 15 * 60 * 1000;
  }

  function joinCutoffPassed(session) {
    const cutoff = joinCutoffAt(session);
    return Number.isNaN(cutoff) || serverNow() >= cutoff;
  }

  function sessionStatus(session) {
    if (session.status === 'cancelled') return { label: 'Cancelled', tone: 'danger' };
    if (session.status === 'completed' || isPastSession(session)) {
      return { label: 'Ended', tone: 'neutral' };
    }
    if (session.spotsRemaining < 1) return { label: 'Full', tone: 'warning' };
    if (joinCutoffPassed(session)) return { label: 'Join closed', tone: 'neutral' };
    if (session.status === 'published') return { label: 'Open', tone: 'success' };
    return { label: 'Unavailable', tone: 'neutral' };
  }

  function canJoin(session) {
    return session.status === 'published' &&
      session.spotsRemaining > 0 &&
      !isPastSession(session) &&
      !joinCutoffPassed(session);
  }

  function scheduleCutoffRefresh() {
    global.clearTimeout(state.cutoffTimer);
    state.cutoffTimer = null;
    const next = state.sessions
      .filter(canJoin)
      .map(joinCutoffAt)
      .filter(value => Number.isFinite(value) && value > serverNow())
      .sort((left, right) => left - right)[0];
    if (!next) return;
    state.cutoffTimer = global.setTimeout(() => {
      if (!state.mounted) return;
      renderSessions();
      void refresh();
    }, Math.min(2147483647, Math.max(250, next - serverNow() + 100)));
  }

  function registrationStatusMeta(registration) {
    const map = {
      pending_payment: ['Spot held', 'Complete payment before the hold expires.', 'warning'],
      payment_review: ['Receipt received', 'The venue is reviewing your payment.', 'info'],
      confirmed: ['You’re in', 'Your Open Play spots are confirmed.', 'success'],
      checked_in: ['Checked in', 'You are checked in for this session.', 'success'],
      completed: ['Session complete', 'Thanks for playing.', 'neutral'],
      cancelled: ['Registration cancelled', 'Your spots have been released.', 'danger'],
      expired: ['Hold expired', 'The unpaid spots have been released.', 'danger'],
      rejected: ['Payment needs attention', 'The submitted payment could not be approved.', 'danger'],
    };
    const item = map[registration.status] || ['Registration status', 'Check the latest update below.', 'neutral'];
    return { title: item[0], description: item[1], tone: item[2] };
  }

  function paymentStatusLabel(status) {
    const labels = {
      unpaid: 'Unpaid',
      pending: 'Pending',
      for_verification: 'For verification',
      paid: 'Paid',
      rejected: 'Rejected',
      refunded: 'Refunded',
    };
    return labels[status] || (status ? status.replace(/_/g, ' ') : 'Pending');
  }

  function ensureStylesheet() {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const existing = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'))
      .find(link => /(?:^|\/)open-play\.css(?:[?#]|$)/.test(link.getAttribute('href') || ''));
    if (existing) return;
    const link = doc.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    try {
      link.href = scriptUrl ? new URL('open-play.css', scriptUrl).href : 'open-play.css';
    } catch (_) {
      link.href = 'open-play.css';
    }
    doc.head.appendChild(link);
    state.injectedStylesheet = true;
  }

  function buildSection() {
    const section = element('section', 'opp-section');
    section.id = SECTION_ID;
    section.setAttribute('aria-labelledby', 'openPlayPublicTitle');
    section.innerHTML = [
      '<div class="opp-section__glow" aria-hidden="true"></div>',
      '<div class="opp-section__header">',
      '  <div class="opp-section__heading">',
      '    <p class="opp-eyebrow">DROP IN · TEAM UP · PLAY</p>',
      '    <h2 id="openPlayPublicTitle">OPEN PLAY</h2>',
      '    <p>Reserve your spot in a shared session and meet players ready for a good game.</p>',
      '  </div>',
      '  <button class="opp-button opp-button--quiet opp-refresh" type="button">Refresh sessions</button>',
      '</div>',
      '<div class="opp-recovery" hidden></div>',
      '<div class="opp-live opp-visually-hidden" aria-live="polite" aria-atomic="true"></div>',
      '<div class="opp-sessions" aria-live="polite"></div>',
    ].join('');
    const refreshButton = section.querySelector('.opp-refresh');
    refreshButton.disabled = !featureEnabled();
    if (!featureEnabled()) {
      refreshButton.textContent = 'New sessions paused';
    }
    refreshButton.addEventListener('click', () => { refresh(); });
    state.section = section;
    state.sessionsRoot = section.querySelector('.opp-sessions');
    state.recoveryRoot = section.querySelector('.opp-recovery');
    state.sectionLive = section.querySelector('.opp-live');
    return section;
  }

  function buildOverlay() {
    const overlay = element('div', 'opp-overlay');
    overlay.id = OVERLAY_ID;
    overlay.hidden = true;
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = [
      '<section class="opp-dialog" role="dialog" aria-modal="true"',
      ' aria-labelledby="openPlayDialogTitle" aria-describedby="openPlayDialogDescription" tabindex="-1">',
      '  <header class="opp-dialog__header">',
      '    <div>',
      '      <p class="opp-dialog__eyebrow">OPEN PLAY</p>',
      '      <h2 id="openPlayDialogTitle">Reserve your spot</h2>',
      '      <p id="openPlayDialogDescription">Review the session and enter your details.</p>',
      '    </div>',
      '    <button class="opp-dialog__close" type="button" aria-label="Close Open Play dialog">&times;</button>',
      '  </header>',
      '  <div class="opp-dialog__live opp-visually-hidden" aria-live="assertive" aria-atomic="true"></div>',
      '  <div class="opp-dialog__body"></div>',
      '</section>',
    ].join('');
    state.overlay = overlay;
    state.dialog = overlay.querySelector('.opp-dialog');
    state.dialogTitle = overlay.querySelector('#openPlayDialogTitle');
    state.dialogDescription = overlay.querySelector('#openPlayDialogDescription');
    state.dialogBody = overlay.querySelector('.opp-dialog__body');
    state.dialogLive = overlay.querySelector('.opp-dialog__live');
    state.closeButton = overlay.querySelector('.opp-dialog__close');
    state.closeButton.addEventListener('click', () => closeDialog());
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeDialog();
    });
    overlay.addEventListener('keydown', handleDialogKeydown);
    return overlay;
  }

  function mount() {
    if (!doc || !canMountFeature()) {
      if (state.mounted) unmount();
      return false;
    }
    if (state.mounted) return true;
    if (doc.readyState === 'loading') {
      if (!state.mountPending) {
        state.mountPending = true;
        doc.addEventListener('DOMContentLoaded', () => {
          state.mountPending = false;
          mount();
        }, { once: true });
      }
      return false;
    }
    const courts = doc.querySelector('#courts');
    if (!courts || !courts.parentNode || !doc.body) return false;

    ensureStylesheet();
    const section = buildSection();
    courts.parentNode.insertBefore(section, courts);
    doc.body.appendChild(buildOverlay());
    state.mounted = true;
    state.recovery = readRecovery();
    renderRecoveryCard({ loading: Boolean(state.recovery) });
    state.refreshPromise = loadSessions();
    if (state.recovery) hydrateRecovery();
    return true;
  }

  function unmount() {
    if (!state.mounted) return;
    closeDialog(true);
    state.refreshSequence += 1;
    state.statusSequence += 1;
    global.clearTimeout(state.cutoffTimer);
    global.clearInterval(state.holdTimer);
    state.cutoffTimer = null;
    state.holdTimer = null;
    if (state.section) state.section.remove();
    if (state.overlay) state.overlay.remove();
    if (state.injectedStylesheet) {
      const stylesheet = doc.getElementById(STYLE_ID);
      if (stylesheet) stylesheet.remove();
    }
    state.mounted = false;
    state.section = null;
    state.sessionsRoot = null;
    state.recoveryRoot = null;
    state.sectionLive = null;
    state.overlay = null;
    state.dialog = null;
    state.dialogBody = null;
    state.dialogLive = null;
    state.sessions = [];
    state.injectedStylesheet = false;
  }

  function refresh() {
    if (!canMountFeature()) {
      if (state.mounted) unmount();
      return Promise.resolve([]);
    }
    if (!state.mounted) {
      if (!mount()) return Promise.resolve([]);
      return state.refreshPromise || Promise.resolve([]);
    }
    state.refreshPromise = loadSessions();
    return state.refreshPromise;
  }

  async function loadSessions() {
    const sequence = ++state.refreshSequence;
    if (!state.sessionsRoot) return [];
    renderSessionsLoading();
    try {
      if (!methodAvailable('getPublicOpenPlaySessions')) {
        throw new Error('Open Play sessions are temporarily unavailable.');
      }
      const clockStarted = clockSampleStarted();
      const result = await global.DB.getPublicOpenPlaySessions();
      updateServerClockFromResult(result, clockStarted);
      if (sequence !== state.refreshSequence || !state.mounted) return [];
      if (!canMountFeature()) {
        unmount();
        return [];
      }
      const source = Array.isArray(result)
        ? result
        : Array.isArray(result?.sessions)
          ? result.sessions
          : [];
      state.sessions = source.map(normalizeSession).filter(Boolean).sort((left, right) => {
        const dateOrder = left.date.localeCompare(right.date);
        return dateOrder || left.startsAt.localeCompare(right.startsAt);
      });
      renderSessions();
      announceSection(
        state.sessions.length
          ? `${state.sessions.length} Open Play session${state.sessions.length === 1 ? '' : 's'} loaded.`
          : 'No Open Play sessions are currently available.'
      );
      return state.sessions.slice();
    } catch (error) {
      if (sequence !== state.refreshSequence || !state.mounted) return [];
      renderSessionsError(friendlyError(error, 'Open Play sessions could not be loaded.'));
      return [];
    }
  }

  function renderSessionsLoading() {
    clear(state.sessionsRoot);
    state.sessionsRoot.setAttribute('aria-busy', 'true');
    const loading = element('div', 'opp-state opp-state--loading');
    loading.setAttribute('role', 'status');
    loading.innerHTML = '<span class="opp-spinner" aria-hidden="true"></span><span>Loading Open Play sessions…</span>';
    state.sessionsRoot.appendChild(loading);
  }

  function renderSessionsError(message) {
    clear(state.sessionsRoot);
    state.sessionsRoot.setAttribute('aria-busy', 'false');
    const panel = element('div', 'opp-state opp-state--error');
    const title = element('strong', '', 'Sessions are unavailable');
    const copy = element('p', '', message);
    const retry = element('button', 'opp-button opp-button--secondary', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => refresh());
    panel.append(title, copy, retry);
    state.sessionsRoot.appendChild(panel);
    announceSection(message);
  }

  function renderSessions() {
    clear(state.sessionsRoot);
    state.sessionsRoot.setAttribute('aria-busy', 'false');
    if (!state.sessions.length) {
      const empty = element('div', 'opp-state opp-state--empty');
      empty.append(
        element('strong', '', 'No sessions posted yet'),
        element('p', '', 'Check back soon—the next Open Play schedule will appear here.')
      );
      state.sessionsRoot.appendChild(empty);
      scheduleCutoffRefresh();
      return;
    }

    const groups = new Map();
    state.sessions.forEach(session => {
      if (!groups.has(session.date)) groups.set(session.date, []);
      groups.get(session.date).push(session);
    });
    groups.forEach((sessions, date) => {
      const group = element('section', 'opp-date-group');
      const headingId = `opp-date-${date.replace(/[^0-9]/g, '')}`;
      group.setAttribute('aria-labelledby', headingId);
      const header = element('div', 'opp-date-group__header');
      const heading = element('h3', '', dateHeading(date));
      heading.id = headingId;
      const count = element(
        'span',
        'opp-date-group__count',
        `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
      );
      header.append(heading, count);
      const grid = element('div', 'opp-card-grid');
      sessions.forEach(session => grid.appendChild(renderSessionCard(session)));
      group.append(header, grid);
      state.sessionsRoot.appendChild(group);
    });
    scheduleCutoffRefresh();
  }

  function renderSessionCard(session) {
    const card = element('article', 'opp-card');
    const headingId = `opp-session-${session.id.replace(/[^a-z0-9_-]/gi, '')}`;
    card.setAttribute('aria-labelledby', headingId);
    const status = sessionStatus(session);

    const top = element('div', 'opp-card__top');
    const badge = element('span', `opp-badge opp-badge--${status.tone}`, status.label);
    top.appendChild(badge);
    if (session.skillLevel) {
      top.appendChild(element('span', 'opp-skill', session.skillLevel));
    }

    const title = element('h4', 'opp-card__title', session.title);
    title.id = headingId;
    const schedule = element('p', 'opp-card__schedule', formatTimeRange(session));
    const courts = element('p', 'opp-card__courts');
    courts.append(
      element('span', 'opp-card__label', session.courtNames.length === 2 ? 'SHARED COURTS' : 'COURT'),
      element('strong', '', session.courtNames.join(' + '))
    );
    card.append(top, title, schedule, courts);

    if (session.notes) {
      card.appendChild(element('p', 'opp-card__notes', session.notes));
    }
    if (session.statusReason && session.status === 'cancelled') {
      const reason = element('div', 'opp-inline-alert opp-inline-alert--danger');
      reason.append(element('strong', '', 'Venue cancellation note'), element('p', '', session.statusReason));
      card.appendChild(reason);
    }

    const footer = element('div', 'opp-card__footer');
    const facts = element('dl', 'opp-card__facts');
    const serviceFee = Math.max(0, Number(session.serviceFeePerPerson || 0));
    const price = element('div', '');
    price.append(
      element('dt', '', 'Per player'),
      element('dd', '', formatMoney(session.pricePerPerson, session.currency))
    );
    const fee = element('div', '');
    fee.append(
      element('dt', '', 'Service fee'),
      element('dd', '', serviceFee > 0 ? formatMoney(serviceFee, session.currency) : 'None')
    );
    const spots = element('div', '');
    const spotCopy = session.capacity
      ? `${session.spotsRemaining} of ${session.capacity} left`
      : `${session.spotsRemaining} left`;
    spots.append(element('dt', '', 'Spots'), element('dd', '', spotCopy));
    facts.append(price, fee, spots);

    const action = element(
      'button',
      'opp-button opp-button--primary',
      canJoin(session) ? 'Join session' : status.label
    );
    action.type = 'button';
    action.disabled = !canJoin(session);
    action.setAttribute(
      'aria-label',
      canJoin(session)
        ? `Join ${session.title} on ${formatDate(session.date, { short: false })}`
        : `${session.title}: ${status.label}`
    );
    if (canJoin(session)) action.addEventListener('click', () => openJoin(session));
    footer.append(facts, action);
    card.appendChild(footer);
    return card;
  }

  function announceSection(message) {
    if (!state.sectionLive) return;
    state.sectionLive.textContent = '';
    global.setTimeout(() => {
      if (state.sectionLive) state.sectionLive.textContent = asText(message, 300);
    }, 10);
  }

  function announceDialog(message) {
    if (!state.dialogLive) return;
    state.dialogLive.textContent = '';
    global.setTimeout(() => {
      if (state.dialogLive) state.dialogLive.textContent = asText(message, 300);
    }, 10);
  }

  function renderRecoveryCard(options) {
    if (!state.recoveryRoot) return;
    const entries = readRecoveries();
    clear(state.recoveryRoot);
    state.recoveryRoot.hidden = entries.length === 0;
    if (!entries.length) return;

    entries.forEach(saved => {
      const item = element('div', 'opp-recovery__item');
      const copy = element('div', 'opp-recovery__copy');
      copy.append(
      element('span', 'opp-recovery__mark', 'SAVED'),
      element('strong', '', options && options.loading ? 'Checking your saved registration…' : 'Continue your registration'),
      element('p', '', `Reference ${saved.reference}`)
    );
      const action = element('button', 'opp-button opp-button--secondary', 'View status');
      action.type = 'button';
      action.addEventListener('click', () => openRecovery(saved.reference));
      item.append(copy, action);
      state.recoveryRoot.appendChild(item);
    });
  }

  async function hydrateRecovery() {
    const entries = readRecoveries();
    if (!entries.length || !methodAvailable('getPublicOpenPlayRegistrationStatus')) {
      renderRecoveryCard();
      return;
    }
    const sequence = ++state.statusSequence;
    for (const saved of entries) {
      try {
        const clockStarted = clockSampleStarted();
        const result = await global.DB.getPublicOpenPlayRegistrationStatus(saved);
        updateServerClockFromResult(result, clockStarted);
        if (sequence !== state.statusSequence || !state.mounted) return;
        const registration = applyStatusResult(result);
        if (registration && shouldRemoveTerminalRecovery(registration)) {
          removeRecovery(saved.reference);
        }
      } catch (_) {
        // Keep each recovery handle; a temporary status failure must not strand it.
      }
    }
    renderRecoveryCard();
  }

  function lockBackground() {
    state.backgroundState = Array.from(doc.body.children)
      .filter(node => node !== state.overlay && node.nodeType === 1)
      .map(node => ({ node, inert: node.inert === true }));
    state.backgroundState.forEach(item => { item.node.inert = true; });

    const body = doc.body;
    state.scrollY = global.scrollY || doc.documentElement.scrollTop || 0;
    state.bodyStyle = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      paddingRight: body.style.paddingRight,
    };
    const scrollbar = Math.max(0, global.innerWidth - doc.documentElement.clientWidth);
    const currentPadding = parseFloat(global.getComputedStyle(body).paddingRight) || 0;
    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${state.scrollY}px`;
    body.style.width = '100%';
    if (scrollbar) body.style.paddingRight = `${currentPadding + scrollbar}px`;
    body.classList.add('opp-modal-open');
  }

  function unlockBackground() {
    state.backgroundState.forEach(item => {
      if (item.node && item.node.isConnected) item.node.inert = item.inert;
    });
    state.backgroundState = [];
    if (!state.bodyStyle) return;
    const body = doc.body;
    body.style.overflow = state.bodyStyle.overflow;
    body.style.position = state.bodyStyle.position;
    body.style.top = state.bodyStyle.top;
    body.style.width = state.bodyStyle.width;
    body.style.paddingRight = state.bodyStyle.paddingRight;
    body.classList.remove('opp-modal-open');
    const scrollY = state.scrollY;
    state.bodyStyle = null;
    try {
      if (typeof global.scrollTo === 'function') global.scrollTo(0, scrollY);
    } catch (_) {
      // Some embedded browsers do not expose programmatic scrolling.
    }
  }

  function showDialog(title, description) {
    if (!state.overlay || state.isOpen) return;
    state.lastFocus = global.HTMLElement && doc.activeElement instanceof global.HTMLElement
      ? doc.activeElement
      : null;
    state.dialogTitle.textContent = title;
    state.dialogDescription.textContent = description;
    state.overlay.hidden = false;
    state.overlay.inert = false;
    state.overlay.setAttribute('aria-hidden', 'false');
    state.isOpen = true;
    lockBackground();
    global.requestAnimationFrame(() => {
      if (state.closeButton) state.closeButton.focus({ preventScroll: true });
    });
  }

  function closeDialog(force) {
    if (!state.isOpen) return;
    if (state.busy && !force) {
      announceDialog('Please wait for the current request to finish.');
      return;
    }
    disposeTurnstile();
    global.clearInterval(state.holdTimer);
    state.holdTimer = null;
    clearReceiptPreview();
    state.overlay.setAttribute('aria-hidden', 'true');
    state.overlay.inert = true;
    state.overlay.hidden = true;
    state.isOpen = false;
    state.busy = false;
    state.currentSession = null;
    state.joinRequestId = '';
    clear(state.dialogBody);
    unlockBackground();
    const focusTarget = state.lastFocus;
    state.lastFocus = null;
    if (focusTarget && focusTarget.isConnected && !focusTarget.closest('[inert]')) {
      global.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    }
  }

  function handleDialogKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(state.dialog.querySelectorAll(FOCUSABLE))
      .filter(node => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) {
      event.preventDefault();
      state.dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function setModalBusy(value) {
    state.busy = Boolean(value);
    if (state.overlay) {
      state.overlay.classList.toggle('is-busy', state.busy);
      state.overlay.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    }
  }

  function focusStepHeading() {
    global.requestAnimationFrame(() => {
      const heading = state.dialogBody && state.dialogBody.querySelector('[data-opp-step-heading]');
      if (heading) heading.focus({ preventScroll: true });
    });
  }

  function sessionSummary(session) {
    const summary = element('div', 'opp-session-summary');
    const date = element('div', 'opp-session-summary__date');
    date.append(
      element('span', '', formatDate(session.date, { short: true })),
      element('strong', '', formatTimeRange(session))
    );
    const copy = element('div', 'opp-session-summary__copy');
    copy.append(
      element('strong', '', session.title),
      element('span', '', session.courtNames.join(' + '))
    );
    summary.append(date, copy);
    return summary;
  }

  function appendSessionInstructions(root, session) {
    if (!root || !session) return;
    if (session.notes) {
      const instructions = element('div', 'opp-session-instructions');
      instructions.append(
        element('strong', '', 'Venue notes and instructions'),
        element('p', '', session.notes)
      );
      root.appendChild(instructions);
    }
    if (session.statusReason) {
      const reason = element('div', 'opp-inline-alert opp-inline-alert--danger');
      reason.append(element('strong', '', 'Venue status note'), element('p', '', session.statusReason));
      root.appendChild(reason);
    }
  }

  function openJoin(session) {
    if (!featureEnabled() || state.isOpen) return;
    if (!canJoin(session)) {
      announceSection('Joining closes 15 minutes before the session starts.');
      void refresh();
      return;
    }
    state.currentSession = session;
    state.registration = null;
    state.paymentMethods = [];
    state.selectedPaymentMethod = '';
    state.joinLimit = Math.max(1, Math.min(4, session.spotsRemaining));
    state.joinQuantity = 1;
    state.joinRequestId = createRequestId();
    showDialog('Reserve your spot', `${formatDate(session.date)} · ${formatTimeRange(session)}`);
    renderJoinStep();
  }

  function renderJoinStep() {
    const session = state.currentSession;
    if (!session || !state.dialogBody) return;
    disposeTurnstile();
    clear(state.dialogBody);
    state.dialogBody.appendChild(sessionSummary(session));
    appendSessionInstructions(state.dialogBody, session);

    const form = element('form', 'opp-form');
    form.noValidate = false;
    form.innerHTML = [
      '<div class="opp-step-heading">',
      '  <p class="opp-step-count">STEP 1 OF 2</p>',
      '  <h3 data-opp-step-heading tabindex="-1">Who’s joining?</h3>',
      '</div>',
      '<fieldset class="opp-quantity-fieldset">',
      '  <legend>Number of players</legend>',
      '  <div class="opp-quantity">',
      '    <button type="button" class="opp-quantity__button opp-quantity__minus" aria-label="Remove one player">−</button>',
      '    <output class="opp-quantity__value" aria-live="polite">1</output>',
      '    <button type="button" class="opp-quantity__button opp-quantity__plus" aria-label="Add one player">+</button>',
      '  </div>',
      '  <p class="opp-field-hint opp-quantity__hint"></p>',
      '</fieldset>',
      '<div class="opp-field">',
      '  <label for="oppCustomerName">Full name</label>',
      '  <input id="oppCustomerName" name="name" type="text" autocomplete="name" minlength="2" maxlength="120" required>',
      '</div>',
      '<div class="opp-field-grid">',
      '  <div class="opp-field">',
      '    <label for="oppCustomerPhone">PH mobile number</label>',
      '    <input id="oppCustomerPhone" name="phone" type="tel" autocomplete="tel" inputmode="tel"',
      '      placeholder="09XX XXX XXXX" maxlength="16" required aria-describedby="oppPhoneHint">',
      '    <p class="opp-field-hint" id="oppPhoneHint">Use 09XXXXXXXXX or +639XXXXXXXXX.</p>',
      '  </div>',
      '  <div class="opp-field">',
      '    <label for="oppCustomerEmail">Email</label>',
      '    <input id="oppCustomerEmail" name="email" type="email" autocomplete="email" maxlength="254" required>',
      '  </div>',
      '</div>',
      '<div class="opp-turnstile-panel">',
      '  <div class="opp-turnstile" aria-label="Security check"></div>',
      '  <p class="opp-field-hint opp-turnstile-status" role="status">Loading the secure check…</p>',
      '</div>',
      '<dl class="opp-order-summary" aria-label="Estimated Open Play total">',
      '  <div>',
      '    <dt>Open Play price</dt>',
      '    <dd class="opp-order-subtotal"></dd>',
      '  </div>',
      '  <div>',
      '    <dt>Service fee</dt>',
      '    <dd class="opp-order-service-fee"></dd>',
      '  </div>',
      '  <div class="opp-order-summary__total">',
      '    <dt>Estimated total</dt>',
      '    <dd class="opp-order-total"></dd>',
      '  </div>',
      '</dl>',
      '<button class="opp-button opp-button--primary opp-button--wide opp-join-submit" type="submit" disabled>',
      '  Hold my spot',
      '</button>',
      '<p class="opp-fine-print">The service fee is added per player. The final total is confirmed after the hold is created. Your contact details are sent securely and are never saved in browser recovery storage.</p>',
    ].join('');
    state.dialogBody.appendChild(form);

    const minus = form.querySelector('.opp-quantity__minus');
    const plus = form.querySelector('.opp-quantity__plus');
    const phone = form.elements.phone;
    minus.addEventListener('click', () => updateJoinQuantity(state.joinQuantity - 1, form));
    plus.addEventListener('click', () => updateJoinQuantity(state.joinQuantity + 1, form));
    phone.addEventListener('input', () => phone.setCustomValidity(''));
    phone.addEventListener('blur', () => validatePhoneInput(phone));
    form.addEventListener('input', () => {
      if (!state.busy) state.joinRequestId = createRequestId();
    });
    form.addEventListener('submit', event => submitJoin(event, form));
    updateJoinQuantity(1, form);
    focusStepHeading();
    setupTurnstile(form);
  }

  function updateJoinQuantity(next, form) {
    state.joinQuantity = Math.max(1, Math.min(state.joinLimit, asInteger(next, 1)));
    const output = form.querySelector('.opp-quantity__value');
    const hint = form.querySelector('.opp-quantity__hint');
    const subtotal = form.querySelector('.opp-order-subtotal');
    const serviceFee = form.querySelector('.opp-order-service-fee');
    const total = form.querySelector('.opp-order-total');
    const minus = form.querySelector('.opp-quantity__minus');
    const plus = form.querySelector('.opp-quantity__plus');
    const priceSubtotal = Math.max(0, Number(state.currentSession.pricePerPerson || 0)) * state.joinQuantity;
    const serviceFeeTotal = Math.max(0, Number(state.currentSession.serviceFeePerPerson || 0)) * state.joinQuantity;
    output.value = String(state.joinQuantity);
    output.textContent = String(state.joinQuantity);
    hint.textContent = `Reserve up to ${state.joinLimit} spot${state.joinLimit === 1 ? '' : 's'} in this order.`;
    if (subtotal) subtotal.textContent = formatMoney(priceSubtotal, state.currentSession.currency);
    if (serviceFee) serviceFee.textContent = serviceFeeTotal > 0
      ? formatMoney(serviceFeeTotal, state.currentSession.currency)
      : 'None';
    if (total) total.textContent = formatMoney(priceSubtotal + serviceFeeTotal, state.currentSession.currency);
    minus.disabled = state.joinQuantity <= 1;
    plus.disabled = state.joinQuantity >= state.joinLimit;
  }

  function normalizePhPhone(value) {
    const compact = asText(value, 40).replace(/[\s().-]/g, '');
    if (/^09\d{9}$/.test(compact)) return `+63${compact.slice(1)}`;
    if (/^\+639\d{9}$/.test(compact)) return compact;
    if (/^639\d{9}$/.test(compact)) return `+${compact}`;
    return '';
  }

  function validatePhoneInput(input) {
    const normalized = normalizePhPhone(input.value);
    input.setCustomValidity(normalized ? '' : 'Enter a valid Philippine mobile number.');
    return normalized;
  }

  async function waitForTurnstile(timeoutMs) {
    const started = Date.now();
    while (!global.turnstile) {
      if (Date.now() - started >= timeoutMs) {
        throw new Error('The security check did not load. Check your connection and try again.');
      }
      await new Promise(resolve => global.setTimeout(resolve, 100));
    }
    return global.turnstile;
  }

  function configuredTurnstileAction() {
    const config = global.PB_TENANT_CONFIG || {};
    const configured = asText(
      config.openPlayTurnstileAction ||
      (config.turnstileActions && (config.turnstileActions.openPlay || config.turnstileActions.openPlayReserve)),
      32
    );
    return /^[a-zA-Z0-9_-]{1,32}$/.test(configured) ? configured : TURNSTILE_ACTION;
  }

  async function setupTurnstile(form) {
    const generation = ++state.turnstileGeneration;
    state.turnstileToken = '';
    const host = form.querySelector('.opp-turnstile');
    const status = form.querySelector('.opp-turnstile-status');
    const submit = form.querySelector('.opp-join-submit');
    const sitekey = asText(global.PB_TENANT_CONFIG && global.PB_TENANT_CONFIG.turnstileSiteKey, 200);
    if (!sitekey) {
      status.textContent = 'The security check is not configured. Registration is unavailable.';
      return;
    }
    try {
      const turnstile = await waitForTurnstile(12000);
      if (generation !== state.turnstileGeneration || !host.isConnected) return;
      state.turnstileWidgetId = turnstile.render(host, {
        sitekey,
        action: configuredTurnstileAction(),
        size: 'flexible',
        appearance: 'always',
        execution: 'render',
        retry: 'auto',
        'retry-interval': 1500,
        'refresh-expired': 'auto',
        'refresh-timeout': 'auto',
        callback: token => {
          if (generation !== state.turnstileGeneration) return;
          state.turnstileToken = asText(token, 3000);
          status.textContent = state.turnstileToken
            ? 'Security check complete.'
            : 'Complete the security check to continue.';
          submit.disabled = !state.turnstileToken;
        },
        'expired-callback': () => {
          state.turnstileToken = '';
          status.textContent = 'The security check expired. Please complete it again.';
          submit.disabled = true;
        },
        'error-callback': () => {
          state.turnstileToken = '';
          status.textContent = 'The security check could not finish. Please retry it.';
          submit.disabled = true;
        },
        'timeout-callback': () => {
          state.turnstileToken = '';
          status.textContent = 'The security check timed out. Please try again.';
          submit.disabled = true;
        },
        'unsupported-callback': () => {
          state.turnstileToken = '';
          status.textContent = 'This browser cannot run the security check.';
          submit.disabled = true;
        },
      });
      status.textContent = 'Complete the secure check to continue.';
    } catch (error) {
      if (generation !== state.turnstileGeneration || !host.isConnected) return;
      status.textContent = friendlyError(error, 'The security check is unavailable.');
      submit.disabled = true;
    }
  }

  function resetTurnstileAfterAttempt(form) {
    state.turnstileToken = '';
    const submit = form.querySelector('.opp-join-submit');
    const status = form.querySelector('.opp-turnstile-status');
    if (submit) submit.disabled = true;
    if (status) status.textContent = 'Complete the security check again to retry.';
    if (state.turnstileWidgetId != null && global.turnstile) {
      try {
        global.turnstile.reset(state.turnstileWidgetId);
      } catch (_) {
        disposeTurnstile();
        setupTurnstile(form);
      }
    }
  }

  function disposeTurnstile() {
    state.turnstileGeneration += 1;
    state.turnstileToken = '';
    if (state.turnstileWidgetId != null && global.turnstile) {
      try {
        if (typeof global.turnstile.remove === 'function') {
          global.turnstile.remove(state.turnstileWidgetId);
        } else {
          global.turnstile.reset(state.turnstileWidgetId);
        }
      } catch (_) {
        // The widget may already have been removed with its step.
      }
    }
    state.turnstileWidgetId = null;
  }

  async function submitJoin(event, form) {
    event.preventDefault();
    if (state.busy) return;
    if (!canJoin(state.currentSession)) {
      announceDialog('Joining closes 15 minutes before the session starts. Refresh the session list for current availability.');
      void refresh();
      return;
    }
    const phone = validatePhoneInput(form.elements.phone);
    if (!form.reportValidity()) return;
    if (!state.turnstileToken) {
      announceDialog('Complete the security check before reserving.');
      return;
    }
    if (!methodAvailable('createPublicOpenPlayRegistration')) {
      announceDialog('Open Play registration is temporarily unavailable.');
      return;
    }

    const fieldset = Array.from(form.elements);
    const button = form.querySelector('.opp-join-submit');
    const token = state.turnstileToken;
    const requestId = state.joinRequestId || createRequestId();
    state.joinRequestId = requestId;
    fieldset.forEach(control => { control.disabled = true; });
    button.textContent = 'Holding your spots…';
    setModalBusy(true);
    announceDialog('Creating your Open Play registration.');

    try {
      const clockStarted = clockSampleStarted();
      const result = await global.DB.createPublicOpenPlayRegistration({
        sessionId: state.currentSession.id,
        quantity: state.joinQuantity,
        customer: {
          name: asText(form.elements.name.value, 120),
          phone,
          email: asText(form.elements.email.value, 254).toLowerCase(),
        },
        clientRequestId: requestId,
        turnstileToken: token,
      });
      updateServerClockFromResult(result, clockStarted);
      const registration = normalizeRegistration(result && result.registration);
      if (!registration || !registration.accessToken) {
        throw new Error('The registration response was incomplete. Please try again.');
      }
      state.registration = registration;
      state.paymentMethods = normalizePaymentMethods(result.paymentMethods);
      state.selectedPaymentMethod = state.paymentMethods[0] ? state.paymentMethods[0].code : '';
      saveRecovery(registration.reference, registration.accessToken);
      renderRecoveryCard();
      disposeTurnstile();
      announceDialog(`Registration ${registration.reference} created.`);
      if (registration.total > 0) {
        renderPaymentStep();
      } else {
        await loadRegistrationStatus({ render: true, loadingMessage: 'Confirming your free registration…' });
      }
    } catch (error) {
      announceDialog(friendlyError(error, 'Your registration could not be created.'));
      fieldset.forEach(control => { control.disabled = false; });
      updateJoinQuantity(state.joinQuantity, form);
      resetTurnstileAfterAttempt(form);
      button.textContent = 'Hold my spot';
    } finally {
      setModalBusy(false);
    }
  }

  function registrationCurrency(registration) {
    return safeCurrency(
      registration && registration.session && registration.session.currency ||
      state.currentSession && state.currentSession.currency ||
      'PHP'
    );
  }

  function holdExpired(registration) {
    const expiresAt = Date.parse(registration?.expiresAt || '');
    return !Number.isFinite(expiresAt) || expiresAt <= serverNow();
  }

  function holdCountdownCopy(expiresAt) {
    const remaining = Math.max(0, Date.parse(expiresAt || '') - serverNow());
    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return remaining > 0
      ? `${minutes}:${String(seconds).padStart(2, '0')} remaining`
      : 'Hold expired';
  }

  function renderExpiredPaymentAdvisory(registration) {
    clear(state.dialogBody);
    state.dialogTitle.textContent = 'Payment hold expired';
    state.dialogDescription.textContent = `Registration ${registration.reference}`;
    const heading = element('h3', '', 'Payment details are no longer available');
    heading.tabIndex = -1;
    heading.dataset.oppStepHeading = '';
    const alert = element('div', 'opp-inline-alert opp-inline-alert--danger');
    alert.setAttribute('role', 'alert');
    alert.append(
      heading,
      element('p', '', 'The hold deadline has passed. Payment account details and receipt upload are hidden while the latest server status is checked.')
    );
    const refreshButton = element('button', 'opp-button opp-button--primary', 'Refresh status');
    refreshButton.type = 'button';
    refreshButton.addEventListener('click', () => loadRegistrationStatus({ render: true }));
    state.dialogBody.append(alert, refreshButton);
    focusStepHeading();
    announceDialog('The payment hold has expired. Checking the latest registration status.');
  }

  function startHoldCountdown(registration) {
    global.clearInterval(state.holdTimer);
    const timer = state.dialogBody?.querySelector('.opp-hold-timer');
    if (!timer) return;
    const update = () => {
      if (!state.isOpen || !timer.isConnected || state.registration?.reference !== registration.reference) {
        global.clearInterval(state.holdTimer);
        state.holdTimer = null;
        return;
      }
      timer.textContent = holdCountdownCopy(registration.expiresAt);
      if (holdExpired(registration)) {
        global.clearInterval(state.holdTimer);
        state.holdTimer = null;
        renderExpiredPaymentAdvisory(registration);
        void loadRegistrationStatus({ render: true, loadingMessage: 'Hold expired. Refreshing status…' });
      }
    };
    update();
    if (!holdExpired(registration)) state.holdTimer = global.setInterval(update, 1000);
  }

  function renderPaymentStep() {
    const registration = state.registration;
    if (!registration || !state.dialogBody) return;
    if (holdExpired(registration)) {
      renderExpiredPaymentAdvisory(registration);
      void loadRegistrationStatus({ render: true, loadingMessage: 'Hold expired. Refreshing status…' });
      return;
    }
    clearReceiptPreview();
    clear(state.dialogBody);
    state.dialogTitle.textContent = 'Pay and upload receipt';
    state.dialogDescription.textContent = `Registration ${registration.reference}`;

    const heading = element('div', 'opp-step-heading');
    heading.innerHTML = [
      '<p class="opp-step-count">STEP 2 OF 2</p>',
      '<h3 data-opp-step-heading tabindex="-1">Complete your payment</h3>',
      '<p>Your spots are held while you pay and submit a clear receipt image.</p>',
    ].join('');
    state.dialogBody.appendChild(heading);
    state.dialogBody.appendChild(renderReferenceBar(registration.reference));

    const expiry = formatDateTime(registration.expiresAt);
    if (expiry) {
      const deadline = element('div', 'opp-deadline');
      deadline.setAttribute('role', 'note');
      deadline.append(
        element('strong', '', 'Hold deadline'),
        element('span', '', `${expiry} PH time`)
      );
      const timer = element('span', 'opp-hold-timer', holdCountdownCopy(registration.expiresAt));
      timer.setAttribute('role', 'timer');
      timer.setAttribute('aria-live', 'off');
      timer.setAttribute('aria-atomic', 'true');
      deadline.appendChild(timer);
      state.dialogBody.appendChild(deadline);
    }

    const totals = renderTotals(registration);
    state.dialogBody.appendChild(totals);

    if (!state.paymentMethods.length) {
      const unavailable = element('div', 'opp-inline-alert opp-inline-alert--danger');
      unavailable.append(
        element('strong', '', 'Digital payment is unavailable'),
        element('p', '', 'Keep your registration reference and contact the venue for help.')
      );
      state.dialogBody.appendChild(unavailable);
      focusStepHeading();
      return;
    }

    const label = element('h4', 'opp-subheading', 'Choose a payment method');
    const choices = element('div', 'opp-payment-choices');
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-label', 'Digital payment method');
    state.paymentMethods.forEach(method => {
      const button = element('button', 'opp-payment-choice', method.displayName);
      button.type = 'button';
      button.dataset.method = method.code;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', method.code === state.selectedPaymentMethod ? 'true' : 'false');
      button.tabIndex = method.code === state.selectedPaymentMethod ? 0 : -1;
      button.classList.toggle('is-selected', method.code === state.selectedPaymentMethod);
      button.addEventListener('click', () => selectPaymentMethod(method.code));
      button.addEventListener('keydown', handlePaymentChoiceKeydown);
      choices.appendChild(button);
    });
    state.dialogBody.append(label, choices);

    const detail = element('div', 'opp-payment-detail');
    state.dialogBody.appendChild(detail);

    const form = element('form', 'opp-form opp-receipt-form');
    form.innerHTML = [
      '<div class="opp-field">',
      '  <label for="oppPaymentReference">Payment reference number</label>',
      '  <input id="oppPaymentReference" name="paymentReference" type="text" inputmode="text"',
      '    autocomplete="off" maxlength="64" placeholder="Enter the reference from your payment" required>',
      '</div>',
      '<div class="opp-field">',
      '  <label for="oppReceiptFile">Receipt image</label>',
      '  <label class="opp-file-picker" for="oppReceiptFile">',
      '    <strong>Choose receipt image</strong>',
      '    <span>JPEG, PNG or WebP · up to 8 MB</span>',
      '  </label>',
      '  <input class="opp-file-input" id="oppReceiptFile" name="receiptFile" type="file"',
      '    accept="image/jpeg,image/png,image/webp" required>',
      '  <div class="opp-receipt-preview" hidden></div>',
      '</div>',
      '<button class="opp-button opp-button--primary opp-button--wide opp-receipt-submit" type="submit">',
      '  Submit receipt',
      '</button>',
      '<p class="opp-fine-print">Submit only the receipt for this registration. The venue will review it before confirmation.</p>',
    ].join('');
    form.elements.receiptFile.addEventListener('change', event => selectReceiptFile(event, form));
    form.addEventListener('submit', event => submitReceipt(event, form));
    state.dialogBody.appendChild(form);
    renderPaymentMethodDetail();
    startHoldCountdown(registration);
    focusStepHeading();
  }

  function handlePaymentChoiceKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const choices = Array.from(event.currentTarget.parentElement.querySelectorAll('[role="radio"]'));
    if (!choices.length) return;
    event.preventDefault();
    const current = Math.max(0, choices.indexOf(event.currentTarget));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? choices.length - 1
        : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + choices.length) % choices.length;
    selectPaymentMethod(choices[next].dataset.method);
    choices[next].focus();
  }

  function renderReferenceBar(reference) {
    const bar = element('div', 'opp-reference');
    const copy = element('div', '');
    copy.append(element('span', '', 'Registration reference'), element('strong', '', reference));
    const button = element('button', 'opp-button opp-button--quiet', 'Copy');
    button.type = 'button';
    button.addEventListener('click', () => copyText(reference, 'Registration reference copied.'));
    bar.append(copy, button);
    return bar;
  }

  function renderTotals(registration) {
    const currency = registrationCurrency(registration);
    const box = element('dl', 'opp-totals');
    const lines = [
      ['Spots', String(registration.quantity)],
      ['Price per player', formatMoney(registration.unitPrice, currency)],
      ['Subtotal', formatMoney(registration.subtotal, currency)],
    ];
    if (registration.serviceFee > 0) {
      lines.push(['Service fee', formatMoney(registration.serviceFee, currency)]);
    }
    lines.push(['Total due', formatMoney(registration.total, currency)]);
    lines.forEach((line, index) => {
      const row = element('div', index === lines.length - 1 ? 'opp-totals__total' : '');
      row.append(element('dt', '', line[0]), element('dd', '', line[1]));
      box.appendChild(row);
    });
    return box;
  }

  function selectPaymentMethod(code) {
    if (state.busy || !state.paymentMethods.some(method => method.code === code)) return;
    state.selectedPaymentMethod = code;
    state.dialogBody.querySelectorAll('.opp-payment-choice').forEach(button => {
      const selected = button.dataset.method === code;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    renderPaymentMethodDetail();
  }

  function renderPaymentMethodDetail() {
    const root = state.dialogBody && state.dialogBody.querySelector('.opp-payment-detail');
    if (!root) return;
    clear(root);
    const method = state.paymentMethods.find(item => item.code === state.selectedPaymentMethod) ||
      state.paymentMethods[0];
    if (!method) return;
    state.selectedPaymentMethod = method.code;

    const qr = element('div', 'opp-payment-detail__qr');
    if (method.qrImageUrl) {
      const image = element('img', '');
      image.src = method.qrImageUrl;
      image.alt = `${method.displayName} payment QR code`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      qr.appendChild(image);
    } else {
      qr.appendChild(element('span', '', 'QR unavailable'));
    }

    const account = element('div', 'opp-payment-detail__account');
    account.append(
      element('span', 'opp-payment-detail__label', `Send via ${method.displayName}`),
      element('strong', '', method.accountReference),
      element('p', '', method.accountName)
    );
    const copy = element('button', 'opp-button opp-button--secondary', 'Copy account');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(method.accountReference, 'Payment account copied.'));
    account.appendChild(copy);
    root.append(qr, account);
    if (method.instructions) {
      root.appendChild(element('p', 'opp-payment-detail__instructions', method.instructions));
    }
  }

  async function copyText(value, successMessage) {
    try {
      if (!global.navigator || !global.navigator.clipboard ||
          typeof global.navigator.clipboard.writeText !== 'function') {
        throw new Error('Clipboard unavailable');
      }
      await global.navigator.clipboard.writeText(value);
      announceDialog(successMessage);
    } catch (_) {
      announceDialog('Copy is unavailable. Press and hold the value to copy it.');
    }
  }

  function clearReceiptPreview() {
    if (state.receiptPreviewUrl) {
      try {
        URL.revokeObjectURL(state.receiptPreviewUrl);
      } catch (_) {
        // The preview URL may already have been released.
      }
    }
    state.receiptPreviewUrl = '';
    state.receiptFile = null;
  }

  function selectReceiptFile(event, form) {
    clearReceiptPreview();
    const file = event.target.files && event.target.files[0];
    const preview = form.querySelector('.opp-receipt-preview');
    clear(preview);
    preview.hidden = true;
    if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(String(file.type).toLowerCase())) {
      event.target.setCustomValidity('Choose a JPEG, PNG, or WebP image.');
      event.target.reportValidity();
      event.target.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      event.target.setCustomValidity('The receipt image must be 8 MB or smaller.');
      event.target.reportValidity();
      event.target.value = '';
      return;
    }
    event.target.setCustomValidity('');
    state.receiptFile = file;
    state.receiptPreviewUrl = URL.createObjectURL(file);
    const image = element('img', '');
    image.src = state.receiptPreviewUrl;
    image.alt = 'Selected receipt preview';
    const copy = element('div', '');
    copy.append(
      element('strong', '', asText(file.name, 120) || 'Receipt image'),
      element('span', '', `${Math.max(1, Math.ceil(file.size / 1024))} KB`)
    );
    preview.append(image, copy);
    preview.hidden = false;
  }

  async function submitReceipt(event, form) {
    event.preventDefault();
    if (state.busy) return;
    if (!state.receiptFile) {
      form.elements.receiptFile.setCustomValidity('Choose your receipt image.');
    }
    const paymentReference = asText(form.elements.paymentReference.value, 64);
    form.elements.paymentReference.setCustomValidity(
      /^[\x20-\x7E]{1,64}$/.test(paymentReference)
        ? ''
        : 'Use 1–64 printable characters.'
    );
    if (!form.reportValidity()) return;
    if (!methodAvailable('submitPublicOpenPlayReceipt')) {
      announceDialog('Receipt upload is temporarily unavailable.');
      return;
    }
    const credentials = state.recovery || readRecovery();
    if (!credentials) {
      announceDialog('This registration can no longer be recovered on this device.');
      return;
    }

    const controls = Array.from(form.elements);
    const button = form.querySelector('.opp-receipt-submit');
    controls.forEach(control => { control.disabled = true; });
    button.textContent = 'Uploading receipt…';
    setModalBusy(true);
    announceDialog('Uploading your payment receipt.');
    try {
      const statusClockStarted = clockSampleStarted();
      const statusResult = await global.DB.getPublicOpenPlayRegistrationStatus({
        reference: credentials.reference,
        accessToken: credentials.accessToken,
      });
      updateServerClockFromResult(statusResult, statusClockStarted);
      const current = applyStatusResult(statusResult);
      if (!current) throw new Error('The latest registration status was incomplete.');
      state.registration = current;
      if (current.status !== 'pending_payment' || holdExpired(current)) {
        renderStatusStep(current);
        announceDialog('Payment upload stopped because the registration hold is no longer active.');
        return;
      }
      const uploadClockStarted = clockSampleStarted();
      const result = await global.DB.submitPublicOpenPlayReceipt({
        reference: credentials.reference,
        accessToken: credentials.accessToken,
        paymentMethod: state.selectedPaymentMethod,
        paymentReference,
        receiptFile: state.receiptFile,
      });
      updateServerClockFromResult(result, uploadClockStarted);
      const registration = applyStatusResult(result);
      if (registration) state.registration = registration;
      clearReceiptPreview();
      await loadRegistrationStatus({
        render: true,
        loadingMessage: 'Receipt submitted. Checking your registration…',
      });
    } catch (error) {
      announceDialog(friendlyError(error, 'The receipt could not be submitted.'));
      controls.forEach(control => { control.disabled = false; });
      button.textContent = 'Submit receipt';
    } finally {
      setModalBusy(false);
    }
  }

  function openRecovery(reference) {
    if (state.isOpen) return;
    const saved = readRecovery(reference);
    if (!saved) {
      renderRecoveryCard();
      return;
    }
    state.recovery = saved;
    state.registration = null;
    state.paymentMethods = [];
    showDialog('Registration status', `Reference ${saved.reference}`);
    loadRegistrationStatus({ render: true, loadingMessage: 'Checking your saved registration…' });
  }

  async function loadRegistrationStatus(options) {
    const settings = options || {};
    const credentials = state.recovery || readRecovery();
    if (!credentials) {
      if (settings.render) renderStatusError('No saved registration was found on this device.');
      return null;
    }
    if (!methodAvailable('getPublicOpenPlayRegistrationStatus')) {
      if (settings.render) renderStatusError('Registration status is temporarily unavailable.');
      return null;
    }
    const sequence = ++state.statusSequence;
    if (settings.render) renderModalLoading(settings.loadingMessage || 'Checking registration status…');
    setModalBusy(true);
    try {
      const clockStarted = clockSampleStarted();
      const result = await global.DB.getPublicOpenPlayRegistrationStatus({
        reference: credentials.reference,
        accessToken: credentials.accessToken,
      });
      updateServerClockFromResult(result, clockStarted);
      if (sequence !== state.statusSequence) return null;
      const registration = applyStatusResult(result);
      if (!registration) throw new Error('The registration status response was incomplete.');
      state.registration = registration;
      if (shouldRemoveTerminalRecovery(registration)) {
        removeRecovery(credentials.reference);
      } else {
        state.recovery = credentials;
        renderRecoveryCard();
      }
      if (settings.render) renderStatusStep(registration);
      return registration;
    } catch (error) {
      if (sequence !== state.statusSequence) return null;
      if (settings.render) {
        renderStatusError(friendlyError(error, 'The registration status could not be loaded.'));
      }
      return null;
    } finally {
      if (sequence === state.statusSequence) setModalBusy(false);
    }
  }

  function renderModalLoading(message) {
    clear(state.dialogBody);
    const loading = element('div', 'opp-modal-state');
    loading.setAttribute('role', 'status');
    loading.innerHTML = '<span class="opp-spinner" aria-hidden="true"></span>';
    loading.appendChild(element('strong', '', message));
    state.dialogBody.appendChild(loading);
  }

  function renderStatusError(message) {
    clear(state.dialogBody);
    const panel = element('div', 'opp-modal-state opp-modal-state--error');
    const heading = element('h3', '', 'Couldn’t check the registration');
    heading.tabIndex = -1;
    heading.dataset.oppStepHeading = '';
    panel.append(heading, element('p', '', message));
    if (state.recovery || readRecovery()) {
      const retry = element('button', 'opp-button opp-button--primary', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => loadRegistrationStatus({ render: true }));
      panel.appendChild(retry);
    }
    const close = element('button', 'opp-button opp-button--secondary', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => closeDialog());
    panel.appendChild(close);
    state.dialogBody.appendChild(panel);
    focusStepHeading();
    announceDialog(message);
  }

  function renderStatusStep(registration) {
    clear(state.dialogBody);
    state.dialogTitle.textContent = 'Registration status';
    state.dialogDescription.textContent = `Reference ${registration.reference}`;
    const meta = registration.status === 'pending_payment' && holdExpired(registration)
      ? {
          title: 'Hold deadline passed',
          description: 'Payment details are hidden. Refresh status while the server confirms whether the unpaid spots were released.',
          tone: 'danger',
        }
      : registrationStatusMeta(registration);
    const hero = element('div', `opp-status-hero opp-status-hero--${meta.tone}`);
    const heading = element('h3', '', meta.title);
    heading.tabIndex = -1;
    heading.dataset.oppStepHeading = '';
    hero.append(
      element('span', 'opp-status-hero__mark', meta.tone === 'success' ? 'READY' : 'UPDATE'),
      heading,
      element('p', '', meta.description)
    );
    state.dialogBody.append(hero, renderReferenceBar(registration.reference));

    const session = registration.session || state.currentSession;
    if (session) {
      state.dialogBody.appendChild(sessionSummary(session));
      appendSessionInstructions(state.dialogBody, session);
    }

    if (registration.statusReason) {
      const reason = element('div', 'opp-inline-alert');
      reason.append(
        element('strong', '', 'Venue status note'),
        element('p', '', registration.statusReason)
      );
      state.dialogBody.appendChild(reason);
    }

    if (hasRefundLiability(registration) || registration.remittancePrepared) {
      const warning = element('div', 'opp-inline-alert opp-inline-alert--danger opp-refund-warning');
      warning.setAttribute('role', 'alert');
      let copy = 'This registration still has a payment refund or review item that the venue must resolve.';
      if (registration.refundReviewRequired) {
        copy = 'Payment evidence remains under review. The venue must resolve whether a refund is required.';
      } else if (registration.refundRequired) {
        copy = 'A refund is required and remains the venue’s responsibility until it is resolved.';
      } else if (registration.remittancePrepared) {
        copy = 'A related remittance has been prepared, but the refund liability is not shown as resolved yet.';
      }
      const liabilityAmount = typeof registration.refundLiability === 'number'
        ? registration.refundLiability
        : registration.refundLiability && typeof registration.refundLiability === 'object'
          ? registration.refundLiability.amount
          : null;
      if (Number(liabilityAmount) > 0) {
        copy += ` Recorded liability: ${formatMoney(liabilityAmount, registration.refundLiability?.currency || registrationCurrency(registration))}.`;
      }
      warning.append(element('strong', '', 'Refund or payment review still open'), element('p', '', copy));
      state.dialogBody.appendChild(warning);
    }

    const details = element('dl', 'opp-status-details');
    addDetail(details, 'Players', String(registration.quantity));
    addDetail(details, 'Payment', paymentStatusLabel(registration.paymentStatus));
    addDetail(details, 'Total', formatMoney(registration.total, registrationCurrency(registration)));
    const expiry = formatDateTime(registration.expiresAt);
    if (expiry && registration.status === 'pending_payment') {
      addDetail(details, 'Pay by', `${expiry} PH time`);
    }
    state.dialogBody.appendChild(details);

    if (registration.status === 'pending_payment' && !holdExpired(registration) && state.paymentMethods.length) {
      const reminder = element('div', 'opp-inline-alert');
      reminder.append(
        element('strong', '', 'Payment still needed'),
        element('p', '', 'Return to the payment details and upload your receipt before the hold expires.')
      );
      state.dialogBody.appendChild(reminder);
    }

    const actions = element('div', 'opp-dialog-actions');
    const credentials = state.recovery || readRecovery();
    if (credentials) {
      const refreshButton = element('button', 'opp-button opp-button--secondary', 'Refresh status');
      refreshButton.type = 'button';
      refreshButton.addEventListener('click', () => loadRegistrationStatus({ render: true }));
      actions.appendChild(refreshButton);
    }
    if (registration.status === 'pending_payment' && !holdExpired(registration) && state.paymentMethods.length && credentials) {
      const paymentButton = element('button', 'opp-button opp-button--primary', 'Payment details');
      paymentButton.type = 'button';
      paymentButton.addEventListener('click', () => renderPaymentStep());
      actions.appendChild(paymentButton);
    }
    if (credentials && methodAvailable('cancelPublicOpenPlayRegistration') &&
        ['pending_payment', 'payment_review'].includes(registration.status)) {
      const cancel = element('button', 'opp-button opp-button--danger', 'Cancel registration');
      cancel.type = 'button';
      cancel.addEventListener('click', () => renderCancelConfirmation(cancel));
      actions.appendChild(cancel);
    }
    const done = element('button', 'opp-button opp-button--quiet', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => closeDialog());
    actions.appendChild(done);
    state.dialogBody.appendChild(actions);

    if (credentials) {
      const device = element('button', 'opp-device-remove', 'Remove saved access from this device');
      device.type = 'button';
      device.addEventListener('click', () => renderForgetConfirmation(device));
      state.dialogBody.appendChild(device);
    }
    focusStepHeading();
    announceDialog(`${meta.title}. Payment ${paymentStatusLabel(registration.paymentStatus)}.`);
  }

  function addDetail(root, term, description) {
    const row = element('div', '');
    row.append(element('dt', '', term), element('dd', '', description));
    root.appendChild(row);
  }

  function renderCancelConfirmation(trigger) {
    if (state.busy || state.dialogBody.querySelector('.opp-confirm')) return;
    const panel = element('div', 'opp-confirm');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-labelledby', 'oppCancelConfirmTitle');
    const title = element('strong', '', 'Cancel this registration?');
    title.id = 'oppCancelConfirmTitle';
    panel.append(
      title,
      element(
        'p',
        '',
        state.registration?.status === 'payment_review'
          ? 'Your reserved spots will be released, but your payment evidence remains under review and may still require venue action. This cannot be undone.'
          : 'Your reserved spots will be released. This cannot be undone.'
      )
    );
    const actions = element('div', 'opp-confirm__actions');
    const keep = element('button', 'opp-button opp-button--secondary', 'Keep registration');
    keep.type = 'button';
    keep.addEventListener('click', () => {
      panel.remove();
      trigger.focus();
    });
    const confirm = element('button', 'opp-button opp-button--danger', 'Yes, cancel');
    confirm.type = 'button';
    confirm.addEventListener('click', () => cancelRegistration(confirm));
    actions.append(keep, confirm);
    panel.appendChild(actions);
    state.dialogBody.insertBefore(panel, state.dialogBody.querySelector('.opp-dialog-actions'));
    keep.focus();
  }

  async function cancelRegistration(button) {
    const credentials = state.recovery || readRecovery();
    if (!credentials || state.busy) return;
    setModalBusy(true);
    button.disabled = true;
    button.textContent = 'Cancelling…';
    announceDialog('Cancelling your registration.');
    try {
      const clockStarted = clockSampleStarted();
      const result = await global.DB.cancelPublicOpenPlayRegistration({
        reference: credentials.reference,
        accessToken: credentials.accessToken,
        clientRequestId: createRequestId(),
      });
      updateServerClockFromResult(result, clockStarted);
      const registration = normalizeRegistration(result && result.registration ? result.registration : result);
      if (!registration) throw new Error('The cancellation response was incomplete.');
      state.registration = registration;
      if (shouldRemoveTerminalRecovery(registration)) removeRecovery(credentials.reference);
      renderStatusStep(registration);
      refresh();
    } catch (error) {
      announceDialog(friendlyError(error, 'The registration could not be cancelled.'));
      button.disabled = false;
      button.textContent = 'Yes, cancel';
    } finally {
      setModalBusy(false);
    }
  }

  function renderForgetConfirmation(trigger) {
    if (state.dialogBody.querySelector('.opp-confirm--device')) return;
    const panel = element('div', 'opp-confirm opp-confirm--device');
    panel.append(
      element('strong', '', 'Remove saved access?'),
      element('p', '', 'You will need help from the venue to recover this registration on this device.')
    );
    const actions = element('div', 'opp-confirm__actions');
    const keep = element('button', 'opp-button opp-button--secondary', 'Keep saved');
    keep.type = 'button';
    keep.addEventListener('click', () => {
      panel.remove();
      trigger.focus();
    });
    const remove = element('button', 'opp-button opp-button--danger', 'Remove access');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      removeRecovery();
      panel.remove();
      trigger.remove();
      announceDialog('Saved registration access removed from this device.');
    });
    actions.append(keep, remove);
    panel.appendChild(actions);
    trigger.before(panel);
    keep.focus();
  }

  const api = Object.freeze({
    mount,
    refresh,
    unmount,
    isEnabled: featureEnabled,
    hasRecovery: () => readRecoveries().length > 0,
    scrollIntoView: () => {
      const section = state.section || doc.getElementById(SECTION_ID);
      if (!section) return false;
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const heading = section.querySelector('h2');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      return true;
    },
  });

  Object.defineProperty(global, 'OpenPlayPublic', {
    value: api,
    enumerable: true,
    configurable: false,
    writable: false,
  });
})(window);
