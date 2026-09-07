const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function report(overrides = {}) {
  return {
    complete: true,
    tenantSlug: 'qdink-garage',
    timezone: 'Asia/Manila',
    range: { from: '2026-08-01', to: '2026-08-31' },
    serverTime: '2026-08-31T23:00:00+08:00',
    summary: {
      sessionsHeld: 1,
      sessionsScheduled: 0,
      sessionsCancelled: 0,
      totalCapacity: 16,
      paidSpots: 12,
      heldSpots: 2,
      checkedInPlayers: 10,
      occupancyRate: 75,
      venueSales: 3000,
      serviceFees: 120,
      grossCollected: 3120,
      paymentReviewCount: 2,
      paymentReviewAmount: 520,
      refundLiability: 260,
      refundsCompleted: 260,
      netCollected: 2860,
      anomalyCount: 0,
      currency: 'PHP',
    },
    breakdowns: {
      sessions: [{
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Saturday Social',
        date: '2026-08-15',
        startsAt: '2026-08-15T18:00:00+08:00',
        status: 'completed',
        courtNames: ['Court 1', 'Court 2'],
        capacity: 16,
        paidSpots: 12,
        checkedInPlayers: 10,
        venueSales: 3000,
        serviceFees: 120,
        grossCollected: 3120,
        refundsCompleted: 260,
        netCollected: 2860,
      }],
      paymentMethods: [{ key: 'gcash', label: 'GCash', amount: 3120 }],
      receivingAccounts: [{ key: 'main', label: 'Main GCash', amount: 3120 }],
      monthlyTrend: [{
        period: '2026-08', label: 'Aug 2026', venueSales: 3000, serviceFees: 120,
        grossCollected: 3120, refundsCompleted: 260, netCollected: 2860,
      }],
    },
    rows: [],
    pagination: { nextCursor: null, hasMore: false },
    ...overrides,
  };
}

function loadReporting({ sessions = [], reportResult = report(), reportError = null } = {}) {
  const nodes = new Map([
    ['openPlayDashboardMount', { innerHTML: '', hidden: false }],
    ['openPlayReportMount', { innerHTML: '', hidden: false }],
    ['rpExportOpenPlay', { disabled: false, hidden: false }],
  ]);
  const context = {
    console: { error() {} },
    Date,
    Intl,
    Blob,
    setTimeout,
    clearTimeout,
    PB_TENANT_SLUG: 'qdink-garage',
    toast() {},
    goto() {},
    DB: {
      async getManagerOpenPlaySessions() { return sessions; },
      async getManagerOpenPlayReport() {
        if (reportError) throw reportError;
        return reportResult;
      },
    },
    URL: {
      createObjectURL() { return 'blob:report'; },
      revokeObjectURL() {},
    },
    document: {
      getElementById(id) { return nodes.get(id) || null; },
      querySelectorAll() { return []; },
      createElement() { return { click() {}, remove() {} }; },
      body: { appendChild() {} },
    },
  };
  context.window = context;
  vm.runInNewContext(read('open-play-reporting.js'), context, { filename: 'open-play-reporting.js' });
  return { api: context.OpenPlayReporting, nodes };
}

test('admin integrates separate Open Play dashboard and report sources as deployable assets', () => {
  const admin = read('admin.html');
  const published = require('./tools/site-files.cjs');
  const headers = read('_headers');
  const packageJson = JSON.parse(read('package.json'));

  assert.match(admin, /id="openPlayDashboardMount"/);
  assert.match(admin, /id="openPlayReportMount"/);
  assert.match(admin, /setReportSource\('overview'\)/);
  assert.match(admin, /setReportSource\('bookings'\)/);
  assert.match(admin, /setReportSource\('openplay'\)/);
  assert.match(admin, /Court Booking Value/);
  assert.match(admin, /OpenPlayReporting\?\.renderDashboard/);
  assert.match(admin, /OpenPlayReporting\?\.renderReport/);
  assert.match(admin, /open-play-reporting\.css\?v=20260803-openplay-reports/);
  assert.match(admin, /open-play-reporting\.js\?v=[^"\s]+/);
  assert.ok(published.includes('open-play-reporting.css'));
  assert.ok(published.includes('open-play-reporting.js'));
  assert.match(headers, /\/open-play-reporting\.js[\s\S]{0,80}Cache-Control: no-cache/);
  assert.match(headers, /\/open-play-reporting\.css[\s\S]{0,80}Cache-Control: no-cache/);
  assert.match(packageJson.scripts.check, /node tools\/check-site\.cjs/);
});

test('dashboard snapshot uses non-personal session aggregates and counts a two-court session once', async () => {
  const sessions = [{
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Saturday Social',
    date: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()),
    startsAt: new Date(Date.now() + 3600000).toISOString(),
    endsAt: new Date(Date.now() + 7200000).toISOString(),
    courtNames: ['Court 1', 'Court 2'],
    capacity: 16,
    confirmedCount: 8,
    heldCount: 2,
    paymentReviewCount: 1,
    collectedTotal: 2080,
    status: 'published',
  }];
  const { api, nodes } = loadReporting({ sessions });
  api.mount();
  assert.equal(await api.renderDashboard(), true);
  const html = nodes.get('openPlayDashboardMount').innerHTML;
  assert.match(html, /Open Play Today/);
  assert.match(html, />1<\/strong>/);
  assert.match(html, /10\/16/);
  assert.match(html, /Court 1 \+ Court 2/);
  assert.match(html, /₱2,080/);
  assert.doesNotMatch(html, /customerName|contactNumber|accessToken|receiptImageUrl/i);
});

test('complete Open Play report keeps venue sales, service fees, refunds, and net visibly separate', async () => {
  const { api, nodes } = loadReporting();
  api.mount();
  assert.equal(await api.renderReport({ from: '2026-08-01', to: '2026-08-31' }), true);
  const html = nodes.get('openPlayReportMount').innerHTML;
  assert.match(html, /Venue sales/);
  assert.match(html, /Service fees/);
  assert.match(html, /Gross collected/);
  assert.match(html, /Open refund liability/);
  assert.match(html, /Refunds completed/);
  assert.match(html, /Net collected/);
  assert.match(html, /Court 1 \+ Court 2/);
  assert.match(html, /12\/16/);
  assert.match(html, /75\.0%/);
  assert.equal((html.match(/Saturday Social/g) || []).length, 1);
  assert.equal(api.getState().reportComplete, true);
});

test('incomplete or unsupported Open Play accounting fails closed without hiding court reports', async () => {
  const incomplete = loadReporting({ reportResult: report({ complete: false }) });
  incomplete.api.mount();
  assert.equal(await incomplete.api.renderReport({ from: '2026-08-01', to: '2026-08-31' }), false);
  assert.match(incomplete.nodes.get('openPlayReportMount').innerHTML, /could not prove this Open Play report complete/i);
  assert.equal(incomplete.api.getState().reportComplete, false);

  const unsupportedError = Object.assign(new Error('unknown action'), { code: 'UNKNOWN_ACTION' });
  const unsupported = loadReporting({ reportError: unsupportedError });
  unsupported.api.mount();
  assert.equal(await unsupported.api.renderReport({ from: '2026-08-01', to: '2026-08-31' }), false);
  assert.match(unsupported.nodes.get('openPlayReportMount').innerHTML, /Protected reporting update required/);
  assert.match(unsupported.nodes.get('openPlayReportMount').innerHTML, /frontend is ready/i);
});

test('reporting UI is responsive, keyboard-visible, stale-safe, and exports no roster PII columns', () => {
  const source = read('open-play-reporting.js');
  const css = read('open-play-reporting.css');
  assert.match(source, /const sequence = \+\+state\.dashboardSequence/);
  assert.match(source, /const sequence = \+\+state\.reportSequence/);
  assert.match(source, /if \(sequence !== state\.reportSequence\)/);
  assert.match(source, /includeRows: true/);
  assert.match(source, /overlapping pages/);
  assert.match(source, /\^\[\\t\\r\\n \]\*\[=\+\\-@\]/);
  assert.match(source, /handleBreakdownKey/);
  assert.match(source, /'Source', 'Registration Ref', 'Session'/);
  assert.doesNotMatch(source, /'Customer Name'|'Email'|'Contact'|'Receipt URL'|'Access Token'/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /var\(--green2, var\(--green-dark\)\)/);
});
