(function configureOpenPlayAdmin(global) {
  'use strict';

  const state = {
    mounted: false,
    scope: 'upcoming',
    sessions: [],
    courts: [],
    editing: null,
    rosterSession: null,
    registrations: [],
    returnFocus: null,
    previousOverflow: '',
    backgroundState: [],
    renderSequence: 0,
    rosterSequence: 0,
    rosterMutations: new Set(),
    sessionMutations: new Set(),
    intentRequestIds: new Map(),
  };

  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const jsArg = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const safeHttpsUrl = value => {
    try {
      const url = new URL(String(value || '').trim());
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch (_) {
      return '';
    }
  };
  const money = value => new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
  }).format(Number(value || 0));
  const newRequestId = () => global.crypto?.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
      const random = Math.random() * 16 | 0;
      return (character === 'x' ? random : (random & 3 | 8)).toString(16);
    });

  function currentSession() {
    if (typeof sess !== 'undefined' && sess) return sess;
    return global.Auth?.getSession?.() || null;
  }

  function canMount() {
    const session = currentSession();
    return global.PB_TENANT_CONFIG?.openPlayEnabled === true &&
      global.PB_TENANT_CONFIG?.adminOpenPlayEnabled !== false &&
      global.Auth?.can?.('open_play_roster', session?.role);
  }

  function canManage() {
    const session = currentSession();
    return global.Auth?.can?.('open_play_manage', session?.role) === true;
  }

  function creationEnabled() {
    return canManage() && global.PB_OPEN_PLAY_SERVER_ENABLED === true;
  }

  function intentRequestId(key) {
    if (!state.intentRequestIds.has(key)) state.intentRequestIds.set(key, newRequestId());
    return state.intentRequestIds.get(key);
  }

  function resolveIntent(key) {
    state.intentRequestIds.delete(key);
  }

  function sessionHasEnded(session) {
    const end = Date.parse(session?.endsAt || '');
    return Number.isFinite(end) && end <= Date.now();
  }

  function notify(message, type = 'ok') {
    if (typeof global.toast === 'function') global.toast(message, type);
    const live = byId('opaLive');
    if (live) live.textContent = message;
  }

  function localParts(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value || '';
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${get('hour')}:${get('minute')}`,
    };
  }

  function dateLabel(value, options = {}) {
    const date = new Date(String(value || '').includes('T') ? value : `${value}T00:00:00+08:00`);
    if (Number.isNaN(date.getTime())) return 'Date unavailable';
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      month: options.short ? 'short' : 'long',
      day: 'numeric',
      year: options.year === false ? undefined : 'numeric',
      weekday: options.weekday ? 'short' : undefined,
    }).format(date);
  }

  function timeLabel(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '--';
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  }

  function dateTile(session) {
    const date = new Date(`${session.date}T00:00:00+08:00`);
    const month = new Intl.DateTimeFormat('en-PH', { month: 'short' }).format(date).toUpperCase();
    const day = new Intl.DateTimeFormat('en-PH', { day: '2-digit' }).format(date);
    return `<div class="opa-date-tile" aria-hidden="true"><span>${escapeHtml(month)}</span><strong>${escapeHtml(day)}</strong></div>`;
  }

  function percent(session) {
    const consumed = Math.max(0, Number(session.confirmedCount || 0) + Number(session.heldCount || 0));
    return Math.min(100, Math.round(consumed / Math.max(1, Number(session.capacity || 1)) * 100));
  }

  function sessionHtml(session) {
    const status = String(session.status || 'draft').toLowerCase();
    const occupied = Math.max(0, Number(session.confirmedCount || 0) + Number(session.heldCount || 0));
    const price = Math.max(0, Number(session.pricePerPerson || 0));
    const serviceFee = Math.max(0, Number(session.serviceFeePerPerson || 0));
    const canEdit = canManage() && !['cancelled', 'completed'].includes(status);
    const canCancel = canManage() && !['cancelled', 'completed'].includes(status) && !sessionHasEnded(session);
    const canDuplicate = canManage();
    const sessionBusy = state.sessionMutations.has(String(session.id));
    return `<article class="opa-session" data-session-id="${escapeHtml(session.id)}">
      <div class="opa-session-date">
        ${dateTile(session)}
        <div>
          <h4>${escapeHtml(dateLabel(session.date, { weekday: true }))}</h4>
          <div class="opa-session-sub">${escapeHtml(timeLabel(session.startsAt))}–${escapeHtml(timeLabel(session.endsAt))}</div>
          <span class="opa-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
          ${session.statusReason ? `<div class="opa-session-reason">${escapeHtml(session.statusReason)}</div>` : ''}
        </div>
      </div>
      <div>
        <h4>${escapeHtml(session.title || 'Open Play')}</h4>
        <div class="opa-session-courts">${escapeHtml((session.courtNames || []).join(' + '))}</div>
        <div class="opa-capacity">
          <div class="opa-capacity-line"><span>Player spots</span><strong>${occupied}/${Number(session.capacity || 0)}</strong></div>
          <div class="opa-progress" role="progressbar" aria-label="Session occupancy" aria-valuemin="0" aria-valuemax="${Number(session.capacity || 0)}" aria-valuenow="${occupied}"><span style="width:${percent(session)}%"></span></div>
        </div>
      </div>
      <div class="opa-session-money">
        <strong>${money(price + serviceFee)} / player</strong>
        <span>${money(price)} Open Play price</span>
        <span>${serviceFee > 0 ? `${money(serviceFee)} service fee` : 'No service fee'}</span>
        <span>${money(session.collectedTotal)} collected</span>
        <span class="${Number(session.paymentReviewCount || 0) ? 'opa-review-count' : ''}">${Number(session.paymentReviewCount || 0)} payment${Number(session.paymentReviewCount || 0) === 1 ? '' : 's'} to review</span>
        ${Number(session.refundRequiredCount || 0) > 0 || Number(session.refundRequiredTotal || 0) > 0
          ? `<span class="opa-refund-count">${Number(session.refundRequiredCount || 0)} confirmed refund liabilit${Number(session.refundRequiredCount || 0) === 1 ? 'y' : 'ies'} · ${money(session.refundRequiredTotal || 0)}</span>`
          : ''}
        ${Number(session.refundReviewRequiredCount || 0) > 0 || Number(session.refundReviewRequiredTotal || 0) > 0
          ? `<span class="opa-refund-review-count">${Number(session.refundReviewRequiredCount || 0)} payment evidence item${Number(session.refundReviewRequiredCount || 0) === 1 ? '' : 's'} requiring refund review · ${money(session.refundReviewRequiredTotal || 0)}</span>`
          : ''}
      </div>
      <div class="opa-session-actions">
        <button type="button" onclick="OpenPlayAdmin.openRoster('${jsArg(session.id)}')" ${sessionBusy ? 'disabled' : ''}>Roster</button>
        <button type="button" onclick="OpenPlayAdmin.openEditor('${jsArg(session.id)}')" ${canEdit && !sessionBusy ? '' : 'disabled'}>Edit</button>
        <button type="button" onclick="OpenPlayAdmin.duplicate('${jsArg(session.id)}')" ${canDuplicate && !sessionBusy ? '' : 'disabled'}>Duplicate</button>
        <button type="button" class="danger" onclick="OpenPlayAdmin.cancelSession('${jsArg(session.id)}')" ${canCancel && !sessionBusy ? '' : 'disabled'}>Cancel</button>
      </div>
    </article>`;
  }

  function renderMetrics() {
    const sessions = state.sessions;
    const consumed = sessions.reduce((sum, session) =>
      sum + Number(session.confirmedCount || 0) + Number(session.heldCount || 0), 0);
    const review = sessions.reduce((sum, session) => sum + Number(session.paymentReviewCount || 0), 0);
    const collected = sessions.reduce((sum, session) => sum + Number(session.collectedTotal || 0), 0);
    byId('opaMetricSessions').textContent = String(sessions.length);
    byId('opaMetricPlayers').textContent = String(consumed);
    byId('opaMetricReview').textContent = String(review);
    byId('opaMetricRevenue').textContent = money(collected);
  }

  function renderList() {
    const list = byId('opaSessionList');
    if (!list) return;
    renderMetrics();
    byId('opaListMeta').textContent = `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'}`;
    list.innerHTML = state.sessions.length
      ? state.sessions.map(sessionHtml).join('')
      : `<div class="opa-empty"><strong>No ${escapeHtml(state.scope)} Open Play sessions.</strong><br>Create a session when you are ready to publish player spots.</div>`;
  }

  async function render() {
    if (!canMount()) return;
    const sequence = ++state.renderSequence;
    const list = byId('opaSessionList');
    if (list) list.innerHTML = '<div class="opa-empty">Loading Open Play sessions…</div>';
    try {
      const sessions = await global.DB.getManagerOpenPlaySessions({ scope: state.scope });
      if (sequence !== state.renderSequence || !state.mounted) return;
      state.sessions = sessions;
      renderList();
    } catch (error) {
      if (sequence !== state.renderSequence || !state.mounted) return;
      if (list) list.innerHTML = `<div class="opa-error">${escapeHtml(error?.message || 'Open Play sessions could not be loaded.')}<br><button class="opa-button" type="button" onclick="OpenPlayAdmin.render()">Try again</button></div>`;
      notify(error?.message || 'Open Play sessions could not be loaded.', 'err');
    }
  }

  function shellHtml() {
    const createDisabled = creationEnabled()
      ? ''
      : ' disabled title="New Open Play sessions are paused until server readiness is restored."';
    const readinessNotice = creationEnabled()
      ? ''
      : '<p class="opa-readiness" role="status">New sessions are paused. Existing sessions, registrations, and payment reviews remain available.</p>';
    return `<div class="opa-page">
      <section class="opa-hero" aria-labelledby="opaPageTitle">
        <div class="opa-hero-copy">
          <div class="opa-eyebrow">Player sessions</div>
          <h3 id="opaPageTitle">Open Play</h3>
          <p>Publish one shared session across one or two courts, control the total player capacity, and manage every payment and check-in from one roster.</p>
          ${readinessNotice}
        </div>
        <div class="opa-hero-actions">
          <button class="opa-primary" type="button" onclick="OpenPlayAdmin.openEditor()"${createDisabled}>Create Open Play</button>
        </div>
      </section>
      <section class="opa-metrics" aria-label="Open Play summary">
        <div class="opa-metric"><span>Sessions</span><strong id="opaMetricSessions">0</strong></div>
        <div class="opa-metric"><span>Reserved spots</span><strong id="opaMetricPlayers">0</strong></div>
        <div class="opa-metric"><span>Payment review</span><strong id="opaMetricReview">0</strong></div>
        <div class="opa-metric"><span>Collected</span><strong id="opaMetricRevenue">${money(0)}</strong></div>
      </section>
      <div class="opa-toolbar">
        <div class="opa-filter" role="group" aria-label="Filter Open Play sessions">
          <button type="button" data-opa-scope="upcoming" class="active" onclick="OpenPlayAdmin.setScope('upcoming')">Upcoming</button>
          <button type="button" data-opa-scope="past" onclick="OpenPlayAdmin.setScope('past')">Previous</button>
          <button type="button" data-opa-scope="all" onclick="OpenPlayAdmin.setScope('all')">All</button>
        </div>
        <div class="opa-meta" id="opaListMeta">Loading sessions…</div>
      </div>
      <div class="opa-list" id="opaSessionList" aria-live="polite"></div>
      <div class="opa-live" id="opaLive" role="status" aria-live="polite"></div>
    </div>`;
  }

  function overlayHtml() {
    return `<div class="opa-overlay" id="opaEditorOverlay" hidden inert aria-hidden="true">
      <div class="opa-dialog" role="dialog" aria-modal="true" aria-labelledby="opaEditorTitle">
        <div class="opa-dialog-head">
          <div><div class="opa-eyebrow">Session setup</div><h3 id="opaEditorTitle">Create Open Play</h3><p id="opaEditorSubtitle">Set the schedule, courts, capacity, and Open Play price.</p></div>
          <button class="opa-icon-button" type="button" aria-label="Close session editor" onclick="OpenPlayAdmin.closeEditor()">&#10005;</button>
        </div>
        <form id="opaEditorForm" onsubmit="OpenPlayAdmin.submitEditor(event)">
          <div class="opa-dialog-body">
            <input id="opaSessionId" type="hidden">
            <input id="opaSessionVersion" type="hidden">
            <div class="opa-grid">
              <div class="opa-field full"><label for="opaTitle">Session title</label><input id="opaTitle" maxlength="120" required autocomplete="off" placeholder="Saturday Social Open Play"></div>
              <div class="opa-field"><label for="opaDate">Date</label><input id="opaDate" type="date" required></div>
              <div class="opa-field"><label for="opaStatus">Publish state</label><select id="opaStatus"><option value="draft">Save as draft</option><option value="published">Publish now</option></select></div>
              <div class="opa-field"><label for="opaStart">Start time</label><input id="opaStart" type="time" step="1800" required></div>
              <div class="opa-field"><label for="opaEnd">End time</label><input id="opaEnd" type="time" step="1800" required></div>
              <div class="opa-field full">
                <fieldset class="opa-courts" id="opaCourtOptions"><legend class="opa-field full">Courts — choose one or two</legend></fieldset>
                <div class="opa-help" id="opaCourtHelp">The selected courts will be unavailable for regular bookings for the entire session.</div>
              </div>
              <div class="opa-field"><label for="opaCapacity">Total player capacity</label><input id="opaCapacity" type="number" min="1" max="200" step="1" required inputmode="numeric"><div class="opa-help" id="opaCapacityHelp">Capacity is shared across all selected courts.</div></div>
              <div class="opa-field"><label for="opaPrice">Open Play price</label><input id="opaPrice" type="number" min="1" max="100000" step="0.01" required inputmode="decimal"><div class="opa-help">Price per player.</div></div>
              <div class="opa-field full"><label for="opaSkill">Skill level (optional)</label><input id="opaSkill" maxlength="80" placeholder="All levels, Beginner, Intermediate…"></div>
              <div class="opa-field full"><label for="opaNotes">Player instructions (optional)</label><textarea id="opaNotes" maxlength="2000" placeholder="Rotation format, arrival time, what to bring…"></textarea></div>
            </div>
            <div class="opa-preview" id="opaPreview" role="status">Complete the session details to see the player-facing summary.</div>
          </div>
          <div class="opa-dialog-foot">
            <button class="opa-button" type="button" onclick="OpenPlayAdmin.closeEditor()">Cancel</button>
            <button class="opa-button save" id="opaSaveButton" type="submit">Save session</button>
          </div>
        </form>
      </div>
    </div>
    <div class="opa-overlay" id="opaRosterOverlay" hidden inert aria-hidden="true">
      <div class="opa-dialog roster" role="dialog" aria-modal="true" aria-labelledby="opaRosterTitle">
        <div class="opa-dialog-head">
          <div><div class="opa-eyebrow">Session operations</div><h3 id="opaRosterTitle">Open Play roster</h3><p id="opaRosterSubtitle">Loading player registrations…</p></div>
          <button class="opa-icon-button" type="button" aria-label="Close roster" onclick="OpenPlayAdmin.closeRoster()">&#10005;</button>
        </div>
        <div class="opa-dialog-body" id="opaRosterBody"><div class="opa-empty">Loading roster…</div></div>
        <div class="opa-dialog-foot"><button class="opa-button" type="button" onclick="OpenPlayAdmin.closeRoster()">Close</button></div>
      </div>
    </div>`;
  }

  function tomorrow() {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function today() {
    const value = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const get = type => parts.find(part => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function addDays(dateValue, days) {
    const date = new Date(`${dateValue}T12:00:00+08:00`);
    if (Number.isNaN(date.getTime())) return tomorrow();
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  function renderCourtOptions(selected = []) {
    const holder = byId('opaCourtOptions');
    if (!holder) return;
    holder.innerHTML = '<legend>Courts — choose one or two</legend>' + state.courts.map(court => `
      <label class="opa-court-option">
        <input type="checkbox" name="opaCourt" value="${escapeHtml(court.id)}" ${selected.includes(String(court.id)) ? 'checked' : ''} onchange="OpenPlayAdmin.courtsChanged(this)">
        <span>${escapeHtml(court.name)}</span>
      </label>`).join('');
  }

  async function loadCourts() {
    const courts = await global.DB.getCourts();
    state.courts = (Array.isArray(courts) ? courts : []).filter(court =>
      !court.blocked && String(court.status || 'active').toLowerCase() === 'active'
    );
    return state.courts;
  }

  function chosenCourts() {
    return [...document.querySelectorAll('input[name="opaCourt"]:checked')].map(input => input.value);
  }

  function updatePreview() {
    const preview = byId('opaPreview');
    if (!preview) return;
    const title = byId('opaTitle')?.value.trim() || 'Open Play';
    const date = byId('opaDate')?.value;
    const start = byId('opaStart')?.value;
    const end = byId('opaEnd')?.value;
    const courtIds = chosenCourts();
    const courtNames = courtIds.map(id => state.courts.find(court => String(court.id) === id)?.name).filter(Boolean);
    const capacity = Number(byId('opaCapacity')?.value || 0);
    const price = Number(byId('opaPrice')?.value || 0);
    if (!date || !start || !end || !courtNames.length || !capacity || !price) {
      preview.textContent = 'Complete the session details to see the player-facing summary.';
      return;
    }
    const clock = value => {
      const [hourText, minute] = value.split(':');
      const hour = Number(hourText);
      return `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
    };
    preview.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(dateLabel(date, { weekday: true }))} · ${escapeHtml(clock(start))}–${escapeHtml(clock(end))}<br>${escapeHtml(courtNames.join(' + '))} · ${capacity} player spots · ${money(price)}/person`;
  }

  function openOverlay(id) {
    const overlay = byId(id);
    if (!overlay) return;
    state.returnFocus = document.activeElement;
    state.previousOverflow = document.body.style.overflow || '';
    state.backgroundState = Array.from(document.body.children)
      .filter(node => node !== overlay && node.nodeType === 1)
      .map(node => ({
        node,
        inert: node.inert === true,
        ariaHidden: node.getAttribute('aria-hidden'),
      }));
    state.backgroundState.forEach(item => {
      item.node.inert = true;
      item.node.setAttribute('aria-hidden', 'true');
    });
    overlay.hidden = false;
    overlay.inert = false;
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => overlay.querySelector('input:not([type="hidden"]),button,select,textarea')?.focus());
  }

  function closeOverlay(id) {
    const overlay = byId(id);
    if (!overlay) return;
    if (overlay.contains(document.activeElement)) document.activeElement.blur();
    overlay.hidden = true;
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    state.backgroundState.forEach(item => {
      if (!item.node?.isConnected) return;
      item.node.inert = item.inert;
      if (item.ariaHidden == null) item.node.removeAttribute('aria-hidden');
      else item.node.setAttribute('aria-hidden', item.ariaHidden);
    });
    state.backgroundState = [];
    document.body.style.overflow = state.previousOverflow;
    const focus = state.returnFocus;
    state.returnFocus = null;
    requestAnimationFrame(() => focus?.focus?.());
  }

  async function openEditor(id = '') {
    if (!canMount() || !canManage()) {
      notify('Your role can operate the roster but cannot create or edit sessions.', 'err');
      return;
    }
    if (!creationEnabled()) {
      notify('New session publishing is paused. Existing Open Play operations remain available.', 'err');
      return;
    }
    if (!state.courts.length) {
      try {
        await loadCourts();
      } catch (error) {
        notify(error?.message || 'Courts could not be loaded.', 'err');
        return;
      }
    }
    const session = id ? state.sessions.find(item => String(item.id) === String(id)) : null;
    if (id && !session) {
      notify('That session is no longer in the current list.', 'err');
      return;
    }
    state.editing = session;
    const starts = session ? localParts(session.startsAt) : null;
    const ends = session ? localParts(session.endsAt) : null;
    byId('opaEditorTitle').textContent = session ? 'Edit Open Play' : 'Create Open Play';
    byId('opaEditorSubtitle').textContent = session && Number(session.confirmedCount || 0) + Number(session.heldCount || 0) > 0
      ? 'Existing player prices remain snapshotted. Schedule and court changes still require server approval.'
      : 'Set the schedule, courts, capacity, and Open Play price.';
    byId('opaSessionId').value = session?.id || '';
    byId('opaSessionVersion').value = session?.version || '';
    byId('opaTitle').value = session?.title || '';
    byId('opaDate').value = session?.date || tomorrow();
    byId('opaDate').min = today();
    byId('opaStatus').value = session?.status === 'published' ? 'published' : 'draft';
    byId('opaStart').value = starts?.time || '18:00';
    byId('opaEnd').value = ends?.time || '21:00';
    byId('opaCapacity').value = session?.capacity || (state.courts.length > 1 ? 16 : 8);
    byId('opaCapacity').min = String(Math.max(1, Number(session?.confirmedCount || 0) + Number(session?.heldCount || 0)));
    byId('opaCapacityHelp').textContent = session
      ? `Capacity cannot be below ${Number(session.confirmedCount || 0) + Number(session.heldCount || 0)} currently consuming spots.`
      : 'Capacity is shared across all selected courts.';
    byId('opaPrice').value = session?.pricePerPerson || '';
    byId('opaSkill').value = session?.skillLevel || '';
    byId('opaNotes').value = session?.notes || '';
    renderCourtOptions((session?.courtIds || []).map(String));
    updatePreview();
    openOverlay('opaEditorOverlay');
  }

  function closeEditor() {
    closeOverlay('opaEditorOverlay');
    state.editing = null;
  }

  function courtsChanged(changed) {
    const checked = [...document.querySelectorAll('input[name="opaCourt"]:checked')];
    if (checked.length > 2) {
      changed.checked = false;
      notify('Choose no more than two courts.', 'err');
    }
    const selectedCount = chosenCourts().length;
    if (!state.editing && selectedCount && !byId('opaCapacity').dataset.touched) {
      byId('opaCapacity').value = String(selectedCount * 8);
    }
    updatePreview();
  }

  async function submitEditor(event) {
    event.preventDefault();
    if (!canMount() || !canManage()) return;
    if (!creationEnabled()) {
      notify('Session publishing is paused until server readiness is restored.', 'err');
      return;
    }
    const form = event.currentTarget;
    const selected = chosenCourts();
    const minimumCapacity = Math.max(1, Number(state.editing?.confirmedCount || 0) + Number(state.editing?.heldCount || 0));
    const capacity = Number(byId('opaCapacity').value);
    const price = Number(byId('opaPrice').value);
    const start = byId('opaStart').value;
    const end = byId('opaEnd').value;
    if (!form.reportValidity()) return;
    if (![1, 2].includes(selected.length)) {
      notify('Choose exactly one or two courts.', 'err');
      byId('opaCourtHelp').focus?.();
      return;
    }
    if (end <= start) {
      notify('End time must be later than start time.', 'err');
      byId('opaEnd').focus();
      return;
    }
    if (!Number.isInteger(capacity) || capacity < minimumCapacity || capacity > 200) {
      notify(`Capacity must be a whole number from ${minimumCapacity} to 200.`, 'err');
      byId('opaCapacity').focus();
      return;
    }
    if (!Number.isFinite(price) || price <= 0 || price > 100000) {
      notify('Enter a valid price per player.', 'err');
      byId('opaPrice').focus();
      return;
    }
    const button = byId('opaSaveButton');
    const original = button.textContent;
    const wasEditing = !!state.editing;
    button.disabled = true;
    button.textContent = 'Saving…';
    const sessionPayload = {
        id: byId('opaSessionId').value || null,
        title: byId('opaTitle').value.trim(),
        date: byId('opaDate').value,
        startTime: start,
        endTime: end,
        courtIds: selected,
        capacity,
        pricePerPerson: Math.round(price * 100) / 100,
        currency: 'PHP',
        skillLevel: byId('opaSkill').value.trim(),
        notes: byId('opaNotes').value.trim(),
        status: byId('opaStatus').value,
      };
    const intentKey = `save:${sessionPayload.id || 'new'}:${JSON.stringify(sessionPayload)}`;
    try {
      await global.DB.saveOpenPlaySession(sessionPayload, {
        expectedVersion: byId('opaSessionVersion').value || null,
        clientRequestId: intentRequestId(intentKey),
      });
      resolveIntent(intentKey);
      closeEditor();
      notify(wasEditing ? 'Open Play session updated.' : 'Open Play session created.');
      state.editing = null;
      await render();
    } catch (error) {
      notify(error?.message || 'The Open Play session could not be saved.', 'err');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function duplicate(id) {
    if (!canManage()) {
      notify('Your role cannot duplicate Open Play sessions.', 'err');
      return;
    }
    const source = state.sessions.find(item => String(item.id) === String(id));
    if (!source) return;
    state.editing = null;
    await openEditor();
    byId('opaTitle').value = source.title;
    byId('opaDate').value = addDays(source.date, 7);
    byId('opaStart').value = localParts(source.startsAt)?.time || '18:00';
    byId('opaEnd').value = localParts(source.endsAt)?.time || '21:00';
    byId('opaCapacity').value = source.capacity;
    byId('opaPrice').value = source.pricePerPerson;
    byId('opaSkill').value = source.skillLevel || '';
    byId('opaNotes').value = source.notes || '';
    renderCourtOptions((source.courtIds || []).map(String));
    updatePreview();
  }

  async function cancelSession(id) {
    if (!canManage()) {
      notify('Your role cannot cancel Open Play sessions.', 'err');
      return;
    }
    const session = state.sessions.find(item => String(item.id) === String(id));
    if (!session || state.sessionMutations.has(String(id))) return;
    if (sessionHasEnded(session)) {
      notify('This session has ended and can no longer be cancelled.', 'err');
      return;
    }
    const paymentReviewCount = Math.max(0, Number(session.paymentReviewCount || 0));
    const collectedTotal = Math.max(0, Number(session.collectedTotal || 0));
    const refundRequiredCount = Math.max(0, Number(session.refundRequiredCount || 0));
    const refundRequiredTotal = Math.max(0, Number(session.refundRequiredTotal || 0));
    const refundReviewRequiredCount = Math.max(0, Number(session.refundReviewRequiredCount || 0));
    const refundReviewRequiredTotal = Math.max(0, Number(session.refundReviewRequiredTotal || 0));
    if (!global.confirm(
      `Cancel “${session.title}”? This session has ${paymentReviewCount} payment` +
      `${paymentReviewCount === 1 ? '' : 's'} under review and ${money(collectedTotal)} collected. ` +
      `${refundRequiredCount} confirmed refund liabilit${refundRequiredCount === 1 ? 'y' : 'ies'} total ${money(refundRequiredTotal)}. ` +
      `${refundReviewRequiredCount} payment evidence item${refundReviewRequiredCount === 1 ? '' : 's'} still requiring refund review total ${money(refundReviewRequiredTotal)}. ` +
      'Canceling paid or review entries creates refund or payment-review follow-up that the venue must resolve. Continue?'
    )) return;
    const reason = global.prompt(`Cancel “${session.title}”? Enter a reason that can be recorded for the roster:`);
    if (reason == null) return;
    if (reason.trim().length < 3) {
      notify('Enter a short cancellation reason.', 'err');
      return;
    }
    const intentKey = `cancel-session:${session.id}:${session.version}:${reason.trim()}`;
    state.sessionMutations.add(String(id));
    renderList();
    try {
      await global.DB.cancelOpenPlaySession(session.id, {
        reason: reason.trim(),
        expectedVersion: session.version,
        clientRequestId: intentRequestId(intentKey),
      });
      resolveIntent(intentKey);
      notify('Open Play session cancelled.');
      await render();
    } catch (error) {
      notify(error?.message || 'The session could not be cancelled.', 'err');
    } finally {
      state.sessionMutations.delete(String(id));
      if (state.mounted) renderList();
    }
  }

  function registrationRows(registrations) {
    if (!registrations.length) return '<div class="opa-empty">No player registrations yet.</div>';
    return `<table class="opa-roster-table">
      <thead><tr><th>Player</th><th>Spots</th><th>Payment</th><th>Status</th><th>Amount</th><th>Actions</th></tr></thead>
      <tbody>${registrations.map(registration => {
        const status = String(registration.status || 'pending_payment').toLowerCase();
        const payment = String(registration.paymentStatus || 'unpaid').toLowerCase();
        const receiptUrl = safeHttpsUrl(registration.receiptImageUrl || registration.receipt?.imageUrl);
        const canConfirm = ['payment_review', 'cancelled'].includes(status) && payment === 'for_verification';
        const sessionStart = Date.parse(state.rosterSession?.startsAt || '');
        const sessionEnd = Date.parse(state.rosterSession?.endsAt || '');
        const now = Date.now();
        const sessionActive = !['cancelled', 'completed'].includes(String(state.rosterSession?.status || '').toLowerCase());
        const canCheckIn = status === 'confirmed' &&
          sessionActive &&
          Number.isFinite(sessionStart) &&
          Number.isFinite(sessionEnd) &&
          now >= sessionStart - 2 * 60 * 60 * 1000 &&
          now <= sessionEnd;
        const canCancel = !sessionHasEnded(state.rosterSession) &&
          !['cancelled', 'expired', 'rejected', 'completed'].includes(status);
        const refundLiabilityState = typeof registration.refundLiability === 'string'
          ? registration.refundLiability.toLowerCase()
          : '';
        const liabilityObjectStatus = typeof registration.refundLiability === 'object' &&
          registration.refundLiability !== null
          ? String(registration.refundLiability.status || '').toLowerCase()
          : '';
        const refundStatus = String(registration.refundStatus || '').toLowerCase();
        const closedRefundStates = ['resolved', 'refunded', 'none', 'not_applicable', 'not_required'];
        const refundOpen = registration.refundRequired === true ||
          registration.refundReviewRequired === true ||
          registration.remittancePrepared === true ||
          registration.refundLiability === true ||
          Number(registration.refundLiability) > 0 ||
          Number(registration.refundLiability?.amount) > 0 ||
          (refundLiabilityState && !closedRefundStates.includes(refundLiabilityState)) ||
          (liabilityObjectStatus && !closedRefundStates.includes(liabilityObjectStatus)) ||
          ['required', 'review_required'].includes(refundStatus);
        const busy = state.rosterMutations.has(String(registration.id));
        const actionAttrs = action => `data-registration-id="${escapeHtml(registration.id)}" data-registration-action="${action}" ${busy ? 'disabled aria-disabled="true"' : ''}`;
        return `<tr>
          <td data-label="Player"><strong>${escapeHtml(registration.customerName || registration.fullName || 'Player')}</strong><small>${escapeHtml(registration.contactNumber || registration.phone || '')}${registration.email ? ` · ${escapeHtml(registration.email)}` : ''}</small><small>${escapeHtml(registration.reference || '')}</small></td>
          <td data-label="Spots">${Number(registration.quantity || 1)}</td>
          <td data-label="Payment"><strong>${escapeHtml(payment.replace(/_/g, ' '))}</strong><small>${escapeHtml(registration.paymentMethod || '')}${registration.paymentReference ? ` · ${escapeHtml(registration.paymentReference)}` : ''}</small></td>
          <td data-label="Status">${escapeHtml(status.replace(/_/g, ' '))}
            ${registration.statusReason ? `<small>${escapeHtml(registration.statusReason)}</small>` : ''}
            ${refundOpen ? '<small class="opa-refund-warning">Refund/payment review remains open</small>' : ''}
          </td>
          <td data-label="Amount">${money(registration.total)}</td>
          <td data-label="Actions"><div class="opa-roster-actions">
            ${receiptUrl ? `<a href="${escapeHtml(receiptUrl)}" target="_blank" rel="noopener noreferrer">View receipt</a>` : ''}
            ${canConfirm ? `<button type="button" ${actionAttrs('confirm')} onclick="OpenPlayAdmin.updateRegistration('${jsArg(registration.id)}','confirm')">Confirm evidence</button><button class="danger" type="button" ${actionAttrs('reject')} onclick="OpenPlayAdmin.updateRegistration('${jsArg(registration.id)}','reject')">Reject</button>` : ''}
            ${status === 'confirmed' ? `<button type="button" ${actionAttrs('check_in')} title="Check-in opens two hours before the session and closes at session end." onclick="OpenPlayAdmin.updateRegistration('${jsArg(registration.id)}','check_in')" ${canCheckIn && !busy ? '' : 'disabled'}>Check in</button>` : ''}
            ${canCancel ? `<button class="danger" type="button" ${actionAttrs('cancel')} onclick="OpenPlayAdmin.updateRegistration('${jsArg(registration.id)}','cancel')">Cancel</button>` : ''}
          </div></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  function registrationRefundAmount(registration) {
    const liability = registration?.refundLiability;
    const direct = typeof liability === 'object' && liability !== null
      ? Number(liability.amount)
      : typeof liability === 'number' || (typeof liability === 'string' && /^\d+(?:\.\d+)?$/.test(liability))
        ? Number(liability)
        : NaN;
    if (Number.isFinite(direct) && direct > 0) return direct;
    const explicit = Number(registration?.refundAmount);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (registration?.refundRequired === true ||
        registration?.refundReviewRequired === true ||
        liability === true ||
        (typeof liability === 'string' &&
          !['', 'resolved', 'refunded', 'none', 'not_applicable', 'not_required'].includes(liability.toLowerCase()))) {
      return Math.max(0, Number(registration?.total || 0));
    }
    return 0;
  }

  function renderRoster() {
    const registrations = state.registrations;
    const paid = registrations.filter(item => item.paymentStatus === 'paid').length;
    const review = registrations.filter(item => ['for_verification', 'pending'].includes(item.paymentStatus) || item.status === 'payment_review').length;
    const spots = registrations
      .filter(item => !['cancelled', 'expired', 'rejected'].includes(item.status))
      .reduce((sum, item) => sum + Number(item.quantity || 1), 0);
    const collected = registrations
      .filter(item => item.paymentStatus === 'paid')
      .reduce((sum, item) => sum + Number(item.total || 0), 0);
    const refundRows = registrations.filter(item => {
      const liability = typeof item.refundLiability === 'string'
        ? item.refundLiability.toLowerCase()
        : '';
      const liabilityObjectStatus = typeof item.refundLiability === 'object' &&
        item.refundLiability !== null
        ? String(item.refundLiability.status || '').toLowerCase()
        : '';
      const refundStatus = String(item.refundStatus || '').toLowerCase();
      const closedRefundStates = ['resolved', 'refunded', 'none', 'not_applicable', 'not_required'];
      return item.refundRequired === true ||
        item.refundReviewRequired === true ||
        item.refundLiability === true ||
        Number(item.refundLiability) > 0 ||
        Number(item.refundLiability?.amount) > 0 ||
        (liability && !closedRefundStates.includes(liability)) ||
        (liabilityObjectStatus && !closedRefundStates.includes(liabilityObjectStatus)) ||
        ['required', 'review_required'].includes(refundStatus);
    });
    const refundAmount = refundRows.reduce((sum, item) => sum + registrationRefundAmount(item), 0);
    byId('opaRosterBody').innerHTML = `<div class="opa-roster-summary">
      <div><span>Active spots</span><strong>${spots}</strong></div>
      <div><span>Paid</span><strong>${paid}</strong></div>
      <div><span>For review</span><strong>${review}</strong></div>
      <div><span>Collected</span><strong>${money(collected)}</strong></div>
      ${refundRows.length ? `<div class="opa-refund-summary"><span>Refund action</span><strong>${refundRows.length} · ${money(refundAmount)}</strong></div>` : ''}
    </div>${registrationRows(registrations)}`;
  }

  async function openRoster(id) {
    const session = state.sessions.find(item => String(item.id) === String(id));
    if (!session) return;
    const sequence = ++state.rosterSequence;
    state.rosterSession = session;
    state.registrations = [];
    byId('opaRosterTitle').textContent = session.title;
    byId('opaRosterSubtitle').textContent = `${dateLabel(session.date, { weekday: true })} · ${timeLabel(session.startsAt)}–${timeLabel(session.endsAt)} · ${(session.courtNames || []).join(' + ')}`;
    byId('opaRosterBody').innerHTML = '<div class="opa-empty">Loading player registrations…</div>';
    openOverlay('opaRosterOverlay');
    try {
      const registrations = await global.DB.getManagerOpenPlayRegistrations(session.id);
      if (sequence !== state.rosterSequence ||
          state.rosterSession?.id !== session.id ||
          byId('opaRosterOverlay')?.hidden) return;
      state.registrations = registrations;
      renderRoster();
    } catch (error) {
      if (sequence !== state.rosterSequence || state.rosterSession?.id !== session.id) return;
      byId('opaRosterBody').innerHTML = `<div class="opa-error">${escapeHtml(error?.message || 'The roster could not be loaded.')}</div>`;
    }
  }

  function closeRoster() {
    state.rosterSequence += 1;
    closeOverlay('opaRosterOverlay');
    state.rosterSession = null;
    state.registrations = [];
  }

  async function updateRegistration(id, action) {
    const registration = state.registrations.find(item => String(item.id) === String(id));
    const rosterSessionId = String(state.rosterSession?.id || '');
    if (!registration || !rosterSessionId || state.rosterMutations.has(String(id))) return;
    if (action === 'confirm' && !global.confirm(
      registration.status === 'cancelled'
        ? 'Confirm that you reviewed the payment evidence for this cancelled registration. This action must leave any received payment tracked for refund handling. Continue?'
        : 'Confirm that you reviewed the receipt and payment reference against the actual payment evidence. Mark this registration paid?'
    )) return;
    const registrationPaymentStatus = String(registration.paymentStatus || '').toLowerCase();
    const registrationStatus = String(registration.status || '').toLowerCase();
    if (action === 'cancel' &&
        (registrationPaymentStatus === 'paid' ||
          ['for_verification', 'pending'].includes(registrationPaymentStatus) ||
          registrationStatus === 'payment_review') &&
        !global.confirm(
          'This registration is paid or has payment evidence under review. Canceling it does not resolve the payment and creates refund or payment-review follow-up for the venue. Continue?'
        )) return;
    let reason = '';
    if (['reject', 'cancel'].includes(action)) {
      const entered = global.prompt(action === 'reject' ? 'Enter the payment rejection reason:' : 'Enter the registration cancellation reason:');
      if (entered == null) return;
      reason = entered.trim();
      if (reason.length < 3) {
        notify('Enter a short reason.', 'err');
        return;
      }
    }
    const intentKey = `registration:${rosterSessionId}:${id}:${action}:${reason}`;
    const rosterSequence = state.rosterSequence;
    state.rosterMutations.add(String(id));
    renderRoster();
    try {
      await global.DB.updateOpenPlayRegistrationStatus(id, {
        action,
        reason,
        clientRequestId: intentRequestId(intentKey),
      });
      resolveIntent(intentKey);
      notify(action === 'check_in' ? 'Player checked in.' : 'Registration updated.');
      if (rosterSequence !== state.rosterSequence ||
          String(state.rosterSession?.id || '') !== rosterSessionId ||
          !state.registrations.some(item => String(item.id) === String(id))) return;
      const registrations = await global.DB.getManagerOpenPlayRegistrations(rosterSessionId);
      if (rosterSequence !== state.rosterSequence ||
          String(state.rosterSession?.id || '') !== rosterSessionId) return;
      state.registrations = registrations;
      renderRoster();
      await render();
    } catch (error) {
      notify(error?.message || 'The registration could not be updated.', 'err');
    } finally {
      state.rosterMutations.delete(String(id));
      if (String(state.rosterSession?.id || '') === rosterSessionId && !byId('opaRosterOverlay')?.hidden) {
        renderRoster();
      }
    }
  }

  function setScope(scope) {
    state.scope = ['upcoming', 'past', 'all'].includes(scope) ? scope : 'upcoming';
    document.querySelectorAll('[data-opa-scope]').forEach(button => {
      const active = button.dataset.opaScope === state.scope;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    void render();
  }

  function handleKeydown(event) {
    const openOverlayElement = !byId('opaRosterOverlay')?.hidden
      ? byId('opaRosterOverlay')
      : !byId('opaEditorOverlay')?.hidden
        ? byId('opaEditorOverlay')
        : null;
    if (!openOverlayElement) return;
    if (event.key === 'Tab') {
      const focusable = [...openOverlayElement.querySelectorAll(
        'button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])'
      )].filter(element => !element.hidden && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key !== 'Escape') return;
    if (openOverlayElement.id === 'opaRosterOverlay') {
      event.preventDefault();
      closeRoster();
    } else {
      event.preventDefault();
      closeEditor();
    }
  }

  async function mount() {
    if (state.mounted || !canMount()) return false;
    const sidebarGroup = [...document.querySelectorAll('.sidebar .sb-section')]
      .find(group => group.querySelector('.nav-grp')?.textContent.trim() === 'Management');
    const content = document.querySelector('.main .content');
    if (!sidebarGroup || !content) return false;

    const nav = document.createElement('div');
    nav.className = 'nav-item';
    nav.dataset.s = 'openplay';
    nav.dataset.perm = 'open_play_roster';
    nav.tabIndex = 0;
    nav.setAttribute('role', 'button');
    nav.setAttribute('onclick', "goto('openplay')");
    nav.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      nav.click();
    });
    nav.innerHTML = '<span class="opa-nav-mark" aria-hidden="true">OP</span> Open Play';
    const paymentNav = sidebarGroup.querySelector('[data-s="payments"]');
    sidebarGroup.insertBefore(nav, paymentNav || null);

    const section = document.createElement('div');
    section.id = 'sec-openplay';
    section.className = 'adm-sec';
    section.innerHTML = shellHtml();
    content.appendChild(section);
    document.body.insertAdjacentHTML('beforeend', overlayHtml());

    if (typeof titles !== 'undefined') titles.openplay = 'Open Play';
    if (typeof SECTION_PERM !== 'undefined') SECTION_PERM.openplay = 'open_play_roster';
    if (typeof SECTION_LOADERS !== 'undefined') SECTION_LOADERS.openplay = render;

    byId('opaEditorOverlay').addEventListener('click', event => {
      if (event.target === event.currentTarget) closeEditor();
    });
    byId('opaRosterOverlay').addEventListener('click', event => {
      if (event.target === event.currentTarget) closeRoster();
    });
    ['opaTitle', 'opaDate', 'opaStart', 'opaEnd', 'opaCapacity', 'opaPrice'].forEach(id => {
      byId(id)?.addEventListener('input', updatePreview);
    });
    byId('opaCapacity')?.addEventListener('input', () => { byId('opaCapacity').dataset.touched = '1'; });
    document.addEventListener('keydown', handleKeydown);
    state.mounted = true;
    await loadCourts().catch(() => []);
    return true;
  }

  global.OpenPlayAdmin = Object.freeze({
    mount,
    render,
    setScope,
    openEditor,
    closeEditor,
    courtsChanged,
    submitEditor,
    duplicate,
    cancelSession,
    openRoster,
    closeRoster,
    updateRegistration,
  });
})(window);
