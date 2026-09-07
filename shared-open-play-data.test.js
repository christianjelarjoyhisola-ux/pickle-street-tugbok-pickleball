const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'open-play-data.js'), 'utf8');
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const REGISTRATION_ID = '123e4567-e89b-42d3-a456-426614174001';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174002';

function session(overrides = {}) {
  return {
    id: SESSION_ID,
    version: 2,
    title: 'Saturday Social',
    date: '2026-08-15',
    startsAt: '2026-08-15T10:00:00.000Z',
    endsAt: '2026-08-15T13:00:00.000Z',
    courtIds: ['123e4567-e89b-42d3-a456-426614174010'],
    courtNames: ['Court 1'],
    pricePerPerson: 250,
    serviceFeePerPerson: 10,
    currency: 'PHP',
    capacity: 16,
    confirmedCount: 7,
    heldCount: 2,
    spotsRemaining: 7,
    paymentReviewCount: 1,
    collectedTotal: 1750,
    status: 'published',
    skillLevel: 'All levels',
    notes: 'Arrive 15 minutes early.',
    ...overrides,
  };
}

function registration(overrides = {}) {
  return {
    id: REGISTRATION_ID,
    reference: 'OP-ABC123',
    accessToken: 'opaque-capability-token',
    sessionId: SESSION_ID,
    quantity: 2,
    unitPrice: 250,
    subtotal: 500,
    serviceFee: 20,
    total: 520,
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    expiresAt: '2026-08-15T09:15:00.000Z',
    ...overrides,
  };
}

function reportPayload(overrides = {}) {
  const financials = {
    venueSales: 250,
    serviceFees: 10,
    grossCollected: 260,
    refundsCompleted: 0,
    netCollected: 260,
  };
  return {
    ok: true,
    tenantSlug: 'qdink-garage',
    timezone: 'Asia/Manila',
    range: { from: '2026-08-01', to: '2026-08-31' },
    complete: true,
    serverTime: '2026-08-31T23:00:00+08:00',
    summary: {
      sessionsHeld: 1,
      sessionsScheduled: 0,
      sessionsCancelled: 0,
      totalCapacity: 16,
      paidSpots: 1,
      heldSpots: 0,
      checkedInPlayers: 1,
      occupancyRate: 6.25,
      ...financials,
      paymentReviewCount: 0,
      paymentReviewAmount: 0,
      refundLiability: 0,
      anomalyCount: 0,
      currency: 'PHP',
    },
    breakdowns: {
      sessions: [{
        id: SESSION_ID,
        title: 'Saturday Social',
        date: '2026-08-15',
        startsAt: '2026-08-15T18:00:00+08:00',
        status: 'completed',
        courtNames: ['Court 1'],
        capacity: 16,
        paidSpots: 1,
        checkedInPlayers: 1,
        ...financials,
      }],
      paymentMethods: [{ key: 'gcash', label: 'GCash', amount: 260 }],
      receivingAccounts: [{ key: 'gcash-main', label: 'GCash · 0917', amount: 260 }],
      monthlyTrend: [{ period: '2026-08', label: 'Aug 2026', ...financials }],
    },
    rows: [],
    pagination: { nextCursor: null, hasMore: false },
    ...overrides,
  };
}

function loadClient({
  enabled = true,
  serverEnabled = true,
  fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }),
} = {}) {
  const sandbox = {
    AbortController,
    FormData,
    URL,
    clearTimeout,
    fetch: fetchImpl,
    setTimeout,
    window: {
      PB_TENANT_CONFIG: {
        tenantSlug: 'qdink-garage',
        supabaseUrl: 'https://example.supabase.co',
        supabasePublishableKey: 'public-key',
        openPlayEnabled: enabled,
      },
      PB_PLATFORM_V1: true,
      PB_SUPABASE_CONFIGURED: true,
      PB_PLATFORM_READINESS: { openPlayEnabled: serverEnabled },
      DB: {},
      _supabase: {
        auth: {
          getSession: async () => ({ data: { session: { access_token: 'manager-token' } } }),
        },
      },
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'open-play-data.js' });
  return sandbox.window;
}

test('Open Play remains double-gated by the tenant request and protected readiness', async () => {
  const notRequested = loadClient({ enabled: false, serverEnabled: true });
  assert.equal(await notRequested.OpenPlayData.syncReadiness(), false);
  assert.equal(notRequested.PB_OPEN_PLAY_SERVER_ENABLED, false);

  const notReady = loadClient({ enabled: true, serverEnabled: false });
  assert.equal(await notReady.OpenPlayData.syncReadiness(), false);
  assert.equal(notReady.PB_OPEN_PLAY_SERVER_ENABLED, false);

  const ready = loadClient();
  assert.equal(await ready.OpenPlayData.syncReadiness(), true);
  assert.equal(ready.PB_OPEN_PLAY_SERVER_ENABLED, true);
});

test('session DTO validation accepts one or two shared courts and fails closed', () => {
  const client = loadClient();
  const normalized = client.OpenPlayData.normalizeSession(session(), { manager: true });
  assert.equal(normalized.title, 'Saturday Social');
  assert.equal(normalized.spotsRemaining, 7);
  assert.equal(normalized.courtIds.length, 1);
  assert.equal(normalized.serviceFeePerPerson, 10);
  assert.equal(client.OpenPlayData.normalizeSession(session({
    refundRequiredCount: 0,
    refundRequiredTotal: 0,
    refundReviewRequiredCount: 2,
    refundReviewRequiredTotal: 1040,
  })).refundReviewRequiredTotal, 1040);
  const refundQueues = client.OpenPlayData.normalizeSession(session({
    refundRequiredCount: 0,
    refundRequiredTotal: 0,
    refundReviewRequiredCount: 2,
    refundReviewRequiredTotal: 1040,
  }));
  assert.equal(refundQueues.refundRequiredCount, 0);
  assert.equal(refundQueues.refundRequiredTotal, 0);
  assert.equal(refundQueues.refundReviewRequiredCount, 2);
  assert.equal(refundQueues.refundReviewRequiredTotal, 1040);

  assert.equal(client.OpenPlayData.normalizeSession(session({ courtIds: [] }), { manager: true }), null);
  assert.equal(client.OpenPlayData.normalizeSession(session({ courtNames: ['A', 'B', 'C'] })), null);
  assert.equal(client.OpenPlayData.normalizeSession(session({ capacity: 0 })), null);
  assert.equal(client.OpenPlayData.normalizeSession(session({ endsAt: session().startsAt })), null);
  assert.equal(client.OpenPlayData.normalizeSession(session({ status: 'mystery' })), null);
});

test('payment methods are digital, configured, and HTTPS-only', () => {
  const client = loadClient();
  const normalize = client.OpenPlayData.normalizePaymentMethod;
  assert.equal(normalize({
    code: 'gcash',
    displayName: 'GCash',
    accountName: 'Q Dink',
    accountReference: '09171234567',
    qrImageUrl: 'https://cdn.example.com/qr.png',
  }).code, 'gcash');
  assert.equal(normalize({
    code: 'cash',
    accountName: 'Front Desk',
    accountReference: 'Counter',
  }), null);
  assert.equal(normalize({
    code: 'maya',
    accountName: '',
    accountReference: '09171234567',
  }), null);
});

test('registration DTO validation keeps opaque access separate from customer data', () => {
  const client = loadClient();
  const normalized = client.OpenPlayData.normalizeRegistration(registration(), { requireAccess: true });
  assert.equal(normalized.reference, 'OP-ABC123');
  assert.equal(normalized.quantity, 2);
  assert.equal(normalized.total, 520);
  assert.equal(normalized.serviceFee, 20);
  assert.equal(Object.hasOwn(normalized, 'customer'), false);
  const refund = client.OpenPlayData.normalizeRegistration(registration({
    status: 'cancelled',
    paymentStatus: 'paid',
    statusReason: 'Session cancelled by venue.',
    refundRequired: true,
    refundReviewRequired: true,
    refundLiability: { amount: 520, currency: 'PHP', status: 'pending' },
    remittancePrepared: true,
  }));
  assert.equal(refund.statusReason, 'Session cancelled by venue.');
  assert.equal(refund.refundRequired, true);
  assert.equal(refund.refundReviewRequired, true);
  assert.equal(refund.refundLiability.amount, 520);
  assert.equal(refund.remittancePrepared, true);
  const stringLiability = client.OpenPlayData.normalizeRegistration(registration({
    status: 'cancelled',
    paymentStatus: 'paid',
    refundLiability: 'possible',
    refundStatus: 'required',
  }));
  assert.equal(stringLiability.refundLiability, 'possible');
  assert.equal(stringLiability.refundStatus, 'required');
  const completed = client.OpenPlayData.normalizeRegistration(registration({
    status: 'confirmed',
    paymentStatus: 'paid',
    session: session({
      date: '2020-01-01',
      startsAt: '2020-01-01T10:00:00.000Z',
      endsAt: '2020-01-01T13:00:00.000Z',
    }),
  }));
  assert.equal(completed.status, 'completed');
  assert.equal(client.OpenPlayData.normalizeRegistration(registration({ quantity: 5 })), null);
  assert.equal(client.OpenPlayData.normalizeRegistration(registration({ accessToken: '' }), { requireAccess: true }), null);
});

test('receipt references are constrained to backend printable ASCII length', () => {
  assert.match(source, /\/\^\[\\x20-\\x7E\]\{1,64\}\$\//);
  assert.match(source, /asText\(paymentReference,\s*64\)/);
  assert.doesNotMatch(source, /X-Payment-Reference': asText\(paymentReference,\s*120\)/);
});

test('public reservation uses the protected Edge endpoint with Turnstile and idempotency', async () => {
  let request;
  const client = loadClient({
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          serverTime: '2026-08-15T09:00:00.000Z',
          registration: registration(),
          paymentMethods: [{
            code: 'gcash',
            displayName: 'GCash',
            accountName: 'Q Dink',
            accountReference: '09171234567',
          }],
        }),
      };
    },
  });
  const result = await client.DB.createPublicOpenPlayRegistration({
    sessionId: SESSION_ID,
    quantity: 2,
    customer: { name: 'Player One', email: 'player@example.com', phone: '09171234567' },
    clientRequestId: REQUEST_ID,
    turnstileToken: 'verified-turnstile-token',
  });
  assert.match(request.url, /\/functions\/v1\/open-play-public\?tenantSlug=qdink-garage$/);
  assert.equal(request.body.action, 'reserve');
  assert.equal(request.body.tenantSlug, 'qdink-garage');
  assert.equal(request.body.clientRequestId, REQUEST_ID);
  assert.equal(request.body.turnstileToken, 'verified-turnstile-token');
  assert.equal(request.init.headers.Authorization, 'Bearer public-key');
  assert.equal(result.registration.reference, 'OP-ABC123');
  assert.equal(result.paymentMethods.length, 1);
  assert.equal(result.serverTime, '2026-08-15T09:00:00.000Z');
});

test('public list and mutation envelopes preserve authoritative server time', async () => {
  const serverTime = '2026-08-15T09:00:00.000Z';
  const client = loadClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const payload = body.action === 'list'
        ? { ok: true, serverTime, sessions: [session()] }
        : { ok: true, serverTime, registration: registration({ status: 'cancelled' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    },
  });
  const listed = await client.DB.getPublicOpenPlaySessions();
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.serverTime, serverTime);
  const cancelled = await client.DB.cancelPublicOpenPlayRegistration({
    reference: 'OP-ABC123',
    accessToken: 'opaque-capability-token',
    clientRequestId: REQUEST_ID,
  });
  assert.equal(cancelled.registration.status, 'cancelled');
  assert.equal(cancelled.serverTime, serverTime);
  assert.match(source, /return \{ registration, serverTime: asText\(payload\.serverTime, 40\) \}/);
});

test('existing registration recovery stays available when new reservations are paused', async () => {
  let request;
  const client = loadClient({
    serverEnabled: false,
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          registration: registration(),
          paymentMethods: [{
            code: 'gcash',
            displayName: 'GCash',
            accountName: 'Q Dink',
            accountReference: '09171234567',
          }],
        }),
      };
    },
  });

  const result = await client.DB.getPublicOpenPlayRegistrationStatus({
    reference: 'OP-ABC123',
    accessToken: 'opaque-capability-token',
  });
  assert.equal(request.body.action, 'status');
  assert.equal(result.registration.reference, 'OP-ABC123');
  assert.equal(result.paymentMethods[0].code, 'gcash');
  await assert.rejects(
    client.DB.createPublicOpenPlayRegistration({
      sessionId: SESSION_ID,
      quantity: 1,
      customer: { name: 'Player One', email: 'player@example.com', phone: '09171234567' },
      clientRequestId: REQUEST_ID,
      turnstileToken: 'verified-turnstile-token',
    }),
    /not available yet/i
  );
});

test('manager methods require the signed-in bearer and never call raw Open Play tables', async () => {
  let request;
  const client = loadClient({
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, sessions: [session()] }),
      };
    },
  });
  const sessions = await client.DB.getManagerOpenPlaySessions({ scope: 'upcoming' });
  assert.match(request.url, /\/functions\/v1\/open-play-manager/);
  assert.equal(request.init.headers.Authorization, 'Bearer manager-token');
  assert.equal(request.body.action, 'list_sessions');
  assert.equal(sessions.length, 1);
  assert.doesNotMatch(source, /\.from\(['"]open_play/);
});

test('manager Open Play report uses a protected tenant and Asia/Manila range contract', async () => {
  let request;
  const client = loadClient({
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(reportPayload()),
      };
    },
  });
  const report = await client.DB.getManagerOpenPlayReport({
    from: '2026-08-01',
    to: '2026-08-31',
  });
  assert.match(request.url, /\/functions\/v1\/open-play-manager/);
  assert.equal(request.init.headers.Authorization, 'Bearer manager-token');
  assert.equal(request.body.action, 'report_summary');
  assert.equal(request.body.tenantSlug, 'qdink-garage');
  assert.equal(request.body.timezone, 'Asia/Manila');
  assert.equal(request.body.from, '2026-08-01');
  assert.equal(request.body.to, '2026-08-31');
  assert.equal(request.body.includeRows, false);
  assert.equal(request.body.pageSize, 100);
  assert.equal(Object.hasOwn(request.body, 'cursor'), false);
  assert.equal(report.tenantSlug, 'qdink-garage');
  assert.equal(report.complete, true);
  assert.equal(report.serverTime, '2026-08-31T23:00:00+08:00');
  assert.equal(report.summary.grossCollected, 260);
  assert.equal(report.summary.netCollected, 260);
  assert.equal(report.breakdowns.sessions[0].courtNames[0], 'Court 1');
  assert.equal(report.breakdowns.monthlyTrend[0].period, '2026-08');
  assert.equal(report.rows.length, 0);
  assert.equal(report.pagination.hasMore, false);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.summary), true);
});

test('manager Open Play report rejects invalid Manila dates and paging before network access', async () => {
  let fetchCount = 0;
  const client = loadClient({
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(reportPayload()) };
    },
  });
  await assert.rejects(
    client.DB.getManagerOpenPlayReport({ from: '2026-02-30', to: '2026-03-01' }),
    /valid Open Play report date range/i
  );
  await assert.rejects(
    client.DB.getManagerOpenPlayReport({ from: '2026-08-31', to: '2026-08-01' }),
    /valid Open Play report date range/i
  );
  await assert.rejects(
    client.DB.getManagerOpenPlayReport({ from: '2026-08-01', to: '2026-08-31', pageSize: 501 }),
    /valid Open Play report date range/i
  );
  await assert.rejects(
    client.DB.getManagerOpenPlayReport({ from: '2025-01-01', to: '2026-08-31' }),
    /valid Open Play report date range/i
  );
  await assert.rejects(
    client.DB.getManagerOpenPlayReport({
      from: '2026-08-01',
      to: '2026-08-31',
      cursor: 'next-page',
    }),
    /valid Open Play report date range/i
  );
  assert.equal(fetchCount, 0);
});

test('manager Open Play report normalizes non-personal export rows and safe pagination', async () => {
  let request;
  const row = {
    registrationId: REGISTRATION_ID,
    reference: 'OP-ABC123',
    sessionId: SESSION_ID,
    sessionTitle: 'Saturday Social',
    sessionDate: '2026-08-15',
    startsAt: '2026-08-15T18:00:00+08:00',
    courtNames: ['Court 1'],
    quantity: 1,
    registrationStatus: 'confirmed',
    paymentStatus: 'paid',
    paymentMethod: 'GCash',
    receivingAccount: 'GCash · 0917',
    venueSubtotal: 250,
    serviceFee: 10,
    customerTotal: 260,
    grossCollected: 260,
    refundLiability: 0,
    refundsCompleted: 0,
    netCollected: 260,
    currency: 'PHP',
    createdAt: '2026-08-10T09:00:00+08:00',
    paidAt: '2026-08-10T09:05:00+08:00',
    checkedInAt: '',
  };
  const client = loadClient({
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(reportPayload({
          rows: [row],
          pagination: { nextCursor: 'page-2', hasMore: true },
        })),
      };
    },
  });
  const report = await client.DB.getManagerOpenPlayReport({
    from: '2026-08-01',
    to: '2026-08-31',
    includeRows: true,
    pageSize: 25,
  });
  assert.equal(request.includeRows, true);
  assert.equal(request.pageSize, 25);
  assert.equal(report.rows[0].registrationId, REGISTRATION_ID);
  assert.equal(report.rows[0].venueSubtotal, 250);
  assert.equal(report.rows[0].customerTotal, 260);
  assert.equal(report.rows[0].netCollected, 260);
  assert.equal(Object.hasOwn(report.rows[0], 'customer'), false);
  assert.equal(report.pagination.nextCursor, 'page-2');
});

test('manager Open Play report fails closed on identity, accounting, and repeated cursors', async () => {
  const cases = [
    reportPayload({ tenantSlug: 'another-tenant' }),
    reportPayload({ timezone: 'UTC' }),
    reportPayload({ complete: 'yes' }),
    reportPayload({ serverTime: 'not-a-time' }),
    reportPayload({ range: { from: '2026-07-01', to: '2026-08-31' } }),
    reportPayload({
      summary: { ...reportPayload().summary, grossCollected: 999 },
    }),
    reportPayload({ pagination: { nextCursor: 'same-cursor', hasMore: true } }),
  ];
  for (const payload of cases) {
    const client = loadClient({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      }),
    });
    const options = {
      from: '2026-08-01',
      to: '2026-08-31',
      ...(payload.pagination?.nextCursor === 'same-cursor'
        ? { includeRows: true, cursor: 'same-cursor' }
        : {}),
    };
    await assert.rejects(client.DB.getManagerOpenPlayReport(options), /report response was invalid/i);
  }
});

test('manager Open Play report rejects contradictory capacity, occupancy, refunds, and breakdown totals', async () => {
  const contradictions = [
    payload => { payload.summary.paidSpots = payload.summary.totalCapacity + 1; },
    payload => { payload.summary.occupancyRate = 12.34; },
    payload => {
      payload.summary.refundsCompleted = payload.summary.grossCollected + 1;
      payload.summary.netCollected = 0;
    },
    payload => { payload.breakdowns.sessions[0].grossCollected += 1; },
    payload => { payload.breakdowns.paymentMethods[0].amount += 1; },
    payload => { payload.breakdowns.monthlyTrend[0].period = '2026-07'; },
  ];
  for (const contradict of contradictions) {
    const response = reportPayload();
    contradict(response);
    const client = loadClient({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(response),
      }),
    });
    await assert.rejects(
      client.DB.getManagerOpenPlayReport({ from: '2026-08-01', to: '2026-08-31' }),
      /report response was invalid/i,
    );
  }
});

test('manager Open Play report preserves an explicit incomplete result for fail-closed UI handling', async () => {
  const client = loadClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(reportPayload({ complete: false })),
    }),
  });
  const report = await client.DB.getManagerOpenPlayReport({
    from: '2026-08-01',
    to: '2026-08-31',
  });
  assert.equal(report.complete, false);
  assert.equal(report.summary.sessionsHeld, 1);
});
