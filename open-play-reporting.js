(function configureOpenPlayReporting(global) {
  'use strict';

  const MANILA_TIME_ZONE = 'Asia/Manila';
  const VALID_BREAKDOWNS = new Set(['sessions', 'paymentMethods', 'receivingAccounts', 'monthlyTrend']);
  const state = {
    mounted: false,
    dashboardSequence: 0,
    reportSequence: 0,
    exportInFlight: false,
    report: null,
    reportRange: null,
    breakdown: 'sessions',
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function integer(value, fallback = 0) {
    const number = Number(value);
    return Number.isInteger(number) ? number : fallback;
  }

  function money(value, currency = 'PHP') {
    return new Intl.NumberFormat('en-PH', {
      style: 'currency',
      currency: String(currency || 'PHP').toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(Math.max(0, finite(value)));
  }

  function manilaDateKey(value = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: MANILA_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const part = type => parts.find(item => item.type === type)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  function dateLabel(value, { weekday = false } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return 'Date unavailable';
    const date = new Date(`${value}T00:00:00+08:00`);
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: MANILA_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(weekday ? { weekday: 'short' } : {}),
    }).format(date);
  }

  function timeLabel(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return 'Time unavailable';
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: MANILA_TIME_ZONE,
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  function notify(message, type = 'err') {
    if (typeof global.toast === 'function') global.toast(message, type);
    else if (type === 'err') console.error(message);
  }

  function dashboardShell(copy = 'Loading today\'s Open Play schedule…') {
    return `<section class="opr-dashboard" aria-labelledby="oprDashboardTitle">
      <div class="opr-section-head">
        <div>
          <div class="opr-eyebrow">Player sessions</div>
          <h3 id="oprDashboardTitle">Open Play Today</h3>
        </div>
        <button type="button" class="opr-link-button" onclick="goto('openplay')">Manage Open Play</button>
      </div>
      <div class="opr-loading" role="status">${escapeHtml(copy)}</div>
    </section>`;
  }

  function dashboardUnavailable(message) {
    const host = byId('openPlayDashboardMount');
    if (!host) return;
    host.innerHTML = `<section class="opr-dashboard" aria-labelledby="oprDashboardTitle">
      <div class="opr-section-head">
        <div><div class="opr-eyebrow">Player sessions</div><h3 id="oprDashboardTitle">Open Play Today</h3></div>
        <button type="button" class="opr-link-button" onclick="goto('openplay')">Manage Open Play</button>
      </div>
      <div class="opr-notice" role="alert">
        <div><strong>Open Play snapshot unavailable</strong><span>${escapeHtml(message)}</span></div>
        <button type="button" onclick="OpenPlayReporting.renderDashboard()">Retry</button>
      </div>
    </section>`;
  }

  function sessionCard(session, today) {
    const occupied = Math.max(0, integer(session.confirmedCount) + integer(session.heldCount));
    const capacity = Math.max(0, integer(session.capacity));
    const status = String(session.status || '').toLowerCase();
    return `<article class="opr-session-card">
      <div class="opr-session-date"><strong>${escapeHtml(session.date === today ? 'Today' : dateLabel(session.date, { weekday: true }))}</strong><span>${escapeHtml(timeLabel(session.startsAt))}–${escapeHtml(timeLabel(session.endsAt))}</span></div>
      <div class="opr-session-main"><strong>${escapeHtml(session.title || 'Open Play')}</strong><span>${escapeHtml((session.courtNames || []).join(' + ') || 'Court unavailable')}</span></div>
      <div class="opr-session-capacity"><strong>${occupied}/${capacity}</strong><span>reserved spots</span></div>
      <span class="opr-status ${escapeHtml(status)}">${escapeHtml(status || 'unknown')}</span>
    </article>`;
  }

  async function renderDashboard() {
    if (global.PB_TENANT_CONFIG?.adminOpenPlayEnabled === false) return false;
    const host = byId('openPlayDashboardMount');
    if (!host) return false;
    const sequence = ++state.dashboardSequence;
    host.innerHTML = dashboardShell();
    if (typeof global.DB?.getManagerOpenPlaySessions !== 'function') {
      dashboardUnavailable('The protected Open Play service is not available in this build.');
      return false;
    }
    try {
      const sessions = await global.DB.getManagerOpenPlaySessions({ scope: 'upcoming' });
      if (sequence !== state.dashboardSequence) return false;
      const today = manilaDateKey();
      const active = (Array.isArray(sessions) ? sessions : [])
        .filter(session => ['published', 'completed'].includes(String(session.status || '').toLowerCase()))
        .sort((a, b) => Date.parse(a.startsAt || '') - Date.parse(b.startsAt || ''));
      const todaySessions = active.filter(session => session.date === today);
      const occupied = todaySessions.reduce((sum, session) =>
        sum + Math.max(0, integer(session.confirmedCount) + integer(session.heldCount)), 0);
      const capacity = todaySessions.reduce((sum, session) => sum + Math.max(0, integer(session.capacity)), 0);
      const review = todaySessions.reduce((sum, session) => sum + Math.max(0, integer(session.paymentReviewCount)), 0);
      const collected = todaySessions.reduce((sum, session) => sum + Math.max(0, finite(session.collectedTotal)), 0);
      const visibleSessions = todaySessions.length ? todaySessions : active.slice(0, 3);
      host.innerHTML = `<section class="opr-dashboard" aria-labelledby="oprDashboardTitle">
        <div class="opr-section-head">
          <div>
            <div class="opr-eyebrow">Player sessions</div>
            <h3 id="oprDashboardTitle">Open Play Today</h3>
            <p>${todaySessions.length ? dateLabel(today, { weekday: true }) : 'No published session today. Showing the next available sessions.'}</p>
          </div>
          <button type="button" class="opr-link-button" onclick="goto('openplay')">Manage Open Play</button>
        </div>
        <div class="opr-dashboard-metrics" aria-label="Open Play summary for today">
          <div><span>Sessions</span><strong>${todaySessions.length}</strong></div>
          <div><span>Reserved spots</span><strong>${occupied}${capacity ? `/${capacity}` : ''}</strong></div>
          <div><span>Payment review</span><strong>${review}</strong></div>
          <div><span>Collected</span><strong>${money(collected)}</strong></div>
        </div>
        <div class="opr-session-list">
          ${visibleSessions.length
            ? visibleSessions.map(session => sessionCard(session, today)).join('')
            : '<div class="opr-empty">No upcoming Open Play sessions.</div>'}
        </div>
      </section>`;
      return true;
    } catch (error) {
      if (sequence !== state.dashboardSequence) return false;
      console.error('Open Play dashboard snapshot failed:', error);
      dashboardUnavailable('Court-booking information is still available. Retry this snapshot separately.');
      return false;
    }
  }

  function reportShell() {
    return `<section class="opr-report" aria-labelledby="oprReportTitle">
      <div class="opr-section-head">
        <div><div class="opr-eyebrow">Player-session accounting</div><h3 id="oprReportTitle">Open Play</h3></div>
      </div>
      <div class="opr-loading" role="status">Loading the protected Open Play report…</div>
    </section>`;
  }

  function reportUnavailable(message, unsupported = false) {
    const host = byId('openPlayReportMount');
    if (!host) return;
    host.innerHTML = `<section class="opr-report" aria-labelledby="oprReportTitle">
      <div class="opr-section-head">
        <div><div class="opr-eyebrow">Player-session accounting</div><h3 id="oprReportTitle">Open Play</h3></div>
      </div>
      <div class="opr-notice" role="alert">
        <div>
          <strong>${unsupported ? 'Protected reporting update required' : 'Open Play accounting unavailable'}</strong>
          <span>${escapeHtml(message)}</span>
        </div>
        <button type="button" onclick="OpenPlayReporting.retryReport()">Retry</button>
      </div>
    </section>`;
  }

  function metric(label, value, options = {}) {
    return `<div class="opr-metric${options.warning ? ' warning' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${options.help ? `<small>${escapeHtml(options.help)}</small>` : ''}</div>`;
  }

  function barRows(entries, emptyCopy) {
    const normalized = (Array.isArray(entries) ? entries : [])
      .map(entry => ({
        label: String(entry?.label || entry?.name || entry?.key || 'Not recorded'),
        amount: Math.max(0, finite(entry?.amount ?? entry?.value)),
      }))
      .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
    if (!normalized.length) return `<div class="opr-empty">${escapeHtml(emptyCopy)}</div>`;
    const maximum = Math.max(...normalized.map(entry => entry.amount), 1);
    return normalized.map(entry => `<div class="opr-bar-row">
      <span title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</span>
      <div><i style="width:${Math.round(entry.amount / maximum * 100)}%"></i></div>
      <strong>${money(entry.amount)}</strong>
    </div>`).join('');
  }

  function sessionRows(entries) {
    const sessions = Array.isArray(entries) ? entries : [];
    if (!sessions.length) return '<div class="opr-empty">No Open Play sessions in this period.</div>';
    return `<div class="opr-table-wrap"><table class="opr-table">
      <thead><tr><th>Session</th><th>Courts</th><th>Paid spots</th><th>Venue sales</th><th>Service fees</th><th>Collected</th><th>Net</th></tr></thead>
      <tbody>${sessions.map(session => `<tr>
        <td data-label="Session"><strong>${escapeHtml(session.title || 'Open Play')}</strong><small>${escapeHtml(dateLabel(session.date))} · ${escapeHtml(timeLabel(session.startsAt))}</small></td>
        <td data-label="Courts">${escapeHtml((session.courtNames || []).join(' + ') || 'Not recorded')}</td>
        <td data-label="Paid spots">${Math.max(0, integer(session.paidSpots))}/${Math.max(0, integer(session.capacity))}</td>
        <td data-label="Venue sales">${money(session.venueSales)}</td>
        <td data-label="Service fees">${money(session.serviceFees)}</td>
        <td data-label="Collected">${money(session.grossCollected)}</td>
        <td data-label="Net">${money(session.netCollected)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function trendRows(entries) {
    const trend = Array.isArray(entries) ? entries : [];
    if (!trend.length) return '<div class="opr-empty">No Open Play collection trend in this period.</div>';
    return `<div class="opr-table-wrap"><table class="opr-table compact">
      <thead><tr><th>Period</th><th>Venue sales</th><th>Service fees</th><th>Gross collected</th><th>Refunds</th><th>Net collected</th></tr></thead>
      <tbody>${trend.map(item => `<tr>
        <td data-label="Period"><strong>${escapeHtml(item.label || item.period || '')}</strong></td>
        <td data-label="Venue sales">${money(item.venueSales)}</td>
        <td data-label="Service fees">${money(item.serviceFees)}</td>
        <td data-label="Gross collected">${money(item.grossCollected)}</td>
        <td data-label="Refunds">${money(item.refundsCompleted)}</td>
        <td data-label="Net collected">${money(item.netCollected)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function breakdownBody(report) {
    const breakdowns = report?.breakdowns || {};
    if (state.breakdown === 'sessions') return sessionRows(breakdowns.sessions);
    if (state.breakdown === 'paymentMethods') return barRows(breakdowns.paymentMethods, 'No verified Open Play payments in this period.');
    if (state.breakdown === 'receivingAccounts') return barRows(breakdowns.receivingAccounts, 'No receiving-account data in this period.');
    return trendRows(breakdowns.monthlyTrend);
  }

  function renderReportResult(report) {
    const host = byId('openPlayReportMount');
    if (!host) return;
    const summary = report.summary || {};
    const occupancy = Math.max(0, finite(summary.occupancyRate));
    const currency = summary.currency || 'PHP';
    host.innerHTML = `<section class="opr-report" aria-labelledby="oprReportTitle">
      <div class="opr-section-head">
        <div>
          <div class="opr-eyebrow">Player-session accounting</div>
          <h3 id="oprReportTitle">Open Play</h3>
          <p>${escapeHtml(dateLabel(report.range?.from))} – ${escapeHtml(dateLabel(report.range?.to))} · ${escapeHtml(report.timezone || MANILA_TIME_ZONE)}</p>
        </div>
        <span class="opr-asof">Complete as of ${escapeHtml(timeLabel(report.serverTime))}</span>
      </div>
      <div class="opr-report-group" aria-labelledby="oprOperationsTitle">
        <h4 id="oprOperationsTitle">Operations</h4>
        <div class="opr-report-metrics">
          ${metric('Sessions held', String(Math.max(0, integer(summary.sessionsHeld))))}
          ${metric('Paid spots', `${Math.max(0, integer(summary.paidSpots))}/${Math.max(0, integer(summary.totalCapacity))}`)}
          ${metric('Checked in', String(Math.max(0, integer(summary.checkedInPlayers))))}
          ${metric('Occupancy', `${occupancy.toFixed(1)}%`)}
          ${metric('Payment review', String(Math.max(0, integer(summary.paymentReviewCount))), { help: money(summary.paymentReviewAmount, currency) })}
          ${metric('Accounting flags', String(Math.max(0, integer(summary.anomalyCount))), { warning: integer(summary.anomalyCount) > 0 })}
        </div>
      </div>
      <div class="opr-report-group" aria-labelledby="oprFinanceTitle">
        <h4 id="oprFinanceTitle">Financial summary</h4>
        <div class="opr-report-metrics financial">
          ${metric('Venue sales', money(summary.venueSales, currency), { help: 'Paid Open Play subtotal' })}
          ${metric('Service fees', money(summary.serviceFees, currency), { help: 'Platform fee liability' })}
          ${metric('Gross collected', money(summary.grossCollected, currency))}
          ${metric('Open refund liability', money(summary.refundLiability, currency), { warning: finite(summary.refundLiability) > 0 })}
          ${metric('Refunds completed', money(summary.refundsCompleted, currency))}
          ${metric('Net collected', money(summary.netCollected, currency))}
        </div>
      </div>
      <div class="opr-breakdown">
        <div class="opr-breakdown-head">
          <h4>Breakdown</h4>
          <div class="opr-tabs" role="tablist" aria-label="Open Play report breakdown">
            <button type="button" id="opr-tab-sessions" role="tab" data-opr-tab="sessions" aria-controls="oprBreakdownBody" onclick="OpenPlayReporting.setBreakdown('sessions')" onkeydown="OpenPlayReporting.handleBreakdownKey(event)">Sessions</button>
            <button type="button" id="opr-tab-paymentMethods" role="tab" data-opr-tab="paymentMethods" aria-controls="oprBreakdownBody" onclick="OpenPlayReporting.setBreakdown('paymentMethods')" onkeydown="OpenPlayReporting.handleBreakdownKey(event)">Payment</button>
            <button type="button" id="opr-tab-receivingAccounts" role="tab" data-opr-tab="receivingAccounts" aria-controls="oprBreakdownBody" onclick="OpenPlayReporting.setBreakdown('receivingAccounts')" onkeydown="OpenPlayReporting.handleBreakdownKey(event)">Received</button>
            <button type="button" id="opr-tab-monthlyTrend" role="tab" data-opr-tab="monthlyTrend" aria-controls="oprBreakdownBody" onclick="OpenPlayReporting.setBreakdown('monthlyTrend')" onkeydown="OpenPlayReporting.handleBreakdownKey(event)">Trend</button>
          </div>
        </div>
        <div id="oprBreakdownBody" role="tabpanel" tabindex="0">${breakdownBody(report)}</div>
      </div>
    </section>`;
    syncBreakdownTabs();
  }

  function syncBreakdownTabs() {
    document.querySelectorAll('[data-opr-tab]').forEach(button => {
      const active = button.dataset.oprTab === state.breakdown;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.setAttribute('tabindex', active ? '0' : '-1');
    });
    const panel = byId('oprBreakdownBody');
    if (panel) panel.setAttribute('aria-labelledby', `opr-tab-${state.breakdown}`);
  }

  function handleBreakdownKey(event) {
    if (!event || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('[data-opr-tab]')];
    if (!tabs.length) return;
    const current = Math.max(0, tabs.indexOf(event.currentTarget));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
      ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    const key = tabs[next]?.dataset?.oprTab;
    setBreakdown(key);
    tabs[next]?.focus?.();
  }

  function setBreakdown(key) {
    state.breakdown = VALID_BREAKDOWNS.has(key) ? key : 'sessions';
    const body = byId('oprBreakdownBody');
    if (body && state.report) body.innerHTML = breakdownBody(state.report);
    syncBreakdownTabs();
  }

  async function renderReport(range = {}) {
    if (global.PB_TENANT_CONFIG?.adminOpenPlayEnabled === false) return false;
    const host = byId('openPlayReportMount');
    if (!host) return false;
    const from = String(range.from || '');
    const to = String(range.to || '');
    state.reportRange = { from, to };
    state.report = null;
    const sequence = ++state.reportSequence;
    host.innerHTML = reportShell();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      reportUnavailable('Choose a finite date range before using Open Play accounting.');
      return false;
    }
    if (typeof global.DB?.getManagerOpenPlayReport !== 'function') {
      reportUnavailable('Deploy the protected Open Play reporting contract before using accounting totals.', true);
      return false;
    }
    try {
      const report = await global.DB.getManagerOpenPlayReport({ from, to });
      if (sequence !== state.reportSequence) return false;
      if (!report?.complete) {
        reportUnavailable('The server could not prove this Open Play report complete. Narrow the range and retry.');
        return false;
      }
      state.report = report;
      renderReportResult(report);
      return true;
    } catch (error) {
      if (sequence !== state.reportSequence) return false;
      console.error('Open Play report failed:', error);
      const unsupported = ['OPEN_PLAY_REPORT_UNSUPPORTED', 'UNKNOWN_ACTION', 'NOT_IMPLEMENTED'].includes(String(error?.code || '').toUpperCase()) || error?.httpStatus === 404;
      reportUnavailable(
        unsupported
          ? 'The tenant frontend is ready, but the protected Open Play report action must be deployed first.'
          : 'Court-booking reports remain available. Retry Open Play accounting separately.',
        unsupported
      );
      return false;
    }
  }

  function retryReport() {
    return renderReport(state.reportRange || {});
  }

  function csvCell(value) {
    const raw = String(value ?? '');
    const safe = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  function downloadCsv(headers, rows) {
    const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    const tenant = String(global.PB_TENANT_SLUG || 'tenant').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    link.href = url;
    link.download = `${tenant}_open_play_report_${manilaDateKey()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportRow(row) {
    return [
      'Open Play',
      row.reference || '',
      row.sessionTitle || row.title || 'Open Play',
      row.sessionDate || row.date || '',
      row.startsAt || '',
      Array.isArray(row.courtNames) ? row.courtNames.join(' + ') : row.courts || '',
      Math.max(0, integer(row.quantity)),
      Math.max(0, finite(row.venueSubtotal ?? row.subtotal)),
      Math.max(0, finite(row.serviceFee ?? row.serviceFees)),
      Math.max(0, finite(row.customerTotal ?? row.total)),
      Math.max(0, finite(row.grossCollected)),
      row.paymentMethod || '',
      row.receivingAccount || '',
      row.paymentStatus || '',
      row.registrationStatus || row.status || '',
      Math.max(0, finite(row.refundLiability)),
      Math.max(0, finite(row.refundsCompleted ?? row.refundCompleted)),
      Math.max(0, finite(row.netCollected)),
    ];
  }

  async function exportCSV() {
    if (state.exportInFlight) return false;
    const range = state.reportRange;
    if (!state.report?.complete || !range?.from || !range?.to) {
      notify('Load a complete Open Play report before exporting.', 'err');
      return false;
    }
    if (typeof global.DB?.getManagerOpenPlayReport !== 'function') {
      notify('Protected Open Play export is not available.', 'err');
      return false;
    }
    state.exportInFlight = true;
    const exportButton = byId('rpExportOpenPlay');
    if (exportButton) exportButton.disabled = true;
    try {
      const rows = [];
      const cursors = new Set();
      const registrationIds = new Set();
      let cursor = '';
      for (let page = 0; page < 1000; page += 1) {
        const report = await global.DB.getManagerOpenPlayReport({
          from: range.from,
          to: range.to,
          cursor: cursor || undefined,
          pageSize: 200,
          includeRows: true,
        });
        if (!report?.complete) throw new Error('The Open Play export is incomplete.');
        for (const row of Array.isArray(report.rows) ? report.rows : []) {
          if (!row?.registrationId || registrationIds.has(row.registrationId)) {
            throw new Error('The Open Play export contained overlapping pages.');
          }
          registrationIds.add(row.registrationId);
          rows.push(row);
        }
        const next = String(report.pagination?.nextCursor || '');
        const hasMore = report.pagination?.hasMore === true;
        if (!hasMore) break;
        if (!next || cursors.has(next)) throw new Error('The Open Play export cursor repeated.');
        cursors.add(next);
        cursor = next;
        if (page === 999) throw new Error('The Open Play export exceeded its safe page limit.');
      }
      if (!rows.length) {
        notify('No Open Play registration rows are available for this period.', 'inf');
        return false;
      }
      downloadCsv([
        'Source', 'Registration Ref', 'Session', 'Session Date', 'Starts At', 'Court(s)', 'Quantity',
        'Venue Subtotal', 'Service Fee', 'Customer Total', 'Gross Collected', 'Payment Method',
        'Money Received To', 'Payment Status', 'Registration Status', 'Refund Liability',
        'Refunds Completed', 'Net Collected',
      ], rows.map(exportRow));
      notify('Open Play report exported.', 'ok');
      return true;
    } catch (error) {
      console.error('Open Play export failed:', error);
      notify(error?.message || 'Open Play report export failed.', 'err');
      return false;
    } finally {
      state.exportInFlight = false;
      if (exportButton) exportButton.disabled = false;
    }
  }

  function mount() {
    if (global.PB_TENANT_CONFIG?.adminOpenPlayEnabled === false) {
      ['openPlayDashboardMount', 'openPlayReportMount', 'rp-source-openplay', 'rpExportOpenPlay'].forEach(id => {
        if (byId(id)) byId(id).hidden = true;
      });
      return false;
    }
    state.mounted = Boolean(byId('openPlayDashboardMount') || byId('openPlayReportMount'));
    if (byId('openPlayDashboardMount')) byId('openPlayDashboardMount').innerHTML = dashboardShell('Open Play loads independently from court bookings.');
    if (byId('openPlayReportMount')) byId('openPlayReportMount').innerHTML = reportShell();
    return state.mounted;
  }

  function getState() {
    return Object.freeze({
      mounted: state.mounted,
      reportComplete: state.report?.complete === true,
      reportRange: state.reportRange ? { ...state.reportRange } : null,
      breakdown: state.breakdown,
      exportInFlight: state.exportInFlight,
    });
  }

  global.OpenPlayReporting = Object.freeze({
    mount,
    renderDashboard,
    renderReport,
    retryReport,
    setBreakdown,
    handleBreakdownKey,
    exportCSV,
    getState,
  });
})(window);
