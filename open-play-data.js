(function configureOpenPlayData(global) {
  'use strict';

  const runtime = global.PB_TENANT_CONFIG || {};
  const tenantSlug = String(runtime.tenantSlug || '').trim().toLowerCase();
  const supabaseUrl = String(runtime.supabaseUrl || '').replace(/\/+$/, '');
  const publishableKey = String(runtime.supabasePublishableKey || '');
  const REQUEST_TIMEOUT_MS = 45000;
  const RECEIPT_TIMEOUT_MS = 90000;
  const REPORT_TIMEZONE = 'Asia/Manila';
  const REPORT_DEFAULT_PAGE_SIZE = 100;
  const REPORT_MAX_PAGE_SIZE = 500;
  const SESSION_STATUSES = new Set(['draft', 'published', 'cancelled', 'completed']);
  const REGISTRATION_STATUSES = new Set([
    'pending_payment',
    'payment_review',
    'confirmed',
    'cancelled',
    'expired',
    'rejected',
    'checked_in',
    'completed',
  ]);
  const PAYMENT_STATUSES = new Set([
    'unpaid',
    'pending',
    'for_verification',
    'paid',
    'rejected',
    'refunded',
  ]);

  global.PB_OPEN_PLAY_SERVER_ENABLED = false;

  function configured() {
    return global.PB_PLATFORM_V1 === true &&
      global.PB_SUPABASE_CONFIGURED === true &&
      Boolean(tenantSlug && supabaseUrl && publishableKey);
  }

  function requested() {
    return runtime.openPlayEnabled === true && configured();
  }

  function readinessEnabled() {
    return requested() && global.PB_PLATFORM_READINESS?.openPlayEnabled === true;
  }

  async function syncReadiness() {
    if (!requested()) {
      global.PB_OPEN_PLAY_SERVER_ENABLED = false;
      return false;
    }
    if (!global.PB_PLATFORM_READINESS && global.DB?.getSettings) {
      try {
        await global.DB.getSettings();
      } catch (_) {
        global.PB_OPEN_PLAY_SERVER_ENABLED = false;
        return false;
      }
    }
    global.PB_OPEN_PLAY_SERVER_ENABLED = readinessEnabled();
    return global.PB_OPEN_PLAY_SERVER_ENABLED;
  }

  function asText(value, max = 500) {
    return String(value ?? '').trim().slice(0, max);
  }

  function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function asInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isInteger(number) ? number : fallback;
  }

  function asBoolean(value) {
    return value === true;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
      Object.prototype.toString.call(value) === '[object Object]';
  }

  function validManilaDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= daysInMonth;
  }

  function validServerTime(value) {
    if (typeof value !== 'string') return false;
    const match = value.match(
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|([+-])(\d{2}):(\d{2}))$/
    );
    if (!match || !validManilaDate(match[1])) return false;
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    const second = Number(match[4]);
    const offsetHour = match[5] === 'Z' ? 0 : Number(match[7]);
    const offsetMinute = match[5] === 'Z' ? 0 : Number(match[8]);
    return hour <= 23 && minute <= 59 && second <= 59 &&
      offsetHour <= 14 && offsetMinute <= 59 &&
      (offsetHour !== 14 || offsetMinute === 0) && Number.isFinite(Date.parse(value));
  }

  function validReportCursor(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 500 &&
      /^[\x21-\x7E]+$/.test(value);
  }

  function reportRangeDays(from, to) {
    if (!validManilaDate(from) || !validManilaDate(to)) return null;
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    return Math.floor((end - start) / 86400000) + 1;
  }

  function reportError() {
    return new Error('The Open Play report response was invalid. Refresh and try again.');
  }

  function reportNumber(value, { integer = false, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return null;
    if (integer && !Number.isSafeInteger(value)) return null;
    return value;
  }

  function reportText(value, max, { required = true } = {}) {
    if (typeof value !== 'string' || value.length > max || value !== value.trim() ||
        /[\u0000-\u001F\u007F]/.test(value)) return null;
    if (required && !value) return null;
    return value;
  }

  function reportCurrency(value) {
    return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
  }

  function moneyBalances(grossCollected, venueSales, serviceFees, refundsCompleted, netCollected) {
    const cents = value => Math.round(value * 100);
    return cents(grossCollected) === cents(venueSales) + cents(serviceFees) &&
      cents(refundsCompleted) <= cents(grossCollected) &&
      cents(netCollected) === Math.max(0, cents(grossCollected) - cents(refundsCompleted));
  }

  function normalizeReportFinancials(raw) {
    if (!isPlainObject(raw)) return null;
    const venueSales = reportNumber(raw.venueSales);
    const serviceFees = reportNumber(raw.serviceFees);
    const grossCollected = reportNumber(raw.grossCollected);
    const refundsCompleted = reportNumber(raw.refundsCompleted);
    const netCollected = reportNumber(raw.netCollected);
    if ([venueSales, serviceFees, grossCollected, refundsCompleted, netCollected].includes(null) ||
        !moneyBalances(grossCollected, venueSales, serviceFees, refundsCompleted, netCollected)) {
      return null;
    }
    return { venueSales, serviceFees, grossCollected, refundsCompleted, netCollected };
  }

  function normalizeReportSummary(raw) {
    if (!isPlainObject(raw)) return null;
    const financials = normalizeReportFinancials(raw);
    const integerFields = [
      'sessionsHeld',
      'sessionsScheduled',
      'sessionsCancelled',
      'totalCapacity',
      'paidSpots',
      'heldSpots',
      'checkedInPlayers',
      'paymentReviewCount',
      'anomalyCount',
    ];
    const integers = Object.fromEntries(integerFields.map(field => [
      field,
      reportNumber(raw[field], { integer: true }),
    ]));
    const occupancyRate = reportNumber(raw.occupancyRate, { max: 100 });
    const paymentReviewAmount = reportNumber(raw.paymentReviewAmount);
    const refundLiability = reportNumber(raw.refundLiability);
    const currency = reportCurrency(raw.currency);
    if (!financials || Object.values(integers).includes(null) || occupancyRate == null ||
        paymentReviewAmount == null || refundLiability == null || !currency ||
        integers.checkedInPlayers > integers.paidSpots ||
        integers.paidSpots > integers.totalCapacity) {
      return null;
    }
    const expectedOccupancy = integers.totalCapacity === 0
      ? 0
      : Math.round(integers.paidSpots * 10000 / integers.totalCapacity) / 100;
    if (Math.abs(occupancyRate - expectedOccupancy) > 0.01) return null;
    return Object.freeze({
      ...integers,
      occupancyRate,
      ...financials,
      paymentReviewAmount,
      refundLiability,
      currency,
    });
  }

  function normalizeReportSession(raw) {
    if (!isPlainObject(raw) || !validUuid(raw.id) || !validManilaDate(raw.date) ||
        !validServerTime(raw.startsAt)) return null;
    const title = reportText(raw.title, 120);
    const status = typeof raw.status === 'string' && SESSION_STATUSES.has(raw.status)
      ? raw.status
      : null;
    const courtNames = Array.isArray(raw.courtNames) && [1, 2].includes(raw.courtNames.length)
      ? raw.courtNames.map(name => reportText(name, 120))
      : null;
    const capacity = reportNumber(raw.capacity, { integer: true });
    const paidSpots = reportNumber(raw.paidSpots, { integer: true });
    const checkedInPlayers = reportNumber(raw.checkedInPlayers, { integer: true });
    const financials = normalizeReportFinancials(raw);
    if (!title || !status || !courtNames || courtNames.includes(null) || capacity == null ||
        paidSpots == null || checkedInPlayers == null || paidSpots > capacity ||
        checkedInPlayers > paidSpots || !financials) {
      return null;
    }
    return Object.freeze({
      id: raw.id,
      title,
      date: raw.date,
      startsAt: raw.startsAt,
      status,
      courtNames: Object.freeze([...courtNames]),
      capacity,
      paidSpots,
      checkedInPlayers,
      ...financials,
    });
  }

  function normalizeReportAmountBreakdown(raw) {
    if (!isPlainObject(raw)) return null;
    const key = reportText(raw.key, 80);
    const label = reportText(raw.label, 120);
    const amount = reportNumber(raw.amount);
    if (!key || !label || amount == null) return null;
    return Object.freeze({ key, label, amount });
  }

  function normalizeReportMonth(raw) {
    if (!isPlainObject(raw) || typeof raw.period !== 'string' || !/^\d{4}-\d{2}$/.test(raw.period) ||
        !validManilaDate(`${raw.period}-01`)) return null;
    const label = reportText(raw.label, 80);
    const financials = normalizeReportFinancials(raw);
    if (!label || !financials) return null;
    return Object.freeze({ period: raw.period, label, ...financials });
  }

  function normalizeReportBreakdowns(raw) {
    if (!isPlainObject(raw) || !Array.isArray(raw.sessions) || !Array.isArray(raw.paymentMethods) ||
        !Array.isArray(raw.receivingAccounts) || !Array.isArray(raw.monthlyTrend)) return null;
    const sessions = raw.sessions.map(normalizeReportSession);
    const paymentMethods = raw.paymentMethods.map(normalizeReportAmountBreakdown);
    const receivingAccounts = raw.receivingAccounts.map(normalizeReportAmountBreakdown);
    const monthlyTrend = raw.monthlyTrend.map(normalizeReportMonth);
    if ([...sessions, ...paymentMethods, ...receivingAccounts, ...monthlyTrend].includes(null)) return null;
    return Object.freeze({
      sessions: Object.freeze(sessions),
      paymentMethods: Object.freeze(paymentMethods),
      receivingAccounts: Object.freeze(receivingAccounts),
      monthlyTrend: Object.freeze(monthlyTrend),
    });
  }

  function optionalReportTime(value) {
    return value === '' ? '' : (validServerTime(value) ? value : null);
  }

  function normalizeReportRow(raw) {
    if (!isPlainObject(raw) || !validUuid(raw.registrationId) || !validUuid(raw.sessionId) ||
        !validManilaDate(raw.sessionDate) || !validServerTime(raw.startsAt)) return null;
    const reference = reportText(raw.reference, 80);
    const sessionTitle = reportText(raw.sessionTitle, 120);
    const courtNames = Array.isArray(raw.courtNames) && [1, 2].includes(raw.courtNames.length)
      ? raw.courtNames.map(name => reportText(name, 120))
      : null;
    const quantity = reportNumber(raw.quantity, { integer: true });
    const registrationStatus = typeof raw.registrationStatus === 'string' &&
      REGISTRATION_STATUSES.has(raw.registrationStatus) ? raw.registrationStatus : null;
    const paymentStatus = typeof raw.paymentStatus === 'string' && PAYMENT_STATUSES.has(raw.paymentStatus)
      ? raw.paymentStatus
      : null;
    const paymentMethod = reportText(raw.paymentMethod, 80, { required: false });
    const receivingAccount = reportText(raw.receivingAccount, 120, { required: false });
    const currency = reportCurrency(raw.currency);
    const venueSubtotal = reportNumber(raw.venueSubtotal);
    const serviceFee = reportNumber(raw.serviceFee);
    const customerTotal = reportNumber(raw.customerTotal);
    const grossCollected = reportNumber(raw.grossCollected);
    const refundLiability = reportNumber(raw.refundLiability);
    const refundsCompleted = reportNumber(raw.refundsCompleted);
    const netCollected = reportNumber(raw.netCollected);
    const createdAt = validServerTime(raw.createdAt) ? raw.createdAt : null;
    const paidAt = optionalReportTime(raw.paidAt);
    const checkedInAt = optionalReportTime(raw.checkedInAt);
    const cents = value => Math.round(value * 100);
    const amounts = [venueSubtotal, serviceFee, customerTotal, grossCollected, refundLiability,
      refundsCompleted, netCollected];
    const collectionExpected = ['paid', 'refunded'].includes(paymentStatus) ? customerTotal : 0;
    if (!reference || reference !== reference.toUpperCase() || !sessionTitle || !courtNames ||
        courtNames.includes(null) || quantity == null || quantity < 1 || quantity > 4 || !registrationStatus ||
        !paymentStatus || paymentMethod == null || receivingAccount == null || !currency ||
        amounts.includes(null) || cents(customerTotal) !== cents(venueSubtotal) + cents(serviceFee) ||
        cents(grossCollected) !== cents(collectionExpected) ||
        cents(refundsCompleted) > cents(grossCollected) ||
        cents(netCollected) !== Math.max(0, cents(grossCollected) - cents(refundsCompleted)) ||
        (['paid', 'refunded'].includes(paymentStatus) && !paidAt) ||
        createdAt == null || paidAt == null || checkedInAt == null) {
      return null;
    }
    return Object.freeze({
      registrationId: raw.registrationId,
      reference,
      sessionId: raw.sessionId,
      sessionTitle,
      sessionDate: raw.sessionDate,
      startsAt: raw.startsAt,
      courtNames: Object.freeze([...courtNames]),
      quantity,
      venueSubtotal,
      serviceFee,
      customerTotal,
      grossCollected,
      registrationStatus,
      paymentStatus,
      paymentMethod,
      receivingAccount,
      refundLiability,
      refundsCompleted,
      netCollected,
      currency,
      createdAt,
      paidAt,
      checkedInAt,
    });
  }

  function normalizeReportResponse(payload, request) {
    if (!isPlainObject(payload) || payload.tenantSlug !== tenantSlug ||
        payload.timezone !== REPORT_TIMEZONE || typeof payload.complete !== 'boolean' ||
        !validServerTime(payload.serverTime) || !isPlainObject(payload.range) ||
        payload.range.from !== request.from || payload.range.to !== request.to) {
      throw reportError();
    }
    const summary = normalizeReportSummary(payload.summary);
    const breakdowns = normalizeReportBreakdowns(payload.breakdowns);
    const rows = Array.isArray(payload.rows) ? payload.rows.map(normalizeReportRow) : null;
    const pagination = payload.pagination;
    const nextCursor = isPlainObject(pagination) && pagination.nextCursor === null
      ? null
      : (isPlainObject(pagination) && validReportCursor(pagination.nextCursor) ? pagination.nextCursor : undefined);
    const paginationValid = isPlainObject(pagination) && typeof pagination.hasMore === 'boolean' &&
      nextCursor !== undefined && pagination.hasMore === (nextCursor !== null) &&
      nextCursor !== request.cursor;
    const rowsAllowed = request.includeRows || (Array.isArray(rows) && rows.length === 0 &&
      paginationValid && pagination.hasMore === false);
    const sessionsInRange = breakdowns && breakdowns.sessions.every(item =>
      item.date >= request.from && item.date <= request.to
    );
    const uniqueSessions = breakdowns &&
      new Set(breakdowns.sessions.map(item => item.id)).size === breakdowns.sessions.length;
    const uniquePaymentMethods = breakdowns &&
      new Set(breakdowns.paymentMethods.map(item => item.key)).size === breakdowns.paymentMethods.length;
    const uniqueReceivingAccounts = breakdowns &&
      new Set(breakdowns.receivingAccounts.map(item => item.key)).size === breakdowns.receivingAccounts.length;
    const uniqueMonths = breakdowns &&
      new Set(breakdowns.monthlyTrend.map(item => item.period)).size === breakdowns.monthlyTrend.length;
    const rowsValid = Array.isArray(rows) && rows.length <= request.pageSize && !rows.includes(null) &&
      rows.every(item => item.sessionDate >= request.from && item.sessionDate <= request.to) &&
      new Set(rows.map(item => item.registrationId)).size === rows.length;
    const cents = value => Math.round(Number(value || 0) * 100);
    const sum = (items, field) => items.reduce((total, item) => total + cents(item[field]), 0);
    const sessionFinancialsMatch = breakdowns && ['venueSales', 'serviceFees', 'grossCollected',
      'refundsCompleted', 'netCollected'].every(field =>
        sum(breakdowns.sessions, field) === cents(summary?.[field])) &&
      sum(breakdowns.sessions, 'paidSpots') === summary?.paidSpots * 100 &&
      sum(breakdowns.sessions, 'checkedInPlayers') === summary?.checkedInPlayers * 100;
    const sessionCountsMatch = breakdowns &&
      breakdowns.sessions.filter(item => item.status === 'completed').length === summary?.sessionsHeld &&
      breakdowns.sessions.filter(item => item.status === 'published').length === summary?.sessionsScheduled &&
      breakdowns.sessions.filter(item => item.status === 'cancelled').length === summary?.sessionsCancelled &&
      breakdowns.sessions.filter(item => ['published', 'completed'].includes(item.status))
        .reduce((total, item) => total + item.capacity, 0) === summary?.totalCapacity;
    const financialFields = ['venueSales', 'serviceFees', 'grossCollected', 'refundsCompleted', 'netCollected'];
    const sessionMonths = breakdowns && breakdowns.sessions.reduce((months, item) => {
      const period = item.date.slice(0, 7);
      const totals = months.get(period) || Object.fromEntries(financialFields.map(field => [field, 0]));
      financialFields.forEach(field => { totals[field] += cents(item[field]); });
      months.set(period, totals);
      return months;
    }, new Map());
    const nonzeroSessionMonths = sessionMonths && new Map([...sessionMonths].filter(([, totals]) =>
      financialFields.some(field => totals[field] !== 0)));
    const monthlyMatches = breakdowns &&
      nonzeroSessionMonths.size === breakdowns.monthlyTrend.length &&
      breakdowns.monthlyTrend.every(item => {
        const expected = nonzeroSessionMonths.get(item.period);
        return expected && financialFields.every(field => expected[field] === cents(item[field]));
      }) &&
      financialFields.every(field => sum(breakdowns.monthlyTrend, field) === cents(summary?.[field]));
    const paymentMethodsMatch = breakdowns &&
      sum(breakdowns.paymentMethods, 'amount') === cents(summary?.grossCollected);
    const receivingAccountsMatch = breakdowns &&
      sum(breakdowns.receivingAccounts, 'amount') === cents(summary?.grossCollected);
    if (!summary || !breakdowns || !rowsValid || !paginationValid || !rowsAllowed || !sessionsInRange ||
        !uniqueSessions || !uniquePaymentMethods || !uniqueReceivingAccounts || !uniqueMonths ||
        !sessionFinancialsMatch || !sessionCountsMatch || !monthlyMatches || !paymentMethodsMatch ||
        !receivingAccountsMatch) {
      throw reportError();
    }
    return Object.freeze({
      tenantSlug,
      timezone: REPORT_TIMEZONE,
      range: Object.freeze({ from: request.from, to: request.to }),
      complete: payload.complete,
      serverTime: payload.serverTime,
      summary,
      breakdowns,
      rows: Object.freeze(rows),
      pagination: Object.freeze({ nextCursor, hasMore: pagination.hasMore }),
    });
  }

  function normalizeRefundLiability(value) {
    if (value == null || value === false) return null;
    if (value === true) return true;
    const amount = Number(value);
    if (Number.isFinite(amount) && amount >= 0) return amount;
    if (typeof value === 'string') return asText(value, 40).toLowerCase() || null;
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const normalized = {};
    const rawAmount = Number(value.amount ?? value.refundAmount ?? value.total);
    if (Number.isFinite(rawAmount) && rawAmount >= 0) normalized.amount = rawAmount;
    const currency = asText(value.currency, 3).toUpperCase();
    if (currency) normalized.currency = currency;
    const status = asText(value.status, 40).toLowerCase();
    if (status) normalized.status = status;
    return Object.keys(normalized).length ? Object.freeze(normalized) : true;
  }

  function validUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(value || ''));
  }

  function validRequestId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(value || ''));
  }

  function safeHttpsUrl(value) {
    const raw = asText(value, 1000);
    if (!raw) return '';
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function normalizeSession(raw, { manager = false } = {}) {
    if (!raw || typeof raw !== 'object' || !validUuid(raw.id)) return null;
    const courtIds = Array.isArray(raw.courtIds)
      ? [...new Set(raw.courtIds.map(value => asText(value, 80)).filter(Boolean))]
      : [];
    const courtNames = Array.isArray(raw.courtNames)
      ? raw.courtNames.map(value => asText(value, 120)).filter(Boolean)
      : [];
    const capacity = asInteger(raw.capacity);
    const confirmedCount = Math.max(0, asInteger(raw.confirmedCount));
    const heldCount = Math.max(0, asInteger(raw.heldCount));
    const spotsRemaining = Math.max(0, Math.min(
      capacity,
      asInteger(raw.spotsRemaining, Math.max(0, capacity - confirmedCount - heldCount))
    ));
    const pricePerPerson = asNumber(raw.pricePerPerson, -1);
    const serviceFeePerPerson = Math.max(0, asNumber(
      raw.serviceFeePerPerson ??
      raw.service_fee_per_person ??
      raw.openPlayServiceFeePerPerson ??
      raw.open_play_service_fee_per_person ??
      raw.serviceFee ??
      raw.service_fee
    ));
    const status = SESSION_STATUSES.has(String(raw.status || '').toLowerCase())
      ? String(raw.status).toLowerCase()
      : '';
    const date = asText(raw.date, 10);
    const startsAt = asText(raw.startsAt, 40);
    const endsAt = asText(raw.endsAt, 40);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(Date.parse(startsAt)) ||
        Number.isNaN(Date.parse(endsAt)) ||
        Date.parse(endsAt) <= Date.parse(startsAt) ||
        ![1, 2].includes(courtNames.length) ||
        (courtIds.length > 0 && ![1, 2].includes(courtIds.length)) ||
        (manager && ![1, 2].includes(courtIds.length)) ||
        capacity < 1 ||
        pricePerPerson < 0 ||
        !status) {
      return null;
    }
    return Object.freeze({
      id: String(raw.id),
      version: Math.max(1, asInteger(raw.version, 1)),
      title: asText(raw.title, 120) || 'Open Play',
      date,
      startsAt,
      endsAt,
      courtIds: Object.freeze(courtIds.slice(0, 2)),
      courtNames: Object.freeze(courtNames),
      pricePerPerson,
      serviceFeePerPerson,
      currency: asText(raw.currency, 3).toUpperCase() || 'PHP',
      capacity,
      confirmedCount,
      heldCount,
      spotsRemaining,
      paymentReviewCount: Math.max(0, asInteger(raw.paymentReviewCount)),
      collectedTotal: Math.max(0, asNumber(raw.collectedTotal)),
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
      status,
      statusReason: asText(raw.statusReason, 1000),
      skillLevel: asText(raw.skillLevel, 80),
      notes: asText(raw.notes, 2000),
      createdAt: asText(raw.createdAt, 40),
      updatedAt: asText(raw.updatedAt, 40),
    });
  }

  function normalizePaymentMethod(raw) {
    if (!raw || typeof raw !== 'object' || raw.isActive === false) return null;
    const code = asText(raw.code || raw.methodCode, 40).toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(code) || code === 'cash') return null;
    const accountName = asText(raw.accountName, 120);
    const accountReference = asText(raw.accountReference || raw.accountNumber, 120);
    if (!accountName || !accountReference) return null;
    return Object.freeze({
      code,
      displayName: asText(raw.displayName, 80) || code.toUpperCase(),
      accountName,
      accountReference,
      qrImageUrl: safeHttpsUrl(raw.qrImageUrl || raw.qrUrl),
      instructions: asText(raw.instructions, 1000),
    });
  }

  function normalizeRegistration(raw, { requireAccess = false, nowMs = Date.now() } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const reference = asText(raw.reference, 80).toUpperCase();
    const accessToken = asText(raw.accessToken, 500);
    const quantity = asInteger(raw.quantity);
    let status = String(raw.status || '').toLowerCase();
    const paymentStatus = String(raw.paymentStatus || '').toLowerCase();
    const total = asNumber(raw.total, -1);
    const session = raw.session ? normalizeSession(raw.session) : null;
    const sessionEnded = session && (
      session.status === 'completed' ||
      (!Number.isNaN(Date.parse(session.endsAt)) && Date.parse(session.endsAt) <= nowMs)
    );
    if (sessionEnded && ['confirmed', 'checked_in'].includes(status)) status = 'completed';
    if (!reference || !validUuid(raw.sessionId) || quantity < 1 || quantity > 4 ||
        !REGISTRATION_STATUSES.has(status) ||
        !PAYMENT_STATUSES.has(paymentStatus) ||
        total < 0 ||
        (requireAccess && !accessToken)) {
      return null;
    }
    return Object.freeze({
      id: validUuid(raw.id) ? String(raw.id) : '',
      reference,
      accessToken,
      sessionId: String(raw.sessionId),
      quantity,
      unitPrice: Math.max(0, asNumber(raw.unitPrice)),
      subtotal: Math.max(0, asNumber(raw.subtotal)),
      serviceFee: Math.max(0, asNumber(
        raw.serviceFee ??
        raw.service_fee ??
        raw.openPlayServiceFee ??
        raw.open_play_service_fee
      )),
      total,
      status,
      paymentStatus,
      paymentMethod: asText(raw.paymentMethod, 40).toLowerCase(),
      paymentReference: asText(raw.paymentReference, 120),
      statusReason: asText(raw.statusReason, 1000),
      refundRequired: asBoolean(raw.refundRequired),
      refundReviewRequired: asBoolean(raw.refundReviewRequired),
      refundLiability: normalizeRefundLiability(raw.refundLiability),
      refundStatus: asText(raw.refundStatus, 40).toLowerCase(),
      remittancePrepared: asBoolean(raw.remittancePrepared),
      expiresAt: asText(raw.expiresAt, 40),
      createdAt: asText(raw.createdAt, 40),
      updatedAt: asText(raw.updatedAt, 40),
      session,
    });
  }

  function parsePayload(text) {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      return {};
    }
  }

  function errorMessage(payload, fallback) {
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
    if (payload?.error?.message) return String(payload.error.message);
    if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
    return fallback;
  }

  function payloadServerNow(payload) {
    const raw = asText(payload?.serverTime, 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      return Date.now();
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  async function authHeaders({ manager = false, json = true } = {}) {
    if (!supabaseUrl || !publishableKey) throw new Error('Open Play is not configured.');
    let bearer = publishableKey;
    if (manager) {
      const { data, error } = await global._supabase?.auth?.getSession?.() || {};
      if (error || !data?.session?.access_token) {
        throw new Error('Your dashboard session is no longer available. Please sign in again.');
      }
      bearer = data.session.access_token;
    }
    return {
      apikey: publishableKey,
      'X-Tenant-Slug': tenantSlug,
      Authorization: `Bearer ${bearer}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async function fetchWithTimeout(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      return await fetch(url, controller ? { ...init, signal: controller.signal } : init);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('The Open Play request timed out. Please check your connection and try again.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function invoke(functionName, body, { manager = false } = {}) {
    const response = await fetchWithTimeout(
      `${supabaseUrl}/functions/v1/${functionName}?tenantSlug=${encodeURIComponent(tenantSlug)}`,
      {
        method: 'POST',
        headers: await authHeaders({ manager }),
        body: JSON.stringify({ ...body, tenantSlug }),
      }
    );
    const text = await response.text();
    const payload = parsePayload(text);
    if (!response.ok || payload?.ok !== true) {
      const failure = new Error(errorMessage(payload, `Open Play request failed (HTTP ${response.status}).`));
      failure.code = payload?.error?.code || payload?.code || null;
      failure.httpStatus = response.status;
      throw failure;
    }
    return payload;
  }

  async function requireEnabled() {
    if (!await syncReadiness()) {
      throw new Error('Open Play is not available yet.');
    }
  }

  function requireOperational() {
    if (!configured()) {
      throw new Error('Open Play is not configured.');
    }
  }

  async function getPublicOpenPlaySessions() {
    if (!await syncReadiness()) return { sessions: [], serverTime: '' };
    const payload = await invoke('open-play-public', { action: 'list' });
    const sessions = (Array.isArray(payload.sessions) ? payload.sessions : [])
      .map(session => normalizeSession(session))
      .filter(Boolean);
    return { sessions, serverTime: asText(payload.serverTime, 40) };
  }

  async function createPublicOpenPlayRegistration(input = {}) {
    await requireEnabled();
    const sessionId = asText(input.sessionId, 80);
    const quantity = asInteger(input.quantity);
    const customer = input.customer && typeof input.customer === 'object' ? input.customer : {};
    const clientRequestId = asText(input.clientRequestId, 80).toLowerCase();
    if (!validUuid(sessionId) || quantity < 1 || quantity > 4 || !validRequestId(clientRequestId)) {
      throw new Error('The Open Play reservation details are incomplete.');
    }
    const payload = await invoke('open-play-public', {
      action: 'reserve',
      sessionId,
      quantity,
      customer: {
        name: asText(customer.name, 120),
        email: asText(customer.email, 254).toLowerCase(),
        phone: asText(customer.phone, 40),
      },
      clientRequestId,
    });
    const registration = normalizeRegistration(payload.registration, {
      requireAccess: true,
      nowMs: payloadServerNow(payload),
    });
    if (!registration) throw new Error('The reservation service returned an invalid registration.');
    const paymentMethods = (Array.isArray(payload.paymentMethods) ? payload.paymentMethods : [])
      .map(normalizePaymentMethod)
      .filter(Boolean);
    if (registration.total > 0 && paymentMethods.length === 0) {
      throw new Error('No digital payment method is available for this Open Play session.');
    }
    return { registration, paymentMethods, serverTime: asText(payload.serverTime, 40) };
  }

  async function getPublicOpenPlayRegistrationStatus({ reference, accessToken } = {}) {
    requireOperational();
    const payload = await invoke('open-play-public', {
      action: 'status',
      reference: asText(reference, 80).toUpperCase(),
      accessToken: asText(accessToken, 500),
    });
    const registration = normalizeRegistration(payload.registration, { nowMs: payloadServerNow(payload) });
    if (!registration) throw new Error('The reservation status response was invalid.');
    const paymentMethods = (Array.isArray(payload.paymentMethods) ? payload.paymentMethods : [])
      .map(normalizePaymentMethod)
      .filter(Boolean);
    return { registration, paymentMethods, serverTime: asText(payload.serverTime, 40) };
  }

  async function cancelPublicOpenPlayRegistration({ reference, accessToken, clientRequestId } = {}) {
    requireOperational();
    if (!validRequestId(clientRequestId)) throw new Error('A secure cancellation request could not be created.');
    const payload = await invoke('open-play-public', {
      action: 'cancel',
      reference: asText(reference, 80).toUpperCase(),
      accessToken: asText(accessToken, 500),
      clientRequestId: String(clientRequestId).toLowerCase(),
    });
    const registration = normalizeRegistration(payload.registration, { nowMs: payloadServerNow(payload) });
    if (!registration) throw new Error('The cancellation response was invalid.');
    return { registration, serverTime: asText(payload.serverTime, 40) };
  }

  async function submitPublicOpenPlayReceipt({
    reference,
    accessToken,
    paymentMethod,
    paymentReference,
    receiptFile,
  } = {}) {
    requireOperational();
    const normalizedPaymentReference = asText(paymentReference, 64);
    if (!/^[\x20-\x7E]{1,64}$/.test(normalizedPaymentReference)) {
      throw new Error('Enter a payment reference using 1–64 printable characters.');
    }
    if (!receiptFile) throw new Error('Add a clear payment receipt screenshot.');
    let imageFile = receiptFile;
    if (typeof _pbPrepareReceiptImage === 'function') {
      imageFile = await _pbPrepareReceiptImage(receiptFile);
    }
    const imageType = String(imageFile?.type || '').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(imageType)) {
      throw new Error('Use a JPEG, PNG, or WebP receipt image.');
    }
    if (Number(imageFile?.size || 0) > 8 * 1024 * 1024) {
      throw new Error('The receipt image must be 8 MB or smaller.');
    }
    const form = new FormData();
    form.append('receiptFile', imageFile, imageFile.name || 'open-play-receipt.jpg');
    const response = await fetchWithTimeout(
      `${supabaseUrl}/functions/v1/open-play-receipt?tenantSlug=${encodeURIComponent(tenantSlug)}`,
      {
        method: 'POST',
        headers: {
          ...(await authHeaders({ json: false })),
          'X-Open-Play-Reference': asText(reference, 80).toUpperCase(),
          'X-Open-Play-Token': asText(accessToken, 500),
          'X-Payment-Method': asText(paymentMethod, 40).toLowerCase(),
          'X-Payment-Reference': normalizedPaymentReference,
        },
        body: form,
      },
      RECEIPT_TIMEOUT_MS
    );
    const text = await response.text();
    const payload = parsePayload(text);
    if (!response.ok || payload?.ok !== true) {
      const failure = new Error(errorMessage(payload, `Receipt upload failed (HTTP ${response.status}).`));
      failure.code = payload?.error?.code || payload?.code || null;
      failure.httpStatus = response.status;
      throw failure;
    }
    const registration = normalizeRegistration(payload.registration, { nowMs: payloadServerNow(payload) });
    if (!registration) throw new Error('The receipt service returned an invalid registration.');
    return { registration, serverTime: asText(payload.serverTime, 40) };
  }

  async function getManagerOpenPlaySessions(filters = {}) {
    requireOperational();
    const payload = await invoke('open-play-manager', {
      action: 'list_sessions',
      scope: ['upcoming', 'past', 'all'].includes(filters.scope) ? filters.scope : 'upcoming',
    }, { manager: true });
    return (Array.isArray(payload.sessions) ? payload.sessions : [])
      .map(session => normalizeSession(session, { manager: true }))
      .filter(Boolean);
  }

  async function getManagerOpenPlayReport(options = {}) {
    requireOperational();
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Choose a valid Open Play report date range.');
    }
    const from = options.from;
    const to = options.to;
    const includeRows = options.includeRows === undefined ? false : options.includeRows;
    const pageSize = options.pageSize === undefined ? REPORT_DEFAULT_PAGE_SIZE : options.pageSize;
    const cursor = options.cursor;
    const rangeDays = reportRangeDays(from, to);
    if (!validManilaDate(from) || !validManilaDate(to) || from > to ||
        rangeDays == null || rangeDays < 1 || rangeDays > 366 ||
        typeof includeRows !== 'boolean' || !Number.isSafeInteger(pageSize) ||
        pageSize < 1 || pageSize > REPORT_MAX_PAGE_SIZE ||
        (cursor !== undefined && !validReportCursor(cursor)) ||
        (cursor !== undefined && includeRows !== true)) {
      throw new Error('Choose a valid Open Play report date range.');
    }
    const request = { from, to, includeRows, pageSize, cursor };
    const payload = await invoke('open-play-manager', {
      action: 'report_summary',
      from,
      to,
      timezone: REPORT_TIMEZONE,
      pageSize,
      includeRows,
      ...(cursor === undefined ? {} : { cursor }),
    }, { manager: true });
    return normalizeReportResponse(payload, request);
  }

  async function saveOpenPlaySession(session = {}, options = {}) {
    await requireEnabled();
    const clientRequestId = asText(options.clientRequestId, 80).toLowerCase();
    if (!validRequestId(clientRequestId)) throw new Error('A secure session request could not be created.');
    const payload = await invoke('open-play-manager', {
      action: 'save_session',
      session,
      expectedVersion: options.expectedVersion == null ? null : asInteger(options.expectedVersion),
      clientRequestId,
    }, { manager: true });
    const normalized = normalizeSession(payload.session, { manager: true });
    if (!normalized) throw new Error('The session service returned invalid data.');
    return normalized;
  }

  async function cancelOpenPlaySession(id, options = {}) {
    requireOperational();
    const clientRequestId = asText(options.clientRequestId, 80).toLowerCase();
    if (!validUuid(id) || !validRequestId(clientRequestId)) throw new Error('The cancellation request is invalid.');
    const payload = await invoke('open-play-manager', {
      action: 'cancel_session',
      sessionId: String(id),
      reason: asText(options.reason, 500),
      expectedVersion: options.expectedVersion == null ? null : asInteger(options.expectedVersion),
      clientRequestId,
    }, { manager: true });
    const normalized = normalizeSession(payload.session, { manager: true });
    if (!normalized) throw new Error('The session cancellation response was invalid.');
    return normalized;
  }

  async function getManagerOpenPlayRegistrations(sessionId) {
    requireOperational();
    if (!validUuid(sessionId)) throw new Error('Choose a valid Open Play session.');
    const payload = await invoke('open-play-manager', {
      action: 'list_registrations',
      sessionId: String(sessionId),
    }, { manager: true });
    return Array.isArray(payload.registrations) ? payload.registrations : [];
  }

  async function updateOpenPlayRegistrationStatus(id, options = {}) {
    requireOperational();
    const clientRequestId = asText(options.clientRequestId, 80).toLowerCase();
    const action = asText(options.action, 40).toLowerCase();
    if (!validUuid(id) || !validRequestId(clientRequestId) ||
        !['confirm', 'reject', 'cancel', 'check_in'].includes(action)) {
      throw new Error('The roster update request is invalid.');
    }
    const payload = await invoke('open-play-manager', {
      action: 'update_registration',
      registrationId: String(id),
      registrationAction: action,
      reason: asText(options.reason, 500),
      clientRequestId,
    }, { manager: true });
    return payload.registration || null;
  }

  Object.assign(global.DB || {}, {
    getPublicOpenPlaySessions,
    createPublicOpenPlayRegistration,
    getPublicOpenPlayRegistrationStatus,
    cancelPublicOpenPlayRegistration,
    submitPublicOpenPlayReceipt,
    getManagerOpenPlaySessions,
    getManagerOpenPlayReport,
    saveOpenPlaySession,
    cancelOpenPlaySession,
    getManagerOpenPlayRegistrations,
    updateOpenPlayRegistrationStatus,
  });

  global.OpenPlayData = Object.freeze({
    configured,
    requested,
    syncReadiness,
    normalizeSession,
    normalizeRegistration,
    normalizePaymentMethod,
    normalizeReportResponse,
    validManilaDate,
    validRequestId,
  });
})(window);
