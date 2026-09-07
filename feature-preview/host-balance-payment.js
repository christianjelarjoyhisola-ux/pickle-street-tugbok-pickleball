(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HostBalancePayment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FUNCTION_NAME = 'host-booking-balance-payment';
  const PAYMENT_TABLE = 'host_booking_balance_payments';
  const HOST_ATTEMPT_COLUMNS = [
    'id', 'booking_key', 'booking_ref', 'booking_group_ref', 'booking_refs',
    'status', 'total_amount', 'original_paid_amount', 'expected_amount',
    'balance_due_at', 'submitted_at', 'reviewed_at', 'approved_at',
    'rejected_at', 'review_reason', 'created_at', 'updated_at',
  ].join(',');
  const APPROVED_STATES = new Set(['approved', 'auto_approved', 'paid', 'completed', 'confirmed']);
  const PENDING_STATES = new Set(['pending', 'pending_review', 'manual_review', 'for_verification', 'verifying', 'processing', 'submitted']);
  const REJECTED_STATES = new Set(['rejected', 'failed', 'declined', 'cancelled', 'canceled', 'expired']);

  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  function lower(value) {
    return cleanText(value).toLowerCase();
  }

  function money(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0;
  }

  function itemsFor(booking) {
    return Array.isArray(booking?.items) && booking.items.length
      ? booking.items.filter(Boolean)
      : [booking].filter(Boolean);
  }

  function paymentStatusOf(booking) {
    return lower(booking?.paymentStatus ?? booking?.payment_status ?? 'unpaid');
  }

  function bookingStatusOf(booking) {
    return lower(booking?.status);
  }

  function directPaidAmount(booking) {
    const total = money(booking?.total);
    const status = paymentStatusOf(booking);
    if (status === 'paid') return total;
    if (status === 'downpayment_paid' || status === 'deposit_retained') {
      return Math.min(total, money(booking?.downpayment));
    }
    return 0;
  }

  function paidAmount(booking) {
    const rows = itemsFor(booking);
    if (rows.length > 1) return money(rows.reduce((sum, row) => sum + directPaidAmount(row), 0));
    return directPaidAmount(booking);
  }

  function balanceAmount(booking) {
    return money(money(booking?.total) - paidAmount(booking));
  }

  function endOfBalanceDueDate(dateValue) {
    const date = cleanText(dateValue).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const calendar = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(calendar.getTime())) return null;
    calendar.setUTCDate(calendar.getUTCDate() - 5);
    return new Date(`${calendar.toISOString().slice(0, 10)}T23:59:59.999+08:00`);
  }

  function balanceDeadline(booking) {
    const explicit = itemsFor(booking)
      .map(item => item?.balanceDueAt ?? item?.balance_due_at)
      .concat([booking?.balanceDueAt ?? booking?.balance_due_at])
      .filter(Boolean)
      .map(value => new Date(value))
      .filter(value => !Number.isNaN(value.getTime()))
      .sort((a, b) => a - b);
    if (explicit.length) return explicit[0];
    const dates = itemsFor(booking)
      .map(item => cleanText(item?.date).slice(0, 10))
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    return dates.length ? endOfBalanceDueDate(dates[0]) : null;
  }

  function bookingKey(booking) {
    return cleanText(
      booking?.bookingKey ??
      booking?.groupRef ??
      booking?.booking_group_ref ??
      booking?.displayRef ??
      booking?.ref
    );
  }

  function primaryBookingRef(booking) {
    const childRef = itemsFor(booking).map(item => cleanText(item?.ref)).find(Boolean);
    return cleanText(booking?.primaryRef ?? booking?.primary_ref ?? childRef ?? booking?.ref);
  }

  function bookingMatchesKey(booking, key) {
    const target = cleanText(key);
    if (!target || !booking) return false;
    const candidates = new Set([
      bookingKey(booking), primaryBookingRef(booking), cleanText(booking.ref),
      cleanText(booking.displayRef), cleanText(booking.groupRef), cleanText(booking.booking_group_ref),
    ].filter(Boolean));
    itemsFor(booking).forEach(item => {
      [item?.ref, item?.groupRef, item?.booking_group_ref]
        .map(cleanText).filter(Boolean).forEach(value => candidates.add(value));
    });
    return candidates.has(target);
  }

  function normalizeAttempt(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      paymentId: cleanText(source.paymentId ?? source.payment_id ?? source.id),
      bookingKey: cleanText(source.bookingKey ?? source.booking_key),
      bookingRef: cleanText(source.bookingRef ?? source.booking_ref),
      bookingGroupRef: cleanText(source.bookingGroupRef ?? source.booking_group_ref),
      bookingRefs: Array.isArray(source.bookingRefs ?? source.booking_refs)
        ? [...(source.bookingRefs ?? source.booking_refs)].map(cleanText).filter(Boolean)
        : [],
      status: lower(source.status),
      totalAmount: money(source.totalAmount ?? source.total_amount),
      originalPaidAmount: money(source.originalPaidAmount ?? source.original_paid_amount),
      balanceAmount: money(source.balanceAmount ?? source.expectedAmount ?? source.expected_amount),
      balanceDueAt: source.balanceDueAt ?? source.balance_due_at ?? null,
      submittedAt: source.submittedAt ?? source.submitted_at ?? null,
      reviewedAt: source.reviewedAt ?? source.reviewed_at ?? null,
      approvedAt: source.approvedAt ?? source.approved_at ?? null,
      rejectedAt: source.rejectedAt ?? source.rejected_at ?? null,
      reviewReason: cleanText(source.reviewReason ?? source.review_reason),
      createdAt: source.createdAt ?? source.created_at ?? null,
      updatedAt: source.updatedAt ?? source.updated_at ?? null,
    };
  }

  function attemptMatchesBooking(booking, attempt) {
    if (!booking || !attempt) return false;
    const normalized = normalizeAttempt(attempt);
    const refs = new Set([
      normalized.bookingKey,
      normalized.bookingRef,
      normalized.bookingGroupRef,
      ...normalized.bookingRefs,
    ].map(cleanText).filter(Boolean));
    for (const ref of refs) if (bookingMatchesKey(booking, ref)) return true;
    return false;
  }

  function latestAttemptForBooking(booking, attempts) {
    const matches = (Array.isArray(attempts) ? attempts : [])
      .map(normalizeAttempt)
      .filter(attempt => attemptMatchesBooking(booking, attempt));
    matches.sort((a, b) => {
      const aTime = Date.parse(a.updatedAt || a.createdAt || '') || 0;
      const bTime = Date.parse(b.updatedAt || b.createdAt || '') || 0;
      return bTime - aTime;
    });
    return matches[0] || null;
  }

  async function listMyAttempts(client) {
    if (!client?.from) throw new Error('Secure payment status is unavailable. Refresh and try again.');
    const { data, error } = await client
      .from(PAYMENT_TABLE)
      .select(HOST_ATTEMPT_COLUMNS)
      .order('updated_at', { ascending: false })
      .limit(1000);
    if (error) throw new Error(errorMessage(error, 'Could not load your payment status.'));
    if (!Array.isArray(data)) throw new Error('Payment status response is invalid.');
    return data.map(normalizeAttempt);
  }

  function eligibility(booking, now = new Date()) {
    const rows = itemsFor(booking);
    const balance = balanceAmount(booking);
    const deadline = balanceDeadline(booking);
    const result = {
      eligible: false,
      reason: '',
      balance,
      deadline,
      bookingKey: bookingKey(booking),
      bookingRef: primaryBookingRef(booking),
    };
    if (!rows.length || !rows.every(row => row?.hostBooking || row?.host_booking)) return { ...result, reason: 'not_host_booking' };
    if (!rows.every(row => bookingStatusOf(row) === 'confirmed')) return { ...result, reason: 'not_confirmed' };
    if (!rows.every(row => paymentStatusOf(row) === 'downpayment_paid')) return { ...result, reason: 'not_balance_due' };
    if (balance <= 0) return { ...result, reason: 'settled' };
    if (!deadline) return { ...result, reason: 'missing_deadline' };
    const current = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(current.getTime()) || current.getTime() >= deadline.getTime()) {
      return { ...result, reason: 'deadline_passed' };
    }
    if (!result.bookingKey || !result.bookingRef) return { ...result, reason: 'missing_reference' };
    return { ...result, eligible: true, reason: 'eligible' };
  }

  function buildQuotePayload(booking) {
    return { action: 'quote', bookingRef: bookingKey(booking) || primaryBookingRef(booking) };
  }

  function buildCreatePayload(quoteOrBooking, idempotencyKey, input = {}) {
    const ref = cleanText(
      quoteOrBooking?.bookingKey ?? quoteOrBooking?.booking_key ??
      quoteOrBooking?.bookingGroupRef ?? quoteOrBooking?.booking_group_ref
    ) || bookingKey(quoteOrBooking) ||
      cleanText(quoteOrBooking?.bookingRef ?? quoteOrBooking?.booking_ref) ||
      primaryBookingRef(quoteOrBooking);
    const provider = lower(input.paymentMethod ?? input.method);
    return {
      action: 'create',
      bookingKey: ref,
      bookingRef: ref,
      idempotencyKey: cleanText(idempotencyKey),
      paymentProvider: provider,
      provider,
      paymentReference: cleanText(input.paymentReference ?? input.reference),
    };
  }

  function unwrapResponse(value) {
    if (!value || typeof value !== 'object') return {};
    const quote = value.quote && typeof value.quote === 'object' ? value.quote : {};
    const payment = value.payment && typeof value.payment === 'object' ? value.payment : {};
    const attempt = value.currentAttempt && typeof value.currentAttempt === 'object'
      ? value.currentAttempt
      : value.current_attempt && typeof value.current_attempt === 'object'
        ? value.current_attempt
        : value.currentPayment && typeof value.currentPayment === 'object'
          ? value.currentPayment
          : value.current_payment && typeof value.current_payment === 'object'
            ? value.current_payment
            : value.attempt && typeof value.attempt === 'object' ? value.attempt : {};
    return { ...value, ...quote, ...payment, ...attempt };
  }

  function normalizeQuote(value, booking) {
    const source = unwrapResponse(value);
    const amount = money(
      source.balanceAmount ?? source.balance_amount ?? source.expectedAmount ?? source.expected_amount ??
      source.balance ?? source.remainingBalance ?? source.remaining_balance ?? source.amount ??
      source.amountPhp ?? source.amount_php
    );
    return {
      ...source,
      amount,
      balance: amount,
      paymentId: cleanText(source.paymentId ?? source.payment_id ?? source.balancePaymentId ?? source.balance_payment_id ?? source.id),
      verificationRef: cleanText(source.verificationRef ?? source.verification_ref ?? source.receiptVerificationRef ?? source.receipt_verification_ref),
      bookingKey: cleanText(source.bookingKey ?? source.booking_key ?? source.bookingGroupRef ?? source.booking_group_ref ?? bookingKey(booking)),
      bookingRef: cleanText(source.bookingRef ?? source.booking_ref ?? primaryBookingRef(booking)),
      groupRef: cleanText(source.bookingGroupRef ?? source.booking_group_ref ?? source.groupRef ?? source.group_ref ?? booking?.groupRef),
      deadline: source.deadline ?? source.balanceDueAt ?? source.balance_due_at ?? balanceDeadline(booking)?.toISOString() ?? null,
      date: cleanText(source.bookingDate ?? source.booking_date ?? source.date ?? booking?.date),
      courtName: cleanText(source.courtLabel ?? source.court_label ?? source.courtName ?? source.court_name ?? booking?.courtName),
      timeLabel: cleanText(source.scheduleLabel ?? source.schedule_label ?? source.timeLabel ?? source.time_label ?? booking?.timeLabel),
      fullName: cleanText(source.customerName ?? source.customer_name ?? source.fullName ?? source.full_name ?? booking?.fullName),
      status: cleanText(source.status ?? source.paymentStatus ?? source.payment_status),
      createdAt: source.createdAt ?? source.created_at ?? null,
      expiresAt: source.expiresAt ?? source.expires_at ?? null,
      paymentProvider: lower(source.paymentProvider ?? source.payment_provider ?? source.provider),
      paymentReference: cleanText(source.paymentReference ?? source.payment_reference),
      totalAmount: money(source.totalAmount ?? source.total_amount),
      paidAmount: money(source.paidAmount ?? source.paid_amount),
      verificationBookingData: source.verificationBookingData ?? source.verification_booking_data ?? source.bookingData ?? source.booking_data ?? null,
    };
  }

  function buildVerificationBookingData(quote) {
    const template = quote?.verificationBookingData && typeof quote.verificationBookingData === 'object'
      ? { ...quote.verificationBookingData }
      : null;
    const amount = money(quote?.amount ?? quote?.balance);
    const paymentId = cleanText(quote?.paymentId);
    if (!template) return null;
    if (
      lower(template.verification_context) !== 'host_booking_balance' ||
      cleanText(template.balance_payment_id) !== paymentId ||
      money(template.total) !== amount || money(template.downpayment) !== amount
    ) throw new Error('Secure balance verification details do not match this payment.');
    return template;
  }

  function buildSubmitPayload(quote, receiptResult) {
    return {
      action: 'submit',
      paymentId: cleanText(quote?.paymentId),
      receiptVerificationId: Number(receiptResult?.receiptVerificationId ?? receiptResult?.receipt_verification_id) || null,
    };
  }

  function statusState(value) {
    const source = unwrapResponse(value);
    const raw = lower(source.finalStatus ?? source.final_status ?? source.paymentStatus ?? source.payment_status ?? source.receiptStatus ?? source.receipt_status ?? source.status);
    if (APPROVED_STATES.has(raw)) return 'approved';
    if (REJECTED_STATES.has(raw)) return 'rejected';
    if (PENDING_STATES.has(raw)) return 'pending';
    return 'pending';
  }

  function safeImageUrl(value) {
    const url = cleanText(value);
    if (!url) return '';
    if (/^https:\/\/[^\s]+$/i.test(url)) return url;
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
    if (/^(?:\/|\.\/|\.\.\/)[^<>"']+$/.test(url)) return url;
    if (/^[a-z0-9][a-z0-9_./?=&%+-]*$/i.test(url) && !url.includes(':')) return url;
    return '';
  }

  function errorMessage(error, fallback = 'Balance payment request failed.') {
    if (typeof error === 'string' && error.trim()) return error.trim();
    const message = error?.message ?? error?.error?.message ?? error?.context?.message;
    return cleanText(message) || fallback;
  }

  async function invokeErrorMessage(error, fallback = 'Balance payment request failed.') {
    const generic = errorMessage(error, '');
    const context = error?.context;
    if (context && (typeof context.json === 'function' || typeof context.text === 'function')) {
      try {
        const response = typeof context.clone === 'function' ? context.clone() : context;
        const payload = await response.json();
        const detailed = errorMessage(payload?.error ?? payload?.message ?? payload, '');
        if (detailed) return detailed;
      } catch (_) {
        try {
          const response = typeof context.clone === 'function' ? context.clone() : context;
          const detailed = cleanText(await response.text?.());
          if (detailed) return detailed;
        } catch (_) {}
      }
    }
    return generic || fallback;
  }

  async function invoke(client, payload) {
    if (!client?.functions?.invoke) throw new Error('Secure balance payment is unavailable. Refresh and try again.');
    const { data, error } = await client.functions.invoke(FUNCTION_NAME, { body: { ...(payload || {}) } });
    if (error) throw new Error(await invokeErrorMessage(error));
    if (!data || data.ok === false) throw new Error(errorMessage(data?.error ?? data, 'Balance payment request was not accepted.'));
    return data;
  }

  return Object.freeze({
    FUNCTION_NAME,
    money,
    paidAmount,
    balanceAmount,
    balanceDeadline,
    bookingKey,
    primaryBookingRef,
    bookingMatchesKey,
    normalizeAttempt,
    attemptMatchesBooking,
    latestAttemptForBooking,
    listMyAttempts,
    eligibility,
    buildQuotePayload,
    buildCreatePayload,
    normalizeQuote,
    buildVerificationBookingData,
    buildSubmitPayload,
    statusState,
    safeImageUrl,
    errorMessage,
    invokeErrorMessage,
    invoke,
  });
});
