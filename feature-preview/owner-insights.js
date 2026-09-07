(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PaddleRageInsights = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MINIMUM_LEARNING_DAYS = 30;
  const MINIMUM_RECOMMENDATION_COMPARABLE_DAYS = 8;
  const FORECAST_DAYS = 28;
  const RECENCY_HALF_LIFE_DAYS = 56;
  const OPENING_DATE = '2026-09-19';
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MANILA_TIME_ZONE = 'Asia/Manila';

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clamp(value, minimum = 0, maximum = 100) {
    return Math.max(minimum, Math.min(maximum, number(value)));
  }

  function dateOnly(value) {
    return String(value || '').slice(0, 10);
  }

  function manilaDateKey(value = new Date()) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value);
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: MANILA_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(parsed);
  }

  function addDays(value, amount) {
    const parsed = new Date(`${dateOnly(value)}T00:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + number(amount));
    return parsed.toISOString().slice(0, 10);
  }

  function datesBetween(from, to) {
    if (!from || !to || from > to) return [];
    const values = [];
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) values.push(cursor);
    return values;
  }

  function isoWeekday(value) {
    return ((new Date(`${dateOnly(value)}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  }

  function daysApart(from, to) {
    return Math.max(0, Math.round((new Date(`${dateOnly(to)}T00:00:00Z`) - new Date(`${dateOnly(from)}T00:00:00Z`)) / 86400000));
  }

  function timeLabel(startHour, endHour) {
    const format = hour => {
      const normalized = ((number(hour) % 24) + 24) % 24;
      return `${normalized % 12 || 12} ${normalized >= 12 ? 'PM' : 'AM'}`;
    };
    return `${format(startHour)}–${format(endHour)}`;
  }

  function formatDate(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: MANILA_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(`${dateOnly(value)}T12:00:00+08:00`));
  }

  function confidenceFor(cell) {
    const days = number(cell?.comparable_days ?? cell?.comparableDays);
    const hours = number(cell?.available_hours ?? cell?.availableHours);
    if (days >= 16 && hours >= 16) return { code: 'high', label: 'High confidence' };
    if (days >= 8 && hours >= 8) return { code: 'medium', label: 'Medium confidence' };
    if (days >= 4 && hours >= 4) return { code: 'low', label: 'Early signal' };
    return { code: 'learning', label: 'Still learning' };
  }

  function wilsonBounds(bookedHours, availableHours, z = 1.645) {
    const n = Math.max(0, number(availableHours));
    if (!n) return { low: 0, high: 100 };
    const p = clamp(number(bookedHours) / n, 0, 1);
    const denominator = 1 + (z * z / n);
    const centre = (p + z * z / (2 * n)) / denominator;
    const margin = z * Math.sqrt((p * (1 - p) / n) + (z * z / (4 * n * n))) / denominator;
    return { low: clamp((centre - margin) * 100), high: clamp((centre + margin) * 100) };
  }

  function demandState(cell) {
    const confidence = confidenceFor(cell).code;
    const utilization = clamp(cell?.utilization_pct ?? cell?.utilizationPct);
    const bounds = wilsonBounds(cell?.booked_hours ?? cell?.bookedHours, cell?.available_hours ?? cell?.availableHours);
    if (confidence === 'learning') return 'learning';
    if (bounds.low >= 60 || (utilization >= 75 && ['medium', 'high'].includes(confidence))) return 'peak';
    if (utilization >= 55 || bounds.high >= 55) return 'healthy';
    if (confidence === 'low' || utilization >= 40) return 'watch';
    if (utilization < 15 && bounds.high < 30) return 'quiet';
    if (utilization < 40 && bounds.high < 50) return 'underused';
    return 'watch';
  }

  function parseStartHour(value, fallback = 6) {
    const match = String(value || '').trim().match(/^(\d{1,2})(?::\d{2})?\s*(AM|PM)?/i);
    if (!match) return fallback;
    let hour = Number(match[1]);
    if (match[2]) {
      hour %= 12;
      if (match[2].toUpperCase() === 'PM') hour += 12;
    }
    return clamp(hour, 0, 23);
  }

  function normalizedSlots(row, fallbackOpen = 6) {
    const explicit = Array.isArray(row?.slots) ? row.slots.map(Number).filter(Number.isFinite) : [];
    if (explicit.length) return explicit.map(hour => ({ hour: Math.floor(hour), hours: 1 }));
    const duration = Math.max(0, number(row?.duration));
    const start = parseStartHour(row?.startTime || row?.start_time, fallbackOpen);
    return Array.from({ length: Math.ceil(duration) }, (_, offset) => ({
      hour: start + offset,
      hours: Math.min(1, Math.max(duration - offset, 0)),
    })).filter(piece => piece.hour < 24 && piece.hours > 0);
  }

  function parseObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(String(value));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function enabled(value) {
    return value === true || String(value || '').toLowerCase() === 'true';
  }

  function appliesToCourt(config, courtId) {
    const configured = Array.isArray(config?.courtIds)
      ? config.courtIds
      : Array.isArray(config?.court_ids) ? config.court_ids : [];
    const ids = configured.map(String).filter(Boolean);
    return ids.length === 0 || ids.includes(String(courtId));
  }

  function hourInRange(hour, startValue, endValue) {
    const slot = Number(hour);
    const start = Number(startValue);
    const end = Number(endValue);
    if (!Number.isInteger(slot) || !Number.isInteger(start) || !Number.isInteger(end) || start === end) return false;
    return start < end ? slot >= start && slot < end : slot >= start || slot < end;
  }

  function occurrenceDate(value, hour, startValue, endValue) {
    const start = Number(startValue);
    const end = Number(endValue);
    return start > end && Number(hour) < end ? addDays(value, -1) : dateOnly(value);
  }

  function openPlayMatches(value, hour, courtId, config) {
    if (!config || !enabled(config.enabled) || !appliesToCourt(config, courtId) || !hourInRange(hour, config.start, config.end)) return false;
    const date = occurrenceDate(value, hour, config.start, config.end);
    const calendarDay = new Date(`${date}T12:00:00Z`).getUTCDay();
    const days = Array.isArray(config.days) ? config.days.map(Number) : [];
    const dates = Array.isArray(config.specificDates)
      ? config.specificDates.map(String)
      : Array.isArray(config.specific_dates) ? config.specific_dates.map(String) : [];
    return days.includes(calendarDay) || dates.includes(date);
  }

  function maintenanceMatches(value, hour, courtId, rule) {
    if (!rule || !enabled(rule.enabled) || !appliesToCourt(rule, courtId) || !hourInRange(hour, rule.start, rule.end)) return false;
    const date = occurrenceDate(value, hour, rule.start, rule.end);
    const calendarDay = new Date(`${date}T12:00:00Z`).getUTCDay();
    const mode = String(rule.mode || 'specific').toLowerCase();
    if (mode === 'monthly') return Number(rule.recurring?.day) === Number(date.slice(8, 10));
    if (mode === 'weekly') {
      const days = Array.isArray(rule.recurring?.days) ? rule.recurring.days.map(Number) : [];
      return days.includes(calendarDay);
    }
    if (mode !== 'specific') return false;
    return (Array.isArray(rule.dates) ? rule.dates.map(String) : []).includes(date);
  }

  function isOpenPlayHour(value, hour, courtId, settings = {}) {
    return openPlayMatches(dateOnly(value), hour, courtId, parseObject(settings.open_play_config));
  }

  function isMaintenanceHour(value, hour, courtId, settings = {}) {
    const maintenance = parseObject(settings.maintenance_config);
    const rules = Array.isArray(maintenance.rules) ? maintenance.rules : Object.keys(maintenance).length ? [maintenance] : [];
    return rules.some(rule => maintenanceMatches(dateOnly(value), hour, courtId, rule));
  }

  function isSellableHour(value, hour, courtId, settings = {}) {
    return !isOpenPlayHour(value, hour, courtId, settings) && !isMaintenanceHour(value, hour, courtId, settings);
  }

  function pricingTiers(value) {
    let parsed = value;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch (_) { parsed = []; }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(tier => ({ from: number(tier?.from), to: number(tier?.to), rate: Number(tier?.rate) }))
      .filter(tier => Number.isInteger(tier.from) && Number.isInteger(tier.to) && tier.from !== tier.to && Number.isFinite(tier.rate) && tier.rate >= 0);
  }

  function rateForSlot(input, court, hour) {
    const tiers = pricingTiers(court?.rateSchedule ?? court?.rate_schedule);
    const venueTiers = pricingTiers(input?.settings?.pricing_tiers);
    const selected = tiers.length ? tiers : venueTiers;
    const match = selected.find(tier => tier.from < tier.to
      ? Number(hour) >= tier.from && Number(hour) < tier.to
      : Number(hour) >= tier.from || Number(hour) < tier.to);
    return match ? match.rate : Math.max(0, number(court?.rate));
  }

  function isSuccessfulBooking(row) {
    const status = String(row?.status || '').toLowerCase();
    const payment = String(row?.paymentStatus ?? row?.payment_status ?? '').toLowerCase();
    return ['confirmed', 'completed'].includes(status) && ['paid', 'downpayment_paid'].includes(payment);
  }

  function uniqueSuccessfulRows(rows, throughDate, courtId = null) {
    const unique = new Map();
    (Array.isArray(rows) ? rows : [])
      .filter(isSuccessfulBooking)
      .filter(row => dateOnly(row.date) && dateOnly(row.date) <= throughDate)
      .filter(row => !courtId || String(row.courtId || row.court_id) === String(courtId))
      .forEach(row => {
        const slots = normalizedSlots(row).map(piece => `${piece.hour}:${piece.hours}`).join(',');
        const key = `${row.groupRef || row.booking_group_ref || row.ref}|${row.courtId || row.court_id}|${dateOnly(row.date)}|${slots}`;
        if (!unique.has(key)) unique.set(key, row);
      });
    return [...unique.values()];
  }

  function buildSnapshot(input = {}) {
    const nowValue = input.now || new Date();
    const nowMs = new Date(nowValue).getTime();
    const today = manilaDateKey(nowValue);
    const throughDate = addDays(today, -1);
    const requestedOpeningDate = dateOnly(input.openingDate || input.opening_date || OPENING_DATE);
    const openingDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedOpeningDate) ? requestedOpeningDate : OPENING_DATE;
    const allCourts = Array.isArray(input.courts) ? input.courts : [];
    const courts = allCourts.filter(court => !input.courtId || String(court.id) === String(input.courtId));
    const courtMap = new Map(courts.map(court => [String(court.id), court]));
    const blockedDates = new Set((Array.isArray(input.blockedDates) ? input.blockedDates : []).map(value => dateOnly(value?.date || value)));
    const openHour = clamp(parseInt(input.settings?.open_hour || 6, 10) || 6, 0, 23);
    const closeHour = clamp(parseInt(input.settings?.close_hour || 22, 10) || 22, openHour + 1, 24);
    const slots = Array.from({ length: closeHour - openHour }, (_, index) => openHour + index);
    const venueRows = uniqueSuccessfulRows(input.bookings, throughDate, null)
      .filter(row => dateOnly(row.date) >= openingDate)
      .filter(row => allCourts.some(court => String(court.id) === String(row.courtId || row.court_id)));
    const historicalRows = uniqueSuccessfulRows(input.bookings, throughDate, input.courtId)
      .filter(row => dateOnly(row.date) >= openingDate);
    const eligibleRows = historicalRows.filter(row => courtMap.has(String(row.courtId || row.court_id)));
    // A newly filtered court learns against the venue's operating history even
    // when that court has not won a booking yet. Per-court creation dates still
    // prevent capacity from being counted before the court existed.
    const earliest = venueRows.map(row => dateOnly(row.date)).filter(Boolean).sort()[0] || null;
    const historyDates = earliest ? datesBetween(earliest, throughDate) : [];
    const cells = new Map();

    courts.forEach(court => slots.forEach(hour => {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        cells.set(`${court.id}:${weekday}:${hour}`, {
          court_id: String(court.id),
          court_name: court.name || `Court ${court.id}`,
          weekday,
          weekday_label: WEEKDAYS[weekday - 1],
          start_hour: hour,
          end_hour: hour + 1,
          rate: rateForSlot(input, court, hour),
          booked_hours: 0,
          available_hours: 0,
          weighted_booked_hours: 0,
          weighted_available_hours: 0,
          comparable_days: 0,
          future_sellable_hours: 0,
          future_booked_hours: 0,
          open_future_hours: 0,
          next_open_date: null,
        });
      }
    }));

    historyDates.forEach(date => {
      if (blockedDates.has(date)) return;
      const weekday = isoWeekday(date);
      const weight = Math.pow(0.5, daysApart(date, throughDate) / RECENCY_HALF_LIFE_DAYS);
      courts.forEach(court => {
        const createdDate = dateOnly(court.createdAt || court.created_at);
        if (createdDate && createdDate > date) return;
        slots.forEach(hour => {
          if (!isSellableHour(date, hour, court.id, input.settings)) return;
          const cell = cells.get(`${court.id}:${weekday}:${hour}`);
          cell.available_hours += 1;
          cell.weighted_available_hours += weight;
          cell.comparable_days += 1;
        });
      });
    });

    const historicalOccupied = new Map();
    const successfulReservations = new Set();
    eligibleRows.forEach(row => {
      const courtId = String(row.courtId || row.court_id);
      const date = dateOnly(row.date);
      if (!date || blockedDates.has(date)) return;
      let contributed = false;
      normalizedSlots(row, openHour).forEach(piece => {
        if (piece.hour < openHour || piece.hour >= closeHour || !isSellableHour(date, piece.hour, courtId, input.settings)) return;
        const key = `${courtId}:${date}:${piece.hour}`;
        historicalOccupied.set(key, Math.min(1, number(historicalOccupied.get(key)) + piece.hours));
        contributed = true;
      });
      if (contributed) successfulReservations.add(String(row.groupRef || row.booking_group_ref || row.ref));
    });

    historicalOccupied.forEach((hours, key) => {
      const [courtId, date, hourValue] = key.split(':');
      const hour = Number(hourValue);
      const cell = cells.get(`${courtId}:${isoWeekday(date)}:${hour}`);
      if (!cell) return;
      const weight = Math.pow(0.5, daysApart(date, throughDate) / RECENCY_HALF_LIFE_DAYS);
      cell.booked_hours += hours;
      cell.weighted_booked_hours += hours * weight;
    });

    const futureOccupied = new Map();
    const futureFrom = [addDays(today, 1), openingDate].sort().pop();
    const futureEnd = addDays(today, FORECAST_DAYS);
    (Array.isArray(input.bookings) ? input.bookings : []).forEach(row => {
      const date = dateOnly(row.date);
      if (!date || date < futureFrom || date > futureEnd) return;
      const status = String(row.status || '').toLowerCase();
      const createdAt = new Date(row.createdAt || row.created_at || '').getTime();
      const freshHold = status === 'verifying' && Number.isFinite(createdAt)
        && Number.isFinite(nowMs) && nowMs >= createdAt && nowMs - createdAt < 15 * 60000;
      if (!['pending', 'confirmed', 'completed'].includes(status) && !freshHold) return;
      const courtId = String(row.courtId || row.court_id);
      if (!courtMap.has(courtId)) return;
      normalizedSlots(row, openHour).forEach(piece => {
        const key = `${courtId}:${date}:${piece.hour}`;
        futureOccupied.set(key, Math.min(1, number(futureOccupied.get(key)) + piece.hours));
      });
    });

    datesBetween(futureFrom, futureEnd).forEach(date => {
      if (blockedDates.has(date)) return;
      const weekday = isoWeekday(date);
      courts.filter(court => !court.blocked).forEach(court => slots.forEach(hour => {
        if (!isSellableHour(date, hour, court.id, input.settings)) return;
        const cell = cells.get(`${court.id}:${weekday}:${hour}`);
        const occupied = number(futureOccupied.get(`${court.id}:${date}:${hour}`));
        const open = Math.max(0, 1 - occupied);
        cell.future_sellable_hours += 1;
        cell.future_booked_hours += occupied;
        cell.open_future_hours += open;
        if (open > 0 && !cell.next_open_date) cell.next_open_date = date;
      }));
    });

    const signals = [...cells.values()].map(cell => {
      const utilization = cell.weighted_available_hours > 0
        ? clamp(cell.weighted_booked_hours * 100 / cell.weighted_available_hours)
        : 0;
      const signal = { ...cell, utilization_pct: utilization };
      signal.confidence = confidenceFor(signal).code;
      signal.state = demandState(signal);
      signal.opportunity_value = signal.open_future_hours * (1 - utilization / 100) * signal.rate;
      return signal;
    });

    const heatmap = [];
    slots.forEach(hour => {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        const pieces = signals.filter(signal => signal.weekday === weekday && signal.start_hour === hour);
        const available = pieces.reduce((sum, item) => sum + item.available_hours, 0);
        const weightedAvailable = pieces.reduce((sum, item) => sum + item.weighted_available_hours, 0);
        const weightedBooked = pieces.reduce((sum, item) => sum + item.weighted_booked_hours, 0);
        const cell = {
          weekday,
          weekday_label: WEEKDAYS[weekday - 1],
          start_hour: hour,
          end_hour: hour + 1,
          booked_hours: pieces.reduce((sum, item) => sum + item.booked_hours, 0),
          available_hours: available,
          comparable_days: Math.max(0, ...pieces.map(item => item.comparable_days)),
          utilization_pct: weightedAvailable > 0 ? clamp(weightedBooked * 100 / weightedAvailable) : 0,
        };
        cell.confidence = confidenceFor(cell).code;
        cell.state = demandState(cell);
        heatmap.push(cell);
      }
    });

    const totalFutureSellable = signals.reduce((sum, item) => sum + item.future_sellable_hours, 0);
    const bookedNext28 = signals.reduce((sum, item) => sum + item.future_booked_hours, 0);
    const evidenceSignals = signals.filter(item => item.confidence !== 'learning');
    const evidenceSellable = evidenceSignals.reduce((sum, item) => sum + item.future_sellable_hours, 0);
    const evidenceBooked = evidenceSignals.reduce((sum, item) => sum + item.future_booked_hours, 0);
    const evidenceOpen = evidenceSignals.reduce((sum, item) => sum + item.open_future_hours, 0);
    const expectedAdditional = evidenceSignals.reduce((sum, item) => sum + item.open_future_hours * item.utilization_pct / 100, 0);
    const expectedTotalFill = evidenceSellable > 0 ? clamp((evidenceBooked + expectedAdditional) * 100 / evidenceSellable) : null;
    const likelyOpen = evidenceOpen > 0 ? Math.max(0, evidenceOpen - expectedAdditional) : null;
    const enoughHistory = historyDates.length >= MINIMUM_LEARNING_DAYS;
    const maxComparableDays = Math.max(0, ...signals.map(item => item.comparable_days));
    const recommendationEvidenceReady = signals.some(item => item.comparable_days >= MINIMUM_RECOMMENDATION_COMPARABLE_DAYS
      && item.available_hours >= MINIMUM_RECOMMENDATION_COMPARABLE_DAYS);
    const candidates = enoughHistory ? signals
      .filter(item => ['medium', 'high'].includes(item.confidence))
      .filter(item => ['quiet', 'underused'].includes(item.state))
      .filter(item => item.open_future_hours > 0 && item.next_open_date)
      .sort((a, b) => b.opportunity_value - a.opportunity_value || b.open_future_hours - a.open_future_hours || a.utilization_pct - b.utilization_pct) : [];
    const best = candidates[0] || null;
    const recommendation = best ? {
      id: ['paddle-rage', best.court_id, best.next_open_date, best.start_hour, Math.round(best.utilization_pct * 10)].join(':'),
      court_id: best.court_id,
      court_name: best.court_name,
      date: best.next_open_date,
      weekday_label: best.weekday_label,
      start_hour: best.start_hour,
      end_hour: best.end_hour,
      utilization_pct: best.utilization_pct,
      expected_open_pct: 100 - best.utilization_pct,
      comparable_days: best.comparable_days,
      confidence: confidenceFor(best),
      rate: best.rate,
      action_type: 'feature_regular_price_hour',
    } : null;

    return {
      period: {
        from: earliest,
        to: throughDate,
        generated_at: new Date().toISOString(),
        learning_days: historyDates.length,
        minimum_learning_days: MINIMUM_LEARNING_DAYS,
        minimum_recommendation_comparable_days: MINIMUM_RECOMMENDATION_COMPARABLE_DAYS,
        max_comparable_days: maxComparableDays,
        recommendation_evidence_ready: recommendationEvidenceReady,
        opening_date: openingDate,
        forecast_from: futureFrom <= futureEnd ? futureFrom : null,
        forecast_to: futureFrom <= futureEnd ? futureEnd : null,
        is_preopening: today < openingDate,
      },
      kpis: {
        booked_next_28_hours: bookedNext28,
        sellable_next_28_hours: totalFutureSellable,
        booked_next_28_pct: totalFutureSellable ? clamp(bookedNext28 * 100 / totalFutureSellable) : 0,
        expected_total_fill_pct: enoughHistory && expectedTotalFill !== null ? expectedTotalFill : null,
        forecast_coverage_pct: totalFutureSellable ? clamp(evidenceSellable * 100 / totalFutureSellable) : 0,
        likely_open_hours: enoughHistory ? likelyOpen : null,
        action_ready: recommendation ? 1 : 0,
      },
      heatmap,
      signals,
      recommendation,
      data_quality: {
        successful_reservations: successfulReservations.size,
        successful_booking_rows: eligibleRows.length,
        current_schedule_note: 'Capacity uses the venue schedule currently saved in Pickle Street. Open Play, Maintenance, blocked dates, temporary holds, failed payments, and cancelled or forfeited bookings do not teach private-court demand.',
      },
    };
  }

  return {
    MINIMUM_LEARNING_DAYS,
    MINIMUM_RECOMMENDATION_COMPARABLE_DAYS,
    FORECAST_DAYS,
    RECENCY_HALF_LIFE_DAYS,
    OPENING_DATE,
    WEEKDAYS,
    manilaDateKey,
    timeLabel,
    formatDate,
    confidenceFor,
    demandState,
    isSuccessfulBooking,
    buildSnapshot,
  };
});
