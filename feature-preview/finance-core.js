(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RevenueReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PAYMENT_LABELS = {
    paid: 'Fully paid',
    downpayment_paid: 'Downpayment received',
    for_verification: 'For verification',
    pending: 'Payment pending',
    rejected: 'Rejected',
    failed: 'Failed',
    unpaid: 'Unpaid',
    deposit_retained: 'Deposit retained',
  };

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function positive(value) {
    return Math.max(0, number(value));
  }

  function valueOf(source, ...keys) {
    for (const key of keys) {
      if (source && source[key] !== undefined && source[key] !== null) return source[key];
    }
    return undefined;
  }

  function normalizeFeeType(value) {
    return ['flat', 'booking', 'per_booking', 'per_transaction'].includes(String(value || '').toLowerCase())
      ? 'flat'
      : 'per_hour';
  }

  function feeConfig(settings = {}) {
    return {
      amount: positive(valueOf(settings, 'maintenance_fee', 'service_fee_rate', 'booking_fee')),
      type: normalizeFeeType(valueOf(settings, 'fee_type', 'feeType')),
    };
  }

  function itemsOf(transaction) {
    return Array.isArray(transaction?.items) && transaction.items.length
      ? transaction.items.filter(Boolean)
      : transaction ? [transaction] : [];
  }

  function directPaidAmount(booking) {
    const total = positive(booking?.total);
    const status = String(valueOf(booking, 'paymentStatus', 'payment_status') || 'unpaid').toLowerCase();
    if (status === 'paid') return total;
    if (status === 'downpayment_paid' || status === 'deposit_retained') {
      return Math.min(total, positive(booking?.downpayment));
    }
    return 0;
  }

  function paidAmount(transaction) {
    const items = itemsOf(transaction);
    return items.length > 1
      ? items.reduce((sum, item) => sum + directPaidAmount(item), 0)
      : directPaidAmount(items[0] || transaction);
  }

  function bookingFeeForItem(item, settings = {}) {
    const snapshot = valueOf(item, 'bookingFeeAmountSnapshot', 'booking_fee_amount_snapshot');
    if (snapshot !== undefined && snapshot !== null && snapshot !== '') return positive(snapshot);
    const config = feeConfig(settings);
    const units = config.type === 'flat'
      ? 1
      : positive(valueOf(item, 'bookingFeeUnitsSnapshot', 'booking_fee_units_snapshot', 'duration')) ||
        (Array.isArray(item?.slots) ? item.slots.length : 0);
    return config.amount * units;
  }

  function bookingFeeCharged(transaction, settings = {}) {
    return itemsOf(transaction).reduce((sum, item) => sum + bookingFeeForItem(item, settings), 0);
  }

  function itemFeeIsEarned(item) {
    if (valueOf(item, 'bookingFeeEarnedAt', 'booking_fee_earned_at')) return true;
    const status = String(item?.status || '').toLowerCase();
    const payment = String(valueOf(item, 'paymentStatus', 'payment_status') || '').toLowerCase();
    return ['confirmed', 'completed', 'forfeited'].includes(status) &&
      ['paid', 'downpayment_paid', 'deposit_retained'].includes(payment);
  }

  function bookingFeeEarned(transaction, settings = {}) {
    return itemsOf(transaction).reduce((sum, item) => (
      sum + (itemFeeIsEarned(item) ? bookingFeeForItem(item, settings) : 0)
    ), 0);
  }

  function dateKey(value) {
    if (!value) return '';
    const raw = String(value);
    const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct) return direct[1];
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function firstItemDate(transaction, keys) {
    return itemsOf(transaction)
      .flatMap(item => keys.map(key => valueOf(item, key)))
      .filter(Boolean)
      .map(dateKey)
      .filter(Boolean)
      .sort()[0] || '';
  }

  function bookingDateForBasis(transaction, basis = 'payment') {
    if (basis === 'service') return dateKey(transaction?.date || firstItemDate(transaction, ['date']));
    if (basis === 'created') return dateKey(valueOf(transaction, 'createdAt', 'created_at')) || firstItemDate(transaction, ['createdAt', 'created_at']);
    const paymentDate = dateKey(valueOf(transaction, 'paidAt', 'paid_at', 'receiptVerifiedAt', 'receipt_verified_at', 'bookingFeeEarnedAt', 'booking_fee_earned_at')) ||
      firstItemDate(transaction, ['paidAt', 'paid_at', 'receiptVerifiedAt', 'receipt_verified_at', 'bookingFeeEarnedAt', 'booking_fee_earned_at']);
    if (paymentDate) return paymentDate;
    return paidAmount(transaction) > 0
      ? dateKey(valueOf(transaction, 'createdAt', 'created_at')) || firstItemDate(transaction, ['createdAt', 'created_at'])
      : '';
  }

  function openPlayDateForBasis(row, basis = 'payment') {
    if (basis === 'service') return dateKey(row?.date);
    if (basis === 'created') return dateKey(valueOf(row, 'createdAt', 'created_at'));
    const status = String(valueOf(row, 'paymentStatus', 'payment_status') || 'pending').toLowerCase();
    if (status !== 'paid') return '';
    return dateKey(valueOf(row, 'receiptVerifiedAt', 'receipt_verified_at', 'createdAt', 'created_at'));
  }

  function inRange(key, range = {}) {
    if (!key) return false;
    return (!range.from || key >= range.from) && (!range.to || key <= range.to);
  }

  function addBreakdown(map, key, charges, collected, extras = {}) {
    const label = String(key || 'Unknown').trim() || 'Unknown';
    const row = map.get(label) || { label, charges: 0, collected: 0, count: 0, hours: 0 };
    row.charges += positive(charges);
    row.collected += positive(collected);
    row.count += positive(extras.count || 0);
    row.hours += positive(extras.hours || 0);
    map.set(label, row);
  }

  function paymentMethodKey(row) {
    return String(valueOf(row, 'paymentMethod', 'payment_method') || 'unrecorded').toLowerCase();
  }

  function receivedAccountKey(row) {
    const explicit = String(valueOf(row, 'receivedAccount', 'received_account') || '').toLowerCase();
    if (explicit) return explicit;
    return paymentMethodKey(row) === 'cash' ? 'cash' : 'gcash';
  }

  function bookingMetrics(transaction, settings = {}) {
    const total = positive(transaction?.total);
    const paid = Math.min(total, paidAmount(transaction));
    const feeCharged = Math.min(total, bookingFeeCharged(transaction, settings));
    const feeEarned = Math.min(paid, bookingFeeEarned(transaction, settings));
    const feeCollected = Math.min(paid, feeCharged);
    const status = String(transaction?.status || '').toLowerCase();
    const forfeited = status === 'forfeited';
    return {
      total: forfeited ? paid : total,
      paid,
      outstanding: forfeited ? 0 : Math.max(0, total - paid),
      courtRental: forfeited ? Math.max(0, paid - feeCollected) : Math.max(0, total - feeCharged),
      courtCollected: Math.max(0, paid - feeCollected),
      feeCharged: forfeited ? feeCollected : feeCharged,
      feeEarned,
      forfeited,
    };
  }

  function trendKey(date, range = {}) {
    if (range.from && range.to) {
      const days = Math.round((new Date(`${range.to}T00:00:00Z`) - new Date(`${range.from}T00:00:00Z`)) / 86400000);
      if (days >= 0 && days <= 45) return date;
    }
    return date.slice(0, 7);
  }

  function sortedRows(map) {
    return [...map.values()].sort((a, b) => b.charges - a.charges || b.collected - a.collected || a.label.localeCompare(b.label));
  }

  function build(options = {}) {
    const transactions = Array.isArray(options.transactions) ? options.transactions : [];
    const openPlay = Array.isArray(options.openPlay) ? options.openPlay : [];
    const settings = options.settings || {};
    const range = options.range || {};
    const basis = ['service', 'created', 'payment'].includes(options.basis) ? options.basis : 'payment';
    const courtMap = new Map();
    const paymentMap = new Map();
    const receivedMap = new Map();
    const trendMap = new Map();
    const rows = [];
    const summary = {
      customerCharges: 0,
      collected: 0,
      outstanding: 0,
      courtRental: 0,
      courtCollected: 0,
      platformFeesCharged: 0,
      platformFeesEarned: 0,
      forfeitedDeposits: 0,
      openPlayCharges: 0,
      openPlayCollected: 0,
      bookingCount: 0,
      bookedHours: 0,
      openPlayCount: 0,
      fullyPaid: 0,
      downpayments: 0,
      verification: 0,
      unpaid: 0,
    };

    transactions.forEach(transaction => {
      const reportDate = bookingDateForBasis(transaction, basis);
      if (!inRange(reportDate, range)) return;
      const metrics = bookingMetrics(transaction, settings);
      const paymentStatus = String(valueOf(transaction, 'paymentStatus', 'payment_status') || 'unpaid').toLowerCase();
      summary.customerCharges += metrics.total;
      summary.collected += metrics.paid;
      summary.outstanding += metrics.outstanding;
      summary.courtRental += metrics.courtRental;
      summary.courtCollected += metrics.courtCollected;
      summary.platformFeesCharged += metrics.feeCharged;
      summary.platformFeesEarned += metrics.feeEarned;
      if (metrics.forfeited) summary.forfeitedDeposits += metrics.paid;
      else {
        summary.bookingCount += 1;
        summary.bookedHours += positive(transaction?.duration);
      }
      if (paymentStatus === 'paid') summary.fullyPaid += metrics.paid;
      else if (paymentStatus === 'downpayment_paid') summary.downpayments += metrics.paid;
      else if (paymentStatus === 'for_verification' || paymentStatus === 'pending') summary.verification += metrics.total;
      else if (!metrics.forfeited && ['unpaid', 'failed', 'rejected'].includes(paymentStatus)) summary.unpaid += metrics.total;

      const children = itemsOf(transaction);
      children.forEach(item => {
        const itemMetrics = bookingMetrics(item, settings);
        addBreakdown(courtMap, valueOf(item, 'courtName', 'court_name') || 'Unknown Court', itemMetrics.courtRental, itemMetrics.courtCollected, {
          count: metrics.forfeited ? 0 : 1,
          hours: metrics.forfeited ? 0 : positive(item?.duration),
        });
      });
      addBreakdown(paymentMap, paymentMethodKey(transaction), metrics.total, metrics.paid, { count: 1 });
      addBreakdown(receivedMap, receivedAccountKey(transaction), metrics.total, metrics.paid, { count: 1 });
      const trend = trendKey(reportDate, range);
      addBreakdown(trendMap, trend, metrics.total, metrics.paid, { count: 1 });
      rows.push({ source: metrics.forfeited ? 'Forfeited booking' : 'Court booking', reportDate, transaction, ...metrics });
    });

    openPlay.forEach(registration => {
      const paymentStatus = String(valueOf(registration, 'paymentStatus', 'payment_status') || 'pending').toLowerCase();
      if (paymentStatus === 'rejected') return;
      const reportDate = openPlayDateForBasis(registration, basis);
      if (!inRange(reportDate, range)) return;
      const amount = positive(registration?.amount);
      const collected = paymentStatus === 'paid' ? amount : 0;
      summary.customerCharges += amount;
      summary.collected += collected;
      summary.outstanding += amount - collected;
      summary.openPlayCharges += amount;
      summary.openPlayCollected += collected;
      summary.openPlayCount += 1;
      if (paymentStatus === 'paid') summary.fullyPaid += collected;
      else if (paymentStatus === 'pending') summary.verification += amount;
      else summary.unpaid += amount;
      const court = valueOf(registration, 'courtName', 'court_name') || 'Open Play';
      addBreakdown(courtMap, court, amount, collected, { count: 1 });
      addBreakdown(paymentMap, paymentMethodKey(registration), amount, collected, { count: 1 });
      addBreakdown(receivedMap, receivedAccountKey(registration), amount, collected, { count: 1 });
      addBreakdown(trendMap, trendKey(reportDate, range), amount, collected, { count: 1 });
      rows.push({ source: 'Open Play', reportDate, registration, total: amount, paid: collected, outstanding: amount - collected, courtRental: amount, courtCollected: collected, feeCharged: 0, feeEarned: 0, forfeited: false });
    });

    const receivables = [
      { label: PAYMENT_LABELS.paid, amount: summary.fullyPaid, tone: 'positive' },
      { label: PAYMENT_LABELS.downpayment_paid, amount: summary.downpayments, tone: 'info' },
      { label: 'Outstanding balance', amount: summary.outstanding, tone: summary.outstanding ? 'warning' : 'neutral' },
      { label: PAYMENT_LABELS.for_verification, amount: summary.verification, tone: summary.verification ? 'warning' : 'neutral' },
      { label: PAYMENT_LABELS.unpaid, amount: summary.unpaid, tone: summary.unpaid ? 'danger' : 'neutral' },
      { label: PAYMENT_LABELS.deposit_retained, amount: summary.forfeitedDeposits, tone: 'info' },
    ];

    return {
      basis,
      range,
      summary,
      rows,
      breakdowns: {
        stream: [
          { label: 'Court rental', charges: summary.courtRental, collected: summary.courtCollected },
          { label: 'Platform booking fees', charges: summary.platformFeesCharged, collected: summary.platformFeesEarned },
          { label: 'Open Play', charges: summary.openPlayCharges, collected: summary.openPlayCollected },
        ],
        court: sortedRows(courtMap),
        payment: sortedRows(paymentMap),
        received: sortedRows(receivedMap),
        receivables,
        trend: [...trendMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
      },
    };
  }

  return {
    build,
    bookingMetrics,
    bookingFeeCharged,
    bookingFeeEarned,
    bookingDateForBasis,
    openPlayDateForBasis,
    paidAmount,
    dateKey,
    feeConfig,
  };
});
