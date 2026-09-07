(function hostBalanceAdminModule(global) {
  'use strict';

  const state = {
    payments: [],
    attempts: [],
    loadedAt: 0,
    loading: null,
    current: null,
    receiptLoaded: false,
    receiptLoadState: 'idle',
    depositReceiptLoaded: false,
    activeReceipt: 'balance',
    reviewable: false,
    busy: false,
    lastFocus: null,
    originalRenderPaymentReview: null,
    loadToken: 0,
    historyToken: 0,
    expectedPaymentId: '',
    loadState: 'idle',
    attemptsLoadState: 'idle',
    generation: 0,
  };
  const byId = id => document.getElementById(id);

  function paymentId(payment) {
    return String(payment?.paymentId || payment?.payment_id || payment?.id || '').trim();
  }

  function normalizedBookingRef(value) {
    return String(value || '').trim().toUpperCase();
  }

  function bookingRefs(booking) {
    const refs = new Set();
    const add = value => {
      const ref = normalizedBookingRef(value);
      if (ref) refs.add(ref);
    };
    if (typeof booking === 'string') add(booking);
    else if (booking) {
      [booking.ref, booking.primaryRef, booking.primary_ref, booking.groupRef,
        booking.group_ref, booking.displayRef, booking.display_ref,
        booking.bookingKey, booking.booking_key].forEach(add);
      for (const collection of [booking.items, booking.allItems, booking.bookingRefs, booking.booking_refs]) {
        if (!Array.isArray(collection)) continue;
        collection.forEach(item => typeof item === 'string' ? add(item) : add(item?.ref));
      }
    }
    return refs;
  }

  function paymentRefs(payment) {
    const refs = new Set();
    const add = value => {
      const ref = normalizedBookingRef(value);
      if (ref) refs.add(ref);
    };
    [payment?.bookingKey, payment?.booking_key, payment?.bookingRef,
      payment?.booking_ref, payment?.bookingGroupRef, payment?.booking_group_ref]
      .forEach(add);
    for (const collection of [payment?.bookingRefs, payment?.booking_refs]) {
      if (Array.isArray(collection)) collection.forEach(add);
    }
    return refs;
  }

  function pendingForBooking(booking) {
    if (state.loadState !== 'ready') return null;
    const candidates = bookingRefs(booking);
    if (!candidates.size) return null;
    return state.payments.find(payment => {
      for (const ref of paymentRefs(payment)) if (candidates.has(ref)) return true;
      return false;
    }) || null;
  }

  function statusForBooking(booking) {
    if (pendingForBooking(booking)) return 'pending';
    return state.loadState === 'ready' ? 'clear' : 'unknown';
  }

  function pendingSummary() {
    if (!canDecide()) return { status: 'forbidden', count: null };
    if (state.loadState !== 'ready') return { status: state.loadState, count: null };
    const ids = new Set(state.payments
      .filter(payment => paymentStatus(payment) === 'pending_review')
      .map(paymentId)
      .filter(Boolean));
    return { status: 'ready', count: ids.size };
  }

  function syncPendingSummary() {
    global.syncPaymentReviewPendingCount?.();
  }

  function matchedAttemptsForBooking(booking) {
    if (state.attemptsLoadState !== 'ready' || !global.HostBalancePayment?.attemptMatchesBooking) return [];
    return state.attempts.filter(attempt => global.HostBalancePayment.attemptMatchesBooking(booking, attempt));
  }

  function bookingRows(booking) {
    if (Array.isArray(booking?.allItems) && booking.allItems.length) return booking.allItems;
    if (Array.isArray(booking?.items) && booking.items.length) return booking.items;
    return booking ? [booking] : [];
  }

  function approvedAttemptMatchesBooking(booking, attempt) {
    const rows = bookingRows(booking);
    if (!booking?.hostBooking || !rows.length || paymentStatus(attempt) !== 'approved') return false;
    if (!attempt?.approvedAt || !attempt?.receiptVerificationId) return false;
    if (String(booking.paymentStatus || '').toLowerCase() !== 'paid') return false;
    if (!rows.every(row => row?.hostBooking && String(row.paymentStatus || '').toLowerCase() === 'paid')) return false;

    const expectedKey = normalizedBookingRef(booking.groupRef || booking.group_ref || booking.primaryRef || booking.ref);
    const attemptKey = normalizedBookingRef(attempt.bookingKey || attempt.booking_key);
    if (!expectedKey || attemptKey !== expectedKey) return false;

    const expectedRefs = new Set(rows.map(row => normalizedBookingRef(row?.ref)).filter(Boolean));
    const attemptRefs = new Set((attempt.bookingRefs || attempt.booking_refs || []).map(normalizedBookingRef).filter(Boolean));
    if (!expectedRefs.size || expectedRefs.size !== attemptRefs.size) return false;
    for (const ref of expectedRefs) if (!attemptRefs.has(ref)) return false;

    const bookingTotal = Number(booking.total);
    const attemptTotal = Number(attempt.totalAmount ?? attempt.total_amount);
    return Number.isFinite(bookingTotal) && Number.isFinite(attemptTotal)
      && Math.abs(bookingTotal - attemptTotal) <= 0.01;
  }

  function approvedForBooking(booking) {
    if (state.attemptsLoadState !== 'ready') return null;
    return matchedAttemptsForBooking(booking).find(attempt => approvedAttemptMatchesBooking(booking, attempt)) || null;
  }

  function paymentEvidenceForBooking(booking) {
    if (state.attemptsLoadState !== 'ready') return { state: 'unknown', attempt: null };
    const attempts = matchedAttemptsForBooking(booking);
    const pending = attempts.find(attempt => paymentStatus(attempt) === 'pending_review');
    if (pending) return { state: 'pending', attempt: pending };
    const approvedCandidates = attempts.filter(attempt => paymentStatus(attempt) === 'approved');
    const approved = approvedForBooking(booking);
    if (approved) return { state: 'approved', attempt: approved };
    const bookingPaymentState = String(booking?.paymentStatus ?? booking?.payment_status ?? '').toLowerCase();
    if (bookingPaymentState === 'paid') {
      return approvedCandidates.length
        ? { state: 'unknown', attempt: null }
        : { state: 'manual', attempt: null };
    }
    const rejected = attempts.find(attempt => paymentStatus(attempt) === 'rejected');
    if (rejected) return { state: 'rejected', attempt: rejected };
    return { state: 'deposit_only', attempt: null };
  }

  async function listPaymentEvidence() {
    if (!global._supabase?.from || !global.HostBalancePayment?.normalizeAttempt) {
      throw new Error('Payment history is unavailable. Refresh and try again.');
    }
    const columns = [
      'id', 'booking_key', 'booking_ref', 'booking_group_ref', 'booking_refs',
      'status', 'total_amount', 'original_paid_amount', 'expected_amount',
      'receipt_verification_id', 'submitted_at', 'reviewed_at', 'approved_at',
      'rejected_at', 'created_at', 'updated_at',
    ].join(',');
    const pageSize = 500;
    const attempts = [];
    let offset = 0;
    for (let page = 0; page < 1000; page += 1) {
      const { data, error } = await global._supabase
        .from('host_booking_balance_payments')
        .select(columns)
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Payment history response is invalid.');
      attempts.push(...data.map(row => ({
        ...global.HostBalancePayment.normalizeAttempt(row),
        receiptVerificationId: row.receipt_verification_id || null,
      })));
      if (data.length < pageSize) return attempts;
      offset += data.length;
      if (page === 999) throw new Error('Payment history is too large to load safely.');
    }
    return attempts;
  }

  function money(value) {
    const amount = Number(value || 0);
    return `₱${Number.isFinite(amount) ? amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}`;
  }

  function when(value) {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-PH', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  }

  function paymentAmount(payment, camelKey, snakeKey) {
    const amount = Number(payment?.[camelKey] ?? payment?.[snakeKey] ?? 0);
    return Number.isFinite(amount) ? Math.max(0, amount) : 0;
  }

  function optionalPaymentAmount(payment, camelKey, snakeKey) {
    const raw = payment?.[camelKey] ?? payment?.[snakeKey];
    if (raw === null || raw === undefined || raw === '') return null;
    const amount = Number(raw);
    return Number.isFinite(amount) ? Math.max(0, amount) : null;
  }

  function paymentValue(payment, camelKey, snakeKey, fallback = '') {
    return String(payment?.[camelKey] ?? payment?.[snakeKey] ?? fallback).trim();
  }

  function paymentStatus(payment) {
    return paymentValue(payment, 'status', 'status', '').toLowerCase();
  }

  function paymentStatusView(payment) {
    const status = paymentStatus(payment);
    if (status === 'pending_review') return {
      key: 'pending', label: 'Balance receipt under review', tab: 'Review needed', metric: 'Submitted', kicker: 'Verify payment 2 of 2', tone: 'review', hasBalanceReceipt: true,
    };
    if (status === 'approved') return {
      key: 'approved', label: 'Fully paid', tab: 'Approved', metric: 'Approved', kicker: 'Two-payment record', tone: 'approved', hasBalanceReceipt: true,
    };
    if (status === 'rejected') return {
      key: 'rejected', label: 'Balance receipt rejected', tab: 'Rejected', metric: 'Rejected', kicker: 'Two-payment record', tone: 'rejected', hasBalanceReceipt: true,
    };
    if (status === 'paid_without_online_balance') return {
      key: 'manual', label: 'Fully paid · no online balance receipt', tab: 'No online receipt', metric: 'Recorded separately', kicker: 'Payment record', tone: 'approved', hasBalanceReceipt: false,
    };
    return {
      key: 'deposit_only', label: 'Balance not submitted', tab: 'Not submitted', metric: 'Not submitted', kicker: 'Payment record', tone: 'history', hasBalanceReceipt: false,
    };
  }

  function reservationStatusView(payment) {
    const status = paymentValue(payment, 'bookingStatus', 'booking_status', '').toLowerCase();
    const payState = paymentValue(payment, 'bookingPaymentStatus', 'booking_payment_status', '').toLowerCase();
    if (status === 'completed') return { label: '✓ Booking completed', tone: 'approved' };
    if (status === 'cancelled') return { label: '× Booking cancelled', tone: 'rejected' };
    if (status === 'forfeited' || payState === 'deposit_retained') {
      return { label: 'Slot released · deposit retained', tone: 'rejected' };
    }
    if (status === 'confirmed') return { label: '✓ Court reserved', tone: '' };
    if (['pending', 'verifying'].includes(status)) return { label: '● Reservation pending', tone: 'review' };
    if (status === 'mixed') return { label: 'Booking group · mixed state', tone: 'history' };
    return { label: 'Booking record', tone: 'history' };
  }

  function actualBookingRef(booking) {
    if (typeof booking === 'string') return booking.trim();
    return String(
      booking?.bookingRef || booking?.booking_ref ||
      booking?.primaryRef || booking?.primary_ref || booking?.items?.[0]?.ref ||
      booking?.allItems?.[0]?.ref || booking?.ref || '',
    ).trim();
  }

  function humanizeFlag(flag) {
    const label = String(flag || '').trim().replace(/_+/g, ' ').toLowerCase();
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Verification warning';
  }

  function secureReceiptUrl(value) {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') throw new Error('Receipt link is not secure.');
    return url.href;
  }

  function depositBookingRefs(payment) {
    const refs = [];
    const add = value => {
      const ref = String(value || '').trim();
      if (ref && !refs.includes(ref)) refs.push(ref);
    };
    add(payment?.bookingRef ?? payment?.booking_ref);
    const collection = payment?.bookingRefs ?? payment?.booking_refs;
    if (Array.isArray(collection)) collection.forEach(add);
    return refs;
  }

  async function loadDepositBooking(payment) {
    const db = global.DB;
    if (!db?.getBookingByRef) throw new Error('Deposit record service is unavailable.');
    const refs = depositBookingRefs(payment);
    if (!refs.length) throw new Error('Deposit booking reference is unavailable.');
    const rows = await Promise.all(refs.map(ref => db.getBookingByRef(ref).catch(() => null)));
    return rows.find(row => row?.receiptImageUrl) || rows.find(Boolean) || null;
  }

  function role() {
    try { return String(global.Auth?.getSession?.()?.role || '').toLowerCase(); }
    catch (_) { return ''; }
  }

  function canDecide() {
    return ['owner', 'court_owner'].includes(role());
  }

  function providerLabel(value) {
    const key = String(value || '').toLowerCase();
    return ({
      gcash: 'GCash', bdopay: 'BDO Pay', maya: 'Maya', bpi: 'BPI',
      gotyme: 'GoTyme → GCash', maribank: 'MariBank → GCash', pnb: 'PNB', cash: 'Cash',
    })[key] || value || '—';
  }

  function paymentMethodBrandNode(value, modifier = 'pm-brand-mark--inline') {
    const method = String(value || '').trim().toLowerCase();
    const node = make('span', 'hba-method-label');
    const label = providerLabel(method || value);
    try {
      const brands = global.PaymentMethodBrand;
      if (method && typeof brands?.iconSrc === 'function' && brands.iconSrc(method)
        && typeof brands.renderLabel === 'function') {
        brands.renderLabel(node, method, label, modifier);
        return node;
      }
    } catch (_) {}
    node.textContent = String(label || '—');
    return node;
  }

  function renderPaymentMethodReference(container, method, reference) {
    if (!container) return;
    container.replaceChildren(paymentMethodBrandNode(method));
    const cleanReference = String(reference || '').trim();
    if (cleanReference) container.append(document.createTextNode(` · ${cleanReference}`));
  }

  function notify(message, kind) {
    if (typeof global.toast === 'function') global.toast(message, kind);
  }

  function supabaseClient() {
    if (global._supabase?.functions?.invoke) return global._supabase;
    try { if (typeof _sb !== 'undefined' && _sb?.functions?.invoke) return _sb; }
    catch (_) {}
    return null;
  }

  function apiCall(action, payload = {}) {
    const api = global.HostBalancePayment;
    if (!api?.invoke) throw new Error('Host balance payment service is unavailable. Refresh this page.');
    return api.invoke(supabaseClient(), { action, ...payload });
  }

  function addStyles() {
    if (byId('hostBalanceAdminStyles')) return;
    const style = document.createElement('style');
    style.id = 'hostBalanceAdminStyles';
    style.textContent = `
      .hba-panel{margin-bottom:14px;overflow:hidden;border-color:rgba(201,207,67,.18)}
      .hba-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:17px 19px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,rgba(201,207,67,.055),transparent 70%)}
      .hba-head h3{margin:0;font-size:1rem;color:var(--text)}
      .hba-kicker{margin-bottom:4px;color:var(--pickle-lime);font-size:.61rem;font-weight:900;letter-spacing:.09em;text-transform:uppercase}
      .hba-sub{color:var(--muted);font-size:.75rem;line-height:1.45}
      .hba-list{display:grid;gap:10px;padding:14px}
      .hba-card{border:1px solid var(--border);border-radius:13px;padding:14px;background:linear-gradient(145deg,var(--input),rgba(201,207,67,.025))}
      .hba-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .hba-name{font-weight:850;color:var(--text)}
      .hba-ref{margin-top:3px;color:var(--muted);font-size:.72rem;overflow-wrap:anywhere}
      .hba-amount{font-weight:950;color:var(--pickle-lime);font-size:1rem;white-space:nowrap}
      .hba-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin-top:12px;font-size:.76rem;color:var(--text2)}
      .hba-meta b,.hba-summary b{display:block;margin-bottom:2px;color:var(--muted);font-size:.62rem;text-transform:uppercase;letter-spacing:.07em}
      .hba-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:13px;padding-top:11px;border-top:1px solid var(--border)}
      .hba-status{font-size:.71rem;font-weight:850;color:var(--yellow)}
      .hba-booking-pending{display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:4px 8px;border:1px solid rgba(255,193,7,.3);border-radius:999px;background:rgba(255,193,7,.1);color:var(--yellow);font-size:.68rem;font-weight:900;line-height:1.2}
      .hba-empty{padding:24px;text-align:center;color:var(--muted);font-size:.82rem;line-height:1.5}
      .hba-overlay{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(2,8,5,.88);backdrop-filter:blur(12px)}
      .hba-overlay[hidden]{display:none}
      .hba-modal{width:min(960px,100%);max-height:min(94dvh,920px);overflow:auto;border:1px solid rgba(201,207,67,.28);border-radius:22px;background:linear-gradient(165deg,var(--surface),#071008 72%);box-shadow:0 32px 110px rgba(0,0,0,.68)}
      .hba-modal-head{position:sticky;top:0;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border);background:rgba(7,16,8,.96);backdrop-filter:blur(16px)}
      .hba-modal-head h3{margin:2px 0 0;font-size:1.05rem;letter-spacing:.015em}
      .hba-modal-kicker{color:var(--pickle-lime);font-size:.61rem;font-weight:950;letter-spacing:.1em;text-transform:uppercase}
      .hba-close{width:40px;height:40px;border:1px solid var(--border);border-radius:11px;background:var(--input);color:var(--text);font-size:1.2rem;cursor:pointer}
      .hba-modal-body{padding:18px 20px 20px}
      .hba-state-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
      .hba-state-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border:1px solid rgba(201,207,67,.26);border-radius:999px;background:rgba(201,207,67,.08);color:var(--pickle-lime);font-size:.65rem;font-weight:900;letter-spacing:.035em}
      .hba-state-chip.review{border-color:rgba(255,193,7,.3);background:rgba(255,193,7,.09);color:var(--yellow)}
      .hba-state-chip.approved{border-color:rgba(105,220,145,.32);background:rgba(105,220,145,.1);color:#8befac}
      .hba-state-chip.rejected{border-color:rgba(255,92,92,.34);background:rgba(255,92,92,.1);color:#ff8585}
      .hba-state-chip.history{border-color:var(--border);background:var(--input);color:var(--text2)}
      .hba-money-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-bottom:10px}
      .hba-money-strip>div{padding:12px 13px;border:1px solid var(--border);border-radius:12px;background:linear-gradient(145deg,var(--input),rgba(201,207,67,.035))}
      .hba-money-strip b{display:block;margin-bottom:5px;color:var(--muted);font-size:.6rem;text-transform:uppercase;letter-spacing:.075em}
      .hba-money-strip strong{display:block;color:var(--text);font-size:1rem;line-height:1.1}
      .hba-money-strip .accepted strong{color:var(--pickle-lime)}
      .hba-money-strip .review strong{color:var(--yellow)}
      .hba-money-strip .approved strong{color:#8befac}
      .hba-money-strip .rejected strong{color:#ff8585}
      .hba-money-strip .history strong{color:var(--muted)}
      .hba-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:12px}
      .hba-summary>div{padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.018);font-size:.73rem;overflow-wrap:anywhere}
      .hba-explainer{margin:0 0 14px;padding:11px 12px;border:1px solid rgba(201,207,67,.22);border-radius:11px;background:rgba(201,207,67,.07);color:var(--text2);font-size:.75rem;line-height:1.5}
      .hba-explainer strong{color:var(--pickle-lime)}
      .hba-workspace{display:grid;grid-template-columns:255px minmax(0,1fr);gap:12px;align-items:start}
      .hba-payment-tabs{display:grid;gap:9px}
      .hba-payment-tab{width:100%;padding:13px;text-align:left;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.018);color:var(--text);cursor:pointer;transition:border-color .18s ease,background .18s ease,transform .18s ease}
      .hba-payment-tab:hover{border-color:rgba(201,207,67,.35);transform:translateY(-1px)}
      .hba-payment-tab[aria-selected="true"]{border-color:rgba(201,207,67,.52);background:linear-gradient(145deg,rgba(201,207,67,.14),rgba(201,207,67,.035));box-shadow:0 0 0 1px rgba(201,207,67,.05),0 10px 28px rgba(0,0,0,.2)}
      .hba-tab-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}
      .hba-tab-step{color:var(--muted);font-size:.58rem;font-weight:950;letter-spacing:.085em;text-transform:uppercase}
      .hba-tab-status{padding:3px 7px;border-radius:999px;background:rgba(201,207,67,.13);color:var(--pickle-lime);font-size:.57rem;font-weight:950;text-transform:uppercase}
      .hba-tab-status.review{background:rgba(255,193,7,.12);color:var(--yellow)}
      .hba-tab-status.approved{background:rgba(105,220,145,.12);color:#8befac}
      .hba-tab-status.rejected{background:rgba(255,92,92,.12);color:#ff8585}
      .hba-tab-status.history{background:var(--input);color:var(--muted)}
      .hba-payment-tab strong{display:block;font-size:.79rem;line-height:1.3}
      .hba-tab-amount{display:block;margin-top:7px;font-size:1.02rem;font-weight:950}
      .hba-tab-meta{display:block;margin-top:5px;color:var(--muted);font-size:.65rem;line-height:1.35;overflow-wrap:anywhere}
      .hba-method-label{display:inline-flex;align-items:center;vertical-align:middle}
      .hba-receipt-stage{min-width:0;border:1px solid var(--border);border-radius:15px;background:rgba(2,8,5,.48);overflow:hidden}
      .hba-proof-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.018)}
      .hba-proof-head b{display:block;color:var(--text);font-size:.77rem}
      .hba-proof-head span{display:block;margin-top:3px;color:var(--muted);font-size:.65rem}
      .hba-proof-link{display:none;flex-shrink:0;color:var(--pickle-lime);font-size:.65rem;font-weight:850;text-decoration:none}
      .hba-proof-link:hover{text-decoration:underline}
      .hba-proof{min-height:330px;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 25%,rgba(201,207,67,.045),transparent 45%),#030805;overflow:hidden}
      .hba-proof img{display:none;width:auto;max-width:100%;max-height:470px;object-fit:contain}
      .hba-proof-status{padding:20px;color:var(--muted);font-size:.8rem;text-align:center}
      .hba-proof-note{padding:11px 13px;border-top:1px solid var(--border);color:var(--text2);font-size:.69rem;line-height:1.45}
      .hba-proof-note strong{color:var(--pickle-lime)}
      .hba-flags{padding:11px 13px;border-top:1px solid var(--border);color:var(--muted);font-size:.69rem;line-height:1.45;overflow-wrap:anywhere}
      .hba-flag-title{display:block;margin-bottom:7px;color:var(--yellow);font-weight:850}
      .hba-flag-list{display:flex;gap:5px;flex-wrap:wrap}
      .hba-flag{padding:3px 7px;border:1px solid rgba(255,193,7,.22);border-radius:999px;background:rgba(255,193,7,.075);color:var(--text2);font-size:.6rem;font-weight:750}
      .hba-outcome{padding:11px 13px;border-top:1px solid var(--border);color:var(--text2);font-size:.69rem;line-height:1.48}
      .hba-outcome strong{display:block;margin-bottom:3px;color:var(--pickle-lime)}
      .hba-outcome.rejected strong{color:#ff8585}
      .hba-reason{width:100%;min-height:68px;margin-top:14px;padding:10px 11px;border:1px solid var(--border);border-radius:11px;background:var(--input);color:var(--text);resize:vertical}
      .hba-decision-hint{margin-top:8px;color:var(--muted);font-size:.68rem;line-height:1.4}
      .hba-modal-actions{display:grid;grid-template-columns:1fr 1.45fr;gap:10px;margin-top:12px}
      .hba-modal-actions[hidden],.hba-reason[hidden]{display:none}
      .hba-modal-actions button{min-height:44px;justify-content:center}
      @media(max-width:760px){
        .hba-modal{width:min(620px,100%)}
        .hba-workspace{grid-template-columns:1fr}
        .hba-payment-tabs{grid-template-columns:repeat(2,minmax(0,1fr))}
        .hba-proof{min-height:280px}
        .hba-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
      }
      @media(max-width:560px){
        .hba-head,.hba-card-top,.hba-bottom{align-items:stretch;flex-direction:column}
        .hba-meta,.hba-modal-actions{grid-template-columns:1fr}
        .hba-overlay{align-items:flex-end;padding:0}
        .hba-modal{width:100%;max-height:94dvh;border-radius:20px 20px 0 0;padding-bottom:env(safe-area-inset-bottom)}
        .hba-modal-head{padding:14px 16px}
        .hba-modal-body{padding:14px 14px 18px}
        .hba-money-strip{grid-template-columns:1fr 1fr}
        .hba-money-strip>div:first-child{grid-column:1/-1}
        .hba-payment-tab{padding:10px}
        .hba-tab-top{align-items:flex-start;flex-direction:column;gap:5px}
        .hba-tab-amount{font-size:.88rem}
        .hba-tab-meta{display:none}
        .hba-proof-head{padding:10px 11px}
        .hba-proof{min-height:250px}
      }
    `;
    document.head.appendChild(style);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function appendSummary(container, label, value) {
    const cell = make('div');
    cell.append(make('b', '', label), document.createTextNode(String(value || '—')));
    container.appendChild(cell);
  }

  function appendPaymentMethodSummary(container, label, method) {
    const cell = make('div');
    cell.append(make('b', '', label), paymentMethodBrandNode(method));
    container.appendChild(cell);
  }

  function appendMetric(container, label, value, tone) {
    const cell = make('div', tone || '');
    cell.append(make('b', '', label), make('strong', '', value));
    container.appendChild(cell);
  }

  function renderVerificationFlags(flags) {
    const container = byId('hostBalanceReviewFlags');
    if (!container) return;
    container.replaceChildren();
    const values = Array.isArray(flags) ? [...new Set(flags.map(String).filter(Boolean))] : [];
    if (!values.length) {
      container.append(make('strong', 'hba-flag-title', 'No automatic warnings detected.'));
      return;
    }
    container.append(make('strong', 'hba-flag-title', 'Manual verification required'));
    const list = make('div', 'hba-flag-list');
    values.forEach(flag => list.append(make('span', 'hba-flag', humanizeFlag(flag))));
    container.append(list);
  }

  function renderReviewOutcome(payment, view) {
    const container = byId('hostBalanceReviewOutcome');
    if (!container) return;
    container.replaceChildren();
    container.className = `hba-outcome${view.key === 'rejected' ? ' rejected' : ''}`;
    if (view.key === 'pending') {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    if (view.key === 'deposit_only') {
      container.append(
        make('strong', '', 'No separate balance transaction'),
        document.createTextNode('This host booking has no submitted online Payment 2 receipt.'),
      );
      return;
    }
    if (view.key === 'manual') {
      container.append(
        make('strong', '', 'No online Payment 2 receipt'),
        document.createTextNode('The booking is recorded as fully paid, but the remaining payment was recorded outside this online receipt flow.'),
      );
      return;
    }
    const reviewedAt = payment.approvedAt || payment.approved_at || payment.rejectedAt ||
      payment.rejected_at || payment.reviewedAt || payment.reviewed_at;
    const reviewer = paymentValue(payment, 'reviewedByRole', 'reviewed_by_role', '')
      .replace(/_/g, ' ');
    const reason = paymentValue(payment, 'reviewReason', 'review_reason', '');
    const reviewFacts = [
      reviewedAt ? when(reviewedAt) : 'Review time unavailable',
      reviewer ? `Reviewed by ${reviewer}.` : 'Reviewer unavailable.',
      reason ? `Reason: ${reason}` : '',
    ].filter(Boolean).join(' · ');
    container.append(
      make('strong', '', view.key === 'approved' ? 'Payment 2 approved' : 'Payment 2 rejected'),
      document.createTextNode(reviewFacts),
    );
  }

  function selectPaymentReceipt(kind) {
    const next = kind === 'deposit' ? 'deposit' : 'balance';
    state.activeReceipt = next;
    for (const value of ['deposit', 'balance']) {
      const selected = value === next;
      const tab = byId(value === 'deposit' ? 'hostDepositTab' : 'hostBalanceTab');
      const panel = byId(value === 'deposit' ? 'hostDepositPanel' : 'hostBalancePanel');
      if (tab) {
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
      }
      if (panel) panel.hidden = !selected;
    }
    syncActions();
  }

  function ensurePanel() {
    const section = byId('sec-payreview');
    if (!section) return null;
    let panel = byId('hostBalanceAdminPanel');
    if (panel) return panel;
    addStyles();
    panel = make('section', 'pr-panel hba-panel');
    panel.id = 'hostBalanceAdminPanel';
    panel.setAttribute('aria-labelledby', 'hostBalanceAdminTitle');
    const head = make('div', 'hba-head');
    const heading = make('div');
    heading.append(make('div', 'hba-kicker', 'Host court balances'));
    const title = make('h3', '', 'Balance Payment Review');
    title.id = 'hostBalanceAdminTitle';
    heading.append(title, make('div', 'hba-sub', 'Review the accepted deposit and new balance receipt as one protected payment history.'));
    const refresh = make('button', 'btn btn-g btn-sm', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => render(true));
    head.append(heading, refresh);
    const list = make('div', 'hba-list');
    list.id = 'hostBalanceAdminList';
    list.setAttribute('aria-live', 'polite');
    list.appendChild(make('div', 'hba-empty', 'Loading host balance payments…'));
    panel.append(head, list);
    const firstPanel = section.querySelector('.pr-panel');
    if (firstPanel) section.insertBefore(panel, firstPanel);
    else section.appendChild(panel);
    return panel;
  }

  function syncActions() {
    const reason = String(byId('hostBalanceReviewReason')?.value || '').trim();
    const reviewingBalance = state.activeReceipt === 'balance';
    const locked = state.busy || !state.reviewable || !canDecide() || !state.receiptLoaded || !reviewingBalance;
    const approve = byId('hostBalanceApproveBtn');
    const reject = byId('hostBalanceRejectBtn');
    if (approve) {
      approve.disabled = locked;
      if (state.reviewable && !state.busy) {
        const amount = optionalPaymentAmount(state.current, 'balanceAmount', 'expected_amount');
        approve.textContent = state.receiptLoadState === 'loading'
          ? 'Loading Payment 2 receipt…'
          : state.receiptLoadState === 'error'
            ? 'Receipt unavailable — reopen to retry'
            : `Confirm ${money(amount || 0)} Received`;
      }
    }
    if (reject) reject.disabled = locked || reason.length < 3;
    const reasonField = byId('hostBalanceReviewReason');
    const actions = byId('hostBalanceActions');
    if (reasonField) reasonField.hidden = !reviewingBalance || !state.reviewable;
    if (actions) actions.hidden = !reviewingBalance || !state.reviewable;
    const hint = byId('hostBalanceDecisionHint');
    if (hint) {
      const view = paymentStatusView(state.current);
      hint.textContent = !reviewingBalance
        ? (state.reviewable
          ? 'Payment 1 is read-only. Select Payment 2 to confirm receipt or mark it not received.'
          : 'Payment 1 is accepted and preserved as read-only payment evidence.')
        : state.reviewable
          ? state.receiptLoadState === 'loading'
            ? 'Loading the secure Payment 2 receipt. Approval unlocks after the image is visible.'
            : state.receiptLoadState === 'error'
              ? 'The Payment 2 receipt could not be loaded. Close and reopen this review to retry.'
              : 'This decision applies only to Payment 2 — the remaining balance.'
          : view.key === 'approved'
            ? 'Read-only history. Payment 2 was approved and the booking is fully paid.'
            : view.key === 'rejected'
              ? 'Read-only history. Payment 2 was rejected; its reason and evidence remain recorded.'
              : 'No separate online balance transaction was recorded for this booking.';
    }
  }

  function ensureModal() {
    let overlay = byId('hostBalanceReviewModal');
    if (overlay) return overlay;
    overlay = make('div', 'hba-overlay');
    overlay.id = 'hostBalanceReviewModal';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'hostBalanceReviewTitle');
    const modal = make('div', 'hba-modal');
    const head = make('div', 'hba-modal-head');
    const titleBox = make('div');
    const kicker = make('div', 'hba-modal-kicker', 'Verify payment 2 of 2');
    kicker.id = 'hostBalanceModalKicker';
    const title = make('h3', '', 'Booking Payment History');
    title.id = 'hostBalanceReviewTitle';
    titleBox.append(kicker, title);
    const close = make('button', 'hba-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close host balance review');
    close.addEventListener('click', closeModal);
    head.append(titleBox, close);
    const body = make('div', 'hba-modal-body');
    const stateRow = make('div', 'hba-state-row');
    const reservationChip = make('span', 'hba-state-chip', '✓ Court reserved');
    reservationChip.id = 'hostBalanceReservationChip';
    const paymentChip = make('span', 'hba-state-chip review', '● Balance receipt under review');
    paymentChip.id = 'hostBalancePaymentChip';
    stateRow.append(reservationChip, paymentChip);
    const moneyStrip = make('div', 'hba-money-strip');
    moneyStrip.id = 'hostBalanceMoneyStrip';
    const summary = make('div', 'hba-summary');
    summary.id = 'hostBalanceReviewSummary';
    const explainer = make('div', 'hba-explainer');
    explainer.innerHTML = '<strong>Two separate payments, one protected history.</strong> Payment 1 secured the court and stays read-only. Only Payment 2 can be approved or rejected here.';

    const workspace = make('div', 'hba-workspace');
    const tabs = make('div', 'hba-payment-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Booking payments');
    const buildPaymentTab = (id, panelId, step, titleText, statusText, statusClass) => {
      const tab = make('button', 'hba-payment-tab');
      tab.id = id;
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panelId);
      const top = make('span', 'hba-tab-top');
      top.append(make('span', 'hba-tab-step', step), make('span', `hba-tab-status${statusClass ? ` ${statusClass}` : ''}`, statusText));
      tab.append(top, make('strong', '', titleText), make('span', 'hba-tab-amount', '₱0.00'), make('span', 'hba-tab-meta', 'Loading payment record…'));
      return tab;
    };
    const depositTab = buildPaymentTab('hostDepositTab', 'hostDepositPanel', 'Payment 1 of 2', 'Reservation deposit', 'Accepted', '');
    depositTab.addEventListener('click', () => selectPaymentReceipt('deposit'));
    const balanceTab = buildPaymentTab('hostBalanceTab', 'hostBalancePanel', 'Payment 2 of 2', 'Remaining balance', 'Review needed', 'review');
    balanceTab.addEventListener('click', () => selectPaymentReceipt('balance'));
    depositTab.addEventListener('keydown', event => {
      if (!['ArrowRight', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      selectPaymentReceipt('balance');
      balanceTab.focus();
    });
    balanceTab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      selectPaymentReceipt('deposit');
      depositTab.focus();
    });
    tabs.append(depositTab, balanceTab);

    const stage = make('div', 'hba-receipt-stage');
    const buildProofHead = (label, linkId, linkLabel) => {
      const proofHead = make('div', 'hba-proof-head');
      const copy = make('div');
      copy.append(make('b', '', label), make('span', '', 'Private receipt preview · link expires shortly'));
      const link = make('a', 'hba-proof-link', linkLabel);
      link.id = linkId;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      proofHead.append(copy, link);
      return proofHead;
    };

    const depositPanel = make('section', 'hba-receipt-panel');
    depositPanel.id = 'hostDepositPanel';
    depositPanel.setAttribute('role', 'tabpanel');
    depositPanel.setAttribute('aria-labelledby', 'hostDepositTab');
    depositPanel.hidden = true;
    const depositProof = make('div', 'hba-proof');
    const depositProofStatus = make('div', 'hba-proof-status', 'Loading deposit receipt…');
    depositProofStatus.id = 'hostDepositProofStatus';
    const depositImage = document.createElement('img');
    depositImage.id = 'hostDepositProofImage';
    depositImage.alt = 'Payment 1 reservation deposit receipt';
    depositImage.referrerPolicy = 'no-referrer';
    depositProof.append(depositProofStatus, depositImage);
    const depositNote = make('div', 'hba-proof-note');
    depositNote.id = 'hostDepositProofNote';
    depositNote.innerHTML = '<strong>Accepted deposit.</strong> This first payment is preserved as read-only financial evidence.';
    depositPanel.append(buildProofHead('Payment 1 — Reservation deposit', 'hostDepositProofLink', 'Open full receipt ↗'), depositProof, depositNote);

    const balancePanel = make('section', 'hba-receipt-panel');
    balancePanel.id = 'hostBalancePanel';
    balancePanel.setAttribute('role', 'tabpanel');
    balancePanel.setAttribute('aria-labelledby', 'hostBalanceTab');
    const balanceProof = make('div', 'hba-proof');
    const proofStatus = make('div', 'hba-proof-status', 'Loading balance receipt…');
    proofStatus.id = 'hostBalanceProofStatus';
    const image = document.createElement('img');
    image.id = 'hostBalanceProofImage';
    image.alt = 'Payment 2 remaining balance receipt';
    image.referrerPolicy = 'no-referrer';
    balanceProof.append(proofStatus, image);
    const flags = make('div', 'hba-flags');
    flags.id = 'hostBalanceReviewFlags';
    const outcome = make('div', 'hba-outcome');
    outcome.id = 'hostBalanceReviewOutcome';
    balancePanel.append(buildProofHead('Payment 2 — Remaining balance', 'hostBalanceProofLink', 'Open full receipt ↗'), balanceProof, flags, outcome);
    stage.append(depositPanel, balancePanel);
    workspace.append(tabs, stage);

    const reason = document.createElement('textarea');
    reason.id = 'hostBalanceReviewReason';
    reason.className = 'hba-reason';
    reason.placeholder = 'Reason for marking Payment 2 not received (at least 3 characters)';
    reason.setAttribute('aria-label', 'Balance payment review reason');
    reason.addEventListener('input', syncActions);
    const decisionHint = make('div', 'hba-decision-hint', 'This decision applies only to Payment 2 — the remaining balance.');
    decisionHint.id = 'hostBalanceDecisionHint';
    const actions = make('div', 'hba-modal-actions');
    actions.id = 'hostBalanceActions';
    const reject = make('button', 'btn btn-d', 'Not Received');
    reject.id = 'hostBalanceRejectBtn';
    reject.type = 'button';
    reject.addEventListener('click', () => decide('reject'));
    const approve = make('button', 'btn btn-p', 'Confirm Received');
    approve.id = 'hostBalanceApproveBtn';
    approve.type = 'button';
    approve.addEventListener('click', () => decide('approve'));
    actions.append(reject, approve);
    body.append(stateRow, moneyStrip, summary, explainer, workspace, reason, decisionHint, actions);
    modal.append(head, body);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) closeModal(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !overlay.hidden) closeModal();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function prepareReceiptImage({
    imageId, statusId, linkId, alt, loadingText, failureText,
    loadToken, expectedId, onLoad, onError,
  }) {
    const current = () => loadToken === state.loadToken && expectedId === state.expectedPaymentId;
    const oldImage = byId(imageId);
    const image = document.createElement('img');
    image.id = imageId;
    image.alt = alt;
    image.referrerPolicy = 'no-referrer';
    image.style.display = 'none';
    const status = byId(statusId);
    const link = byId(linkId);
    if (status) {
      status.style.display = '';
      status.textContent = loadingText;
    }
    if (link) {
      link.style.display = 'none';
      link.removeAttribute('href');
    }
    image.addEventListener('load', () => {
      if (!current()) return;
      image.style.display = 'block';
      if (status) status.style.display = 'none';
      if (link) link.style.display = 'inline-flex';
      onLoad?.();
    });
    image.addEventListener('error', () => {
      if (!current()) return;
      image.removeAttribute('src');
      image.style.display = 'none';
      if (link) {
        link.style.display = 'none';
        link.removeAttribute('href');
      }
      if (status) {
        status.style.display = '';
        status.textContent = failureText;
      }
      onError?.();
    });
    oldImage?.replaceWith(image);
    return {
      show(rawUrl) {
        if (!current()) return;
        const url = secureReceiptUrl(rawUrl);
        if (link) link.href = url;
        image.src = url;
      },
      fail(error) {
        if (!current()) return;
        image.removeAttribute('src');
        image.style.display = 'none';
        if (link) {
          link.style.display = 'none';
          link.removeAttribute('href');
        }
        if (status) {
          status.style.display = '';
          status.textContent = error?.message || String(error || failureText);
        }
        onError?.();
      },
    };
  }

  async function openModal(payment, trigger) {
    if (state.busy) return;
    const expectedId = paymentId(payment);
    const loadToken = ++state.loadToken;
    const view = paymentStatusView(payment);
    state.current = payment;
    state.expectedPaymentId = expectedId;
    state.receiptLoaded = false;
    state.receiptLoadState = 'loading';
    state.depositReceiptLoaded = false;
    state.activeReceipt = view.hasBalanceReceipt ? 'balance' : 'deposit';
    state.reviewable = view.key === 'pending';
    state.lastFocus = trigger || document.activeElement;
    const overlay = ensureModal();
    const totalAmount = paymentAmount(payment, 'totalAmount', 'total_amount');
    const depositAmount = optionalPaymentAmount(payment, 'originalPaidAmount', 'original_paid_amount');
    const balanceAmount = optionalPaymentAmount(payment, 'balanceAmount', 'expected_amount');
    const providerMethod = paymentValue(payment, 'paymentProvider', 'payment_provider', '—');
    const balanceReference = paymentValue(payment, 'paymentReference', 'payment_reference', '—');
    const bookingReference = paymentValue(payment, 'bookingGroupRef', 'booking_group_ref')
      || paymentValue(payment, 'bookingRef', 'booking_ref')
      || paymentValue(payment, 'bookingKey', 'booking_key', '—');

    byId('hostBalanceModalKicker').textContent = view.kicker;
    const reservation = reservationStatusView(payment);
    const reservationChip = byId('hostBalanceReservationChip');
    reservationChip.className = `hba-state-chip ${reservation.tone}`.trim();
    reservationChip.textContent = reservation.label;
    const paymentChip = byId('hostBalancePaymentChip');
    paymentChip.className = `hba-state-chip ${view.tone}`;
    paymentChip.textContent = `${['approved', 'manual'].includes(view.key) ? '✓' : view.key === 'rejected' ? '×' : '●'} ${view.label}`;
    const explainer = byId('hostBalanceReviewModal').querySelector('.hba-explainer');
    if (view.key === 'pending') {
      explainer.innerHTML = '<strong>Two separate payments, one protected history.</strong> Payment 1 secured the court and stays read-only. For Payment 2, confirm funds received or mark them not received.';
    } else if (view.key === 'approved') {
      explainer.innerHTML = '<strong>Two accepted payments, one complete history.</strong> Payment 1 secured the court and Payment 2 settled the remaining balance. This record is read-only.';
    } else if (view.key === 'rejected') {
      explainer.innerHTML = '<strong>Two separate payment records.</strong> Payment 1 remains accepted. Payment 2 was rejected and is preserved with its review result.';
    } else if (view.key === 'manual') {
      explainer.innerHTML = '<strong>Accepted receipt plus an offline payment record.</strong> Payment 1 keeps the original deposit evidence. The booking is fully paid, but no separate online Payment 2 receipt exists.';
    } else {
      explainer.innerHTML = '<strong>One recorded payment.</strong> Payment 1 contains the accepted payment evidence. No separate online balance payment was submitted.';
    }

    const moneyStrip = byId('hostBalanceMoneyStrip');
    moneyStrip.replaceChildren();
    appendMetric(moneyStrip, 'Total booking', money(totalAmount), '');
    appendMetric(moneyStrip, 'Payment 1 · Accepted', depositAmount == null ? 'Amount unavailable' : money(depositAmount), 'accepted');
    appendMetric(
      moneyStrip,
      `Payment 2 · ${view.metric}`,
      view.key === 'manual' ? 'No online receipt' : balanceAmount == null ? 'Amount unavailable' : money(balanceAmount),
      view.tone,
    );
    const summary = byId('hostBalanceReviewSummary');
    summary.replaceChildren();
    appendSummary(summary, 'Host', payment.customerName || payment.customer_name);
    appendSummary(summary, 'Booking', bookingReference);
    appendSummary(summary, 'Schedule', payment.scheduleLabel || payment.schedule_label || payment.bookingDate || payment.booking_date);
    const reviewedAt = payment.reviewedAt || payment.reviewed_at;
    const submittedAt = payment.submittedAt || payment.submitted_at || payment.createdAt || payment.created_at;
    appendSummary(summary, reviewedAt ? 'Reviewed' : view.key === 'pending' ? 'Submitted' : 'Recorded', when(reviewedAt || submittedAt));
    const flags = payment.receiptFlags || payment.receipt_flags || [];
    renderVerificationFlags(flags);
    byId('hostBalanceReviewFlags').hidden = !view.hasBalanceReceipt;
    renderReviewOutcome(payment, view);
    byId('hostBalanceReviewReason').value = '';
    byId('hostDepositTab').querySelector('.hba-tab-amount').textContent = depositAmount == null ? 'Amount unavailable' : money(depositAmount);
    byId('hostDepositTab').querySelector('.hba-tab-meta').textContent = 'Loading accepted deposit…';
    byId('hostBalanceTab').querySelector('.hba-tab-amount').textContent = view.key === 'manual'
      ? 'No online receipt'
      : balanceAmount == null ? 'Amount unavailable' : money(balanceAmount);
    const balanceTabMeta = byId('hostBalanceTab').querySelector('.hba-tab-meta');
    if (view.hasBalanceReceipt) renderPaymentMethodReference(balanceTabMeta, providerMethod, balanceReference);
    else balanceTabMeta.textContent = view.key === 'manual'
      ? 'Recorded outside the online receipt flow'
      : 'No balance payment submitted';
    const balanceTabStatus = byId('hostBalanceTab').querySelector('.hba-tab-status');
    balanceTabStatus.className = `hba-tab-status ${view.tone}`;
    balanceTabStatus.textContent = view.tab;
    const depositNote = byId('hostDepositProofNote');
    depositNote.replaceChildren(
      make('strong', '', 'Accepted deposit. '),
      document.createTextNode('This first payment is preserved as read-only financial evidence.'),
    );
    const reject = byId('hostBalanceRejectBtn');
    const approve = byId('hostBalanceApproveBtn');
    if (reject) reject.textContent = 'Not Received';
    if (approve) approve.textContent = `Confirm ${money(balanceAmount || 0)} Received`;

    const balanceProof = prepareReceiptImage({
      imageId: 'hostBalanceProofImage',
      statusId: 'hostBalanceProofStatus',
      linkId: 'hostBalanceProofLink',
      alt: 'Payment 2 remaining balance receipt',
      loadingText: view.hasBalanceReceipt ? 'Loading Payment 2 receipt…' : 'No separate Payment 2 receipt.',
      failureText: state.reviewable
        ? 'Payment 2 receipt could not be loaded. Approval remains disabled.'
        : 'Payment 2 receipt could not be loaded.',
      loadToken,
      expectedId,
      onLoad() {
        state.receiptLoaded = true;
        state.receiptLoadState = 'ready';
        syncActions();
      },
      onError() {
        state.receiptLoaded = false;
        state.receiptLoadState = 'error';
        syncActions();
      },
    });
    const depositProof = prepareReceiptImage({
      imageId: 'hostDepositProofImage',
      statusId: 'hostDepositProofStatus',
      linkId: 'hostDepositProofLink',
      alt: 'Payment 1 reservation deposit receipt',
      loadingText: 'Loading Payment 1 deposit receipt…',
      failureText: 'Deposit accepted, but its receipt image is unavailable.',
      loadToken,
      expectedId,
      onLoad() { state.depositReceiptLoaded = true; },
      onError() { state.depositReceiptLoaded = false; },
    });
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    selectPaymentReceipt(view.hasBalanceReceipt ? 'balance' : 'deposit');
    syncActions();
    overlay.querySelector('.hba-close')?.focus();

    const balanceRequest = (async () => {
      if (!view.hasBalanceReceipt) {
        balanceProof.fail('No separate online Payment 2 receipt was submitted.');
        return;
      }
      try {
        const result = await apiCall('receipt_url', { paymentId: expectedId });
        if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
        balanceProof.show(result?.url || result?.data?.url);
      } catch (error) {
        if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
        balanceProof.fail(error?.message || 'Payment 2 receipt is unavailable.');
      }
    })();

    const depositRequest = (async () => {
      let depositHistoryLoaded = false;
      try {
        const booking = await loadDepositBooking(payment);
        if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
        if (!booking) throw new Error('Accepted deposit record could not be found.');
        const depositMethod = String(booking.paymentMethod || booking.payment_method || providerMethod || '—');
        const depositReference = String(booking.gcashRef || 'Reference unavailable');
        renderPaymentMethodReference(byId('hostDepositTab').querySelector('.hba-tab-meta'), depositMethod, depositReference);
        depositHistoryLoaded = true;
        depositNote.replaceChildren(
          make('strong', '', 'Accepted deposit. '),
          document.createTextNode(`Recorded ${when(booking.paidAt || booking.receiptVerifiedAt || booking.createdAt)}. This payment is read-only.`),
        );
        if (!booking.receiptImageUrl) throw new Error('Deposit accepted, but no receipt image is attached.');
        if (!global.DB?.getReceiptSignedUrl) throw new Error('Deposit receipt service is unavailable.');
        const url = await global.DB.getReceiptSignedUrl(booking.ref);
        if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
        depositProof.show(url);
      } catch (error) {
        if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
        if (!depositHistoryLoaded) {
          byId('hostDepositTab').querySelector('.hba-tab-meta').textContent = 'Accepted · history unavailable';
        }
        depositProof.fail(error?.message || 'Deposit receipt is unavailable.');
      }
    })();

    await Promise.allSettled([balanceRequest, depositRequest]);
  }

  function closeModal() {
    const overlay = byId('hostBalanceReviewModal');
    if (!overlay || overlay.hidden || state.busy) return;
    state.loadToken += 1;
    state.expectedPaymentId = '';
    overlay.hidden = true;
    document.body.style.overflow = '';
    for (const id of ['hostDepositProofImage', 'hostBalanceProofImage']) {
      byId(id)?.removeAttribute('src');
    }
    for (const id of ['hostDepositProofLink', 'hostBalanceProofLink']) {
      const link = byId(id);
      link?.removeAttribute('href');
      if (link) link.style.display = 'none';
    }
    state.current = null;
    state.receiptLoaded = false;
    state.receiptLoadState = 'idle';
    state.depositReceiptLoaded = false;
    state.activeReceipt = 'balance';
    state.reviewable = false;
    state.lastFocus?.focus?.();
    state.lastFocus = null;
  }

  async function decide(decision) {
    const payment = state.current;
    if (!payment || paymentId(payment) !== state.expectedPaymentId || state.busy || !canDecide()
      || !state.reviewable || paymentStatus(payment) !== 'pending_review'
      || !state.receiptLoaded || state.activeReceipt !== 'balance') return;
    const reason = String(byId('hostBalanceReviewReason')?.value || '').trim();
    const amount = money(payment.balanceAmount || payment.balance_amount || payment.expectedAmount || payment.expected_amount);
    const reference = payment.paymentReference || payment.payment_reference || '—';
    if (decision === 'reject' && reason.length < 3) {
      notify('Enter a reason before marking Payment 2 not received.', 'err');
      return;
    }
    if (decision === 'approve' && !global.confirm(
      `Confirm Payment 2 received — ${amount} remaining balance?\n\nReference: ${reference}\nThis marks the booking fully paid. Payment 1 stays unchanged.`
    )) return;
    if (decision === 'reject' && !global.confirm(
      `Mark Payment 2 not received — ${amount} for ${payment.bookingGroupRef || payment.booking_group_ref || payment.bookingRef || payment.booking_ref || 'this booking'}?\n\nReference: ${reference}\nReason: ${reason}`
    )) return;
    state.busy = true;
    const button = byId(decision === 'approve' ? 'hostBalanceApproveBtn' : 'hostBalanceRejectBtn');
    const idleText = button?.textContent || '';
    if (button) button.textContent = decision === 'approve' ? 'Confirming…' : 'Saving…';
    syncActions();
    try {
      await apiCall('review', { paymentId: paymentId(payment), decision, reason });
      notify(decision === 'approve' ? 'Payment 2 confirmed received. The booking is fully paid.' : 'Payment 2 marked not received.', decision === 'approve' ? 'ok' : 'inf');
      state.busy = false;
      closeModal();
      invalidate();
      await render(true);
      if (state.originalRenderPaymentReview) await state.originalRenderPaymentReview();
      if (byId('sec-bookings')?.classList.contains('on') && typeof global.renderBookings === 'function') {
        await global.renderBookings();
      }
    } catch (error) {
      notify(error?.message || 'Could not save the host balance decision.', 'err');
    } finally {
      state.busy = false;
      if (button?.isConnected) button.textContent = idleText;
      syncActions();
    }
  }

  function renderCards() {
    const list = byId('hostBalanceAdminList');
    if (!list) return;
    list.replaceChildren();
    if (!state.payments.length) {
      list.appendChild(make('div', 'hba-empty', 'No host balance receipts are waiting for review.'));
      return;
    }
    state.payments.forEach(payment => {
      const card = make('article', 'hba-card');
      const top = make('div', 'hba-card-top');
      const identity = make('div');
      identity.append(
        make('div', 'hba-name', payment.customerName || payment.customer_name || 'Host booking'),
        make('div', 'hba-ref', payment.bookingGroupRef || payment.booking_group_ref || payment.bookingRef || payment.booking_ref || payment.bookingKey || '—'),
      );
      top.append(identity, make('div', 'hba-amount', money(payment.balanceAmount || payment.balance_amount || payment.expectedAmount || payment.expected_amount)));
      const meta = make('div', 'hba-meta');
      appendSummary(meta, 'Schedule', payment.scheduleLabel || payment.schedule_label || payment.bookingDate || payment.booking_date);
      appendSummary(meta, 'Court', payment.courtLabel || payment.court_label);
      appendPaymentMethodSummary(meta, 'Method', payment.paymentProvider || payment.payment_provider || '—');
      appendSummary(meta, 'New reference', payment.paymentReference || payment.payment_reference);
      const bottom = make('div', 'hba-bottom');
      bottom.appendChild(make('div', 'hba-status', 'Waiting for owner review'));
      const review = make('button', 'btn btn-p btn-sm', 'Payment History');
      review.type = 'button';
      review.addEventListener('click', event => openHistoryForBooking(payment, event.currentTarget));
      bottom.appendChild(review);
      card.append(top, meta, bottom);
      list.appendChild(card);
    });
  }

  function load(force) {
    if (!canDecide()) {
      state.payments = [];
      state.attempts = [];
      state.loadedAt = 0;
      state.loadState = 'forbidden';
      state.attemptsLoadState = 'forbidden';
      syncPendingSummary();
      return Promise.resolve(state.payments);
    }
    if (global.PB_USE_LOCAL_DATA) {
      state.payments = [];
      state.attempts = [];
      state.loadedAt = Date.now();
      state.loadState = 'ready';
      state.attemptsLoadState = 'ready';
      syncPendingSummary();
      return Promise.resolve(state.payments);
    }
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 15000) return Promise.resolve(state.payments);
    if (state.loading) return state.loading;
    state.loadState = 'loading';
    state.attemptsLoadState = 'loading';
    syncPendingSummary();
    state.loading = (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const generation = state.generation;
          const pendingRequest = (async () => {
            const payments = [];
            let offset = 0;
            for (let page = 0; page < 1000; page += 1) {
              const result = await apiCall('list_pending', { limit: 100, offset });
              const rows = result?.payments || result?.data?.payments || [];
              if (!Array.isArray(rows)) throw new Error('Pending balance response is invalid.');
              payments.push(...rows);
              const nextOffset = result?.nextOffset ?? result?.data?.nextOffset;
              if (nextOffset == null) break;
              if (!Number.isSafeInteger(Number(nextOffset)) || Number(nextOffset) <= offset) {
                throw new Error('Pending balance pagination is invalid.');
              }
              offset = Number(nextOffset);
              if (page === 999) throw new Error('Pending balance queue is too large to load safely.');
            }
            return payments;
          })();
          const [pendingResult, attemptsResult] = await Promise.allSettled([
            pendingRequest,
            listPaymentEvidence(),
          ]);
          if (!canDecide() || global.PB_USE_LOCAL_DATA) return load(force);
          if (generation !== state.generation) continue;
          if (pendingResult.status === 'rejected') throw pendingResult.reason;
          state.payments = pendingResult.value;
          state.loadedAt = Date.now();
          state.loadState = 'ready';
          if (attemptsResult.status === 'fulfilled') {
            state.attempts = attemptsResult.value;
            state.attemptsLoadState = 'ready';
          } else {
            state.attempts = [];
            state.attemptsLoadState = 'error';
            console.warn('Host payment history evidence unavailable:', attemptsResult.reason);
          }
          syncPendingSummary();
          return state.payments;
        }
        throw new Error('Pending balances changed while loading. Refresh and try again.');
      } catch (error) {
        state.payments = [];
        state.attempts = [];
        state.loadedAt = 0;
        state.loadState = 'error';
        state.attemptsLoadState = 'error';
        syncPendingSummary();
        throw error;
      }
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  function render(force) {
    ensurePanel();
    const list = byId('hostBalanceAdminList');
    if (!canDecide()) {
      list?.replaceChildren(make('div', 'hba-empty', 'Only the System Owner or Court Owner can review host balance payments.'));
      return load(force);
    }
    if (list) list.replaceChildren(make('div', 'hba-empty', 'Loading host balance payments…'));
    return load(force).then(payments => {
      renderCards();
      return payments;
    }).catch(error => {
      list?.replaceChildren(make('div', 'hba-empty', error?.message || 'Could not load host balance payments.'));
      return [];
    });
  }

  async function reviewForBooking(booking, trigger) {
    return openHistoryForBooking(booking, trigger);
  }

  function depositOnlyPayment(booking, bookingRef) {
    const total = paymentAmount(booking, 'totalAmount', 'total_amount');
    const paymentState = paymentValue(booking, 'paymentStatus', 'payment_status', '').toLowerCase();
    const originalDeposit = optionalPaymentAmount(booking, 'originalDepositAmount', 'original_deposit_amount');
    const fullyPaidWithoutOnlineBalance = paymentState === 'paid';
    return {
      status: fullyPaidWithoutOnlineBalance ? 'paid_without_online_balance' : 'deposit_only',
      bookingRef,
      bookingRefs: Array.isArray(booking.bookingRefs) && booking.bookingRefs.length ? booking.bookingRefs : [bookingRef],
      bookingGroupRef: booking.bookingGroupRef || booking.booking_group_ref || null,
      bookingStatus: booking.status || null,
      bookingPaymentStatus: paymentState || null,
      totalAmount: total,
      originalPaidAmount: originalDeposit,
      balanceAmount: originalDeposit == null ? null : Math.max(0, total - originalDeposit),
      paymentProvider: booking.paymentMethod || booking.payment_method || '—',
      customerName: booking.customerName || booking.customer_name || 'Host booking',
      customerEmail: booking.customerEmail || booking.customer_email || null,
      bookingDate: booking.bookingDate || booking.booking_date || null,
      courtLabel: booking.courtLabel || booking.court_label || null,
      scheduleLabel: booking.scheduleLabel || booking.schedule_label || null,
      createdAt: booking.paidAt || booking.paid_at || booking.createdAt || booking.created_at || null,
    };
  }

  async function openHistoryForBooking(booking, trigger) {
    if (!canDecide()) {
      notify('Only the System Owner or Court Owner can view host payment history.', 'err');
      return false;
    }
    const bookingRef = actualBookingRef(booking);
    if (!bookingRef) {
      notify('A real booking reference is required to open payment history.', 'err');
      return false;
    }
    const historyToken = ++state.historyToken;
    const wasDisabled = !!trigger?.disabled;
    if (trigger) {
      trigger.disabled = true;
      trigger.setAttribute('aria-busy', 'true');
    }
    try {
      const result = await apiCall('history_for_booking', { bookingRef });
      if (historyToken !== state.historyToken) return false;
      const payments = result?.payments || result?.data?.payments || [];
      const bookingSnapshot = result?.booking || result?.data?.booking;
      if (!Array.isArray(payments)) throw new Error('Payment history response is invalid.');
      const payment = payments.find(item => paymentStatus(item) === 'pending_review')
        || payments.find(item => paymentStatus(item) === 'approved')
        || payments[0];
      if (trigger) {
        trigger.disabled = wasDisabled;
        trigger.removeAttribute('aria-busy');
      }
      if (payment) {
        await openModal({
          ...payment,
          bookingStatus: bookingSnapshot?.status || null,
          bookingPaymentStatus: bookingSnapshot?.paymentStatus || null,
          bookingRefs: Array.isArray(payment.bookingRefs) && payment.bookingRefs.length
            ? payment.bookingRefs
            : bookingSnapshot?.bookingRefs || [bookingRef],
        }, trigger);
        return true;
      }
      if (!bookingSnapshot) throw new Error('Booking payment record was not found.');
      await openModal(depositOnlyPayment(bookingSnapshot, bookingRef), trigger);
      return true;
    } catch (error) {
      notify(error?.message || 'Could not open the booking payment history.', 'err');
      return false;
    } finally {
      if (trigger && byId('hostBalanceReviewModal')?.hidden) {
        trigger.disabled = wasDisabled;
        trigger.removeAttribute('aria-busy');
      }
    }
  }

  function invalidate() {
    state.generation += 1;
    state.loadedAt = 0;
    state.payments = [];
    state.attempts = [];
    if (state.loadState === 'ready') state.loadState = 'idle';
    if (state.attemptsLoadState === 'ready') state.attemptsLoadState = 'idle';
    syncPendingSummary();
  }

  function install() {
    addStyles();
    ensurePanel();
    ensureModal();
    if (typeof global.renderPaymentReview === 'function' && !state.originalRenderPaymentReview) {
      state.originalRenderPaymentReview = global.renderPaymentReview;
      global.renderPaymentReview = async function wrappedPaymentReview() {
        const result = await state.originalRenderPaymentReview.apply(this, arguments);
        await render(false);
        return result;
      };
    }
  }

  global.HostBalanceAdmin = Object.freeze({
    install,
    load,
    render,
    invalidate,
    pendingSummary,
    pendingForBooking,
    statusForBooking,
    paymentEvidenceForBooking,
    approvedForBooking,
    reviewForBooking,
    openHistoryForBooking,
    open: openModal,
    close: closeModal,
  });
  install();
})(window);
