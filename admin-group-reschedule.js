(function (root) {
  'use strict';
  const money = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(value);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const dateKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  function normalizeSession(row) {
    const sessionId = String(row?.sessionId || '');
    const date = String(row?.bookingDate || row?.date || '');
    const startTime = String(row?.startTime || '').slice(0, 5);
    const durationHours = Number(row?.durationHours || row?.duration);
    if (!sessionId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !Number.isInteger(durationHours) || durationHours < 1) {
      throw new Error('The court sessions could not be verified. Refresh the booking before continuing.');
    }
    return { ...row, sessionId, date, startTime, durationHours };
  }
  function collectChanges(sessions, drafts, mode) {
    const changes = [];
    for (const session of sessions) {
      const draft = drafts[session.sessionId];
      if (!draft || !draft.selected) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.newDate || '') || !/^\d{2}:\d{2}$/.test(draft.newStartTime || '')) {
        throw new Error(`Choose an available date and time for ${session.courtName || 'each selected session'}.`);
      }
      const unchanged = draft.newDate === session.date && draft.newStartTime === session.startTime;
      if (unchanged && mode === 'all') throw new Error('Choose a new time for every session, or use Selected sessions to keep some unchanged.');
      if (!unchanged) changes.push({ sessionId: session.sessionId, newDate: draft.newDate, newStartTime: draft.newStartTime });
    }
    if (!changes.length) throw new Error('Select at least one session and choose a new available time.');
    return changes;
  }
  function validatePrice(price) {
    const oldTotalAmount = Number(price?.oldTotalAmount ?? price?.originalTotalAmount);
    const newTotalAmount = Number(price?.newTotalAmount);
    const additionalAmount = Number(price?.additionalAmount);
    if ([oldTotalAmount, newTotalAmount, additionalAmount].some(value => !Number.isFinite(value) || value < 0) || Math.abs(Math.max(0, newTotalAmount - oldTotalAmount) - additionalAmount) > 0.011) {
      throw new Error('The price could not be verified. Review availability again before saving.');
    }
    return { oldTotalAmount, newTotalAmount, additionalAmount };
  }
  function scheduleLabel(session) {
    const start = new Date(session.startsAt || `${session.bookingDate || session.date}T${session.startTime}:00+08:00`);
    const end = new Date(session.endsAt || start.getTime() + Number(session.durationHours || session.duration) * 3600000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 'Schedule unavailable';
    const date = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
    const time = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
    return `${date.format(start)} · ${time.format(start)} – ${time.format(end)}`;
  }
  function clock(value) {
    const match = /^(\d{2}):(\d{2})/.exec(String(value));
    if (!match) return String(value || '');
    const hour = Number(match[1]);
    return `${hour % 12 || 12}:${match[2]} ${hour % 24 < 12 ? 'AM' : 'PM'}`;
  }
  function commonOptions(results) {
    if (!results.length) return [];
    const key = o => String(o.startTime).slice(0,5) + '/' + String(o.endTime).slice(0,5);
    const lists = results.map(r => (Array.isArray(r.options) ? r.options : []).filter(o => o.available === true));
    return lists[0].filter((o,i,a) => a.findIndex(x=>key(x)===key(o))===i && lists.every(list=>list.some(x=>key(x)===key(o))));
  }
  const helpers = { normalizeSession, collectChanges, validatePrice, scheduleLabel, commonOptions };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (!root?.document) return;

  let state = null;
  let modal = null;
  const $ = selector => modal?.querySelector(selector);
  function announce(message, success = false) {
    const box = $('[data-gr-feedback]');
    if (box) { box.textContent = message; box.classList.toggle('is-success', success); box.hidden = !message; }
  }
  function invalidate() {
    if (!state || state.saving) return;
    state.preview = null;
    state.requestId = null;
    $('[data-gr-summary]').hidden = true;
    $('[data-gr-save]').hidden = true;
    $('[data-gr-preview]').hidden = false;
    announce('');
  }
  function reasonCode() { return $('[name="grReason"]')?.value || ''; }
  function updateActionGuards() {
    if (!state) return;
    const waiting = state.saving || state.loadingOptions > 0 || !state.sessions.length || state.eligible === false || !state.newStartTime;
    $('[data-gr-preview]').disabled = waiting;
    $('[data-gr-save]').disabled = waiting || !state.preview;
  }
  function close() {
    if (state?.saving) return;
    const focus = state?.returnFocus;
    state = null;
    if (modal?.open) modal.close();
    modal?.remove(); modal = null;
    if (focus && root.document.contains(focus)) focus.focus();
  }
  function setBusy(value) {
    if (!state) return;
    state.saving = value;
    modal.setAttribute('aria-busy', String(value));
    modal.querySelectorAll('button,input,select,textarea').forEach(element => {
      if (value) { element.dataset.grWasDisabled = String(element.disabled); element.disabled = true; }
      else { element.disabled = element.dataset.grWasDisabled === 'true'; delete element.dataset.grWasDisabled; }
    });
    updateActionGuards();
  }
  function renderTimes() {
    $('[data-gr-times]').innerHTML = state.options.length ? state.options.map((option,index) => '<button type="button" class="gr-time" data-gr-slot="'+index+'" aria-pressed="'+(state.newStartTime===String(option.startTime).slice(0,5))+'">'+escape(clock(option.startTime))+'<span>– '+escape(clock(option.endTime))+'</span></button>').join('') : '<p class="gr-empty">No shared times available. Choose another date.</p>';
  }
  async function loadOptions() {
    const active=state, generation=++active.generation;
    const previous=active.newStartTime;
    active.newStartTime=''; active.options=[]; active.loadingOptions=1;
    Object.values(active.drafts).forEach(d=>{d.newDate=active.newDate;d.newStartTime='';});
    updateActionGuards();
    $('[data-gr-times]').innerHTML='<p class="gr-empty" role="status">Checking availability across every court…</p>';
    try {
      const results=await Promise.all(active.sessions.map(session=>active.api.groupRescheduleOptions(active.reference,{sessionId:session.sessionId,bookingDate:active.newDate,expectedVersion:active.version,reasonCode:reasonCode()})));
      if(state!==active || generation!==active.generation)return;
      active.options=commonOptions(results).filter(o=>!active.sessions.some(session=>session.date===active.newDate && session.startTime===String(o.startTime).slice(0,5)));
      if(active.options.some(o=>String(o.startTime).slice(0,5)===previous)) {
        active.newStartTime=previous;Object.values(active.drafts).forEach(d=>d.newStartTime=previous);
      }
      renderTimes();
    } catch(error) {
      if(state!==active || generation!==active.generation)return;
      $('[data-gr-times]').innerHTML='<p class="gr-empty" role="status">Availability could not be loaded. Choose a date to retry.</p>';
      announce(error.message || 'Could not check availability.');
    } finally {
      if(state===active && generation===active.generation){active.loadingOptions=0;updateActionGuards();}
    }
  }
  function renderSessions() {
    const sameDuration=state.sessions.every(s=>s.durationHours===state.sessions[0].durationHours);
    $('[data-gr-sessions]').innerHTML='<div class="gr-court-chips">'+state.sessions.map(s=>'<span>'+escape(s.courtName)+'</span>').join('')+'</div><p class="gr-muted">'+escape(state.sessions[0].durationHours)+' hour'+(state.sessions[0].durationHours===1?'':'s')+' · All courts move together</p><label class="gr-date-label">New booking date<input type="date" data-gr-date min="'+dateKey(new Date())+'" value="'+state.newDate+'"></label><div class="gr-times-heading">Available times <span>Available on every court</span></div><div class="gr-times" data-gr-times role="group" aria-label="Available times for all courts"></div>';
    if(!sameDuration){$('[data-gr-times]').innerHTML='<p class="gr-empty">These sessions have different durations. They cannot share one time range while keeping their booked hours.</p>';return;}
    void loadOptions();
  }
  function reviewMarkup(preview, price) {
    const nextById = new Map(preview.sessions.map(session => [String(session.sessionId), session]));
    const changed = new Set(state.previewChanges.map(change => change.sessionId));
    const rows = state.sessions.map(session => {
      const next = nextById.get(session.sessionId);
      if (!next) throw new Error('The updated sessions could not be verified. Please review again.');
      return `<div class="gr-comparison-row"><strong>${escape(session.courtName)}</strong><div><span>Current</span>${escape(scheduleLabel(session))}</div><div><span>${changed.has(session.sessionId) ? 'New schedule' : 'Unchanged'}</span>${escape(scheduleLabel(next))}</div></div>`;
    }).join('');
    return `<h3>Review the complete booking</h3><p class="gr-muted">Reference ${escape(state.reference)} · ${state.sessions.length} sessions</p><div class="gr-comparison">${rows}</div>
      <dl class="gr-price"><div><dt>Original booking total</dt><dd>${money(price.oldTotalAmount)}</dd></div><div><dt>New booking total</dt><dd>${money(price.newTotalAmount)}</dd></div><div class="gr-price-additional"><dt>Additional payment</dt><dd>${price.additionalAmount > 0 ? money(price.additionalAmount) : 'None'}</dd></div></dl>
      <p class="gr-notice">${price.additionalAmount > 0 ? 'The player has 15 minutes to pay the difference. Every original session stays reserved until the additional payment is verified. If the request expires, the original booking stays unchanged.' : reasonCode() === 'weather' ? 'Rain rescheduling keeps the original payment and booked court hours.' : 'Your original payment and receipt stay with this booking. No new booking fee is charged.'}</p>`;
  }
  async function preview() {
    if (!state || state.saving || state.loadingOptions > 0) return;
    const active = state;
    try {
      if (!reasonCode()) throw new Error('Choose a reason for the schedule change.');
      if (($('[name="grPublicReason"]').value.trim().length) < 3) throw new Error('Enter a short reason the player can see.');
      const changes = collectChanges(active.sessions, active.drafts, active.mode);
      const input = { changes, expectedVersion: active.version, reasonCode: reasonCode(), publicReason: $('[name="grPublicReason"]').value.trim(), internalNote: $('[name="grInternalNote"]').value.trim(), notifyCustomer: $('[name="grNotify"]').checked };
      setBusy(true); announce('Checking every session and the updated total…');
      const result = await active.api.previewGroupReschedule(active.reference, input);
      if (state !== active) return;
      const price = validatePrice(result.price);
      if (!result.quoteHash || !Array.isArray(result.sessions)) throw new Error('The schedule review is incomplete. Please try again.');
      active.previewChanges = changes;
      active.previewInput = input;
      $('[data-gr-summary]').innerHTML = reviewMarkup(result, price);
      active.preview = { ...result, price };
      $('[data-gr-summary]').hidden = false;
      $('[data-gr-save]').hidden = false;
      $('[data-gr-save]').textContent = price.additionalAmount > 0 ? 'Create 15-minute payment link' : 'Confirm reschedule';
      $('[data-gr-preview]').hidden = true;
      announce('');
      $('[data-gr-summary]').scrollIntoView({ block: 'start', behavior: root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (error) { announce(error.message || 'The new schedule could not be checked. Your booking is unchanged.'); }
    finally { if (state === active) setBusy(false); }
  }
  async function save() {
    if (!state?.preview || state.saving || state.loadingOptions > 0) return;
    const active = state;
    active.requestId ||= root.crypto.randomUUID();
    try {
      setBusy(true); announce('Saving your schedule change…');
      const result = await active.api.rescheduleGroupBooking(active.reference, {
        ...active.previewInput, expectedQuoteHash: active.preview.quoteHash, idempotencyKey: active.requestId,
      });
      if (state !== active) return;
      const adjustmentStatus = String(result.balanceRequest?.status || '').toLowerCase();
      if (['expired','cancelled'].includes(adjustmentStatus)) {
        setBusy(false);
        active.preview = null;
        active.previewInput = null;
        active.paymentUrl = '';
        active.requestId = null;
        $('[data-gr-form]').hidden = true;
        $('[data-gr-summary]').hidden = false;
        $('[data-gr-summary]').innerHTML = `<h3>Original schedule kept</h3><p class="gr-notice">${adjustmentStatus === 'expired' ? 'The 15-minute payment window expired.' : 'The additional payment request was cancelled.'} Your original court sessions and payment remain unchanged. Refresh the booking to choose new available times.</p>`;
        $('[data-gr-save]').hidden = true;
        $('[data-gr-preview]').hidden = true;
        $('[data-gr-reload]').hidden = false;
        announce('No court sessions were moved.');
        $('[data-gr-summary]').scrollIntoView({ block: 'start', behavior: 'auto' });
        return;
      }
      const held = result.paymentRequired === true || ['awaiting_payment','payment_review'].includes(adjustmentStatus);
      if (!held && !String(result.event?.id || result.event?.eventId || result.rescheduleEventId || '').trim()) {
        const error = new Error('The schedule response is incomplete. Refresh this booking to check its saved schedule before trying again.');
        error.code = 'GROUP_RESPONSE_INCOMPLETE';
        throw error;
      }
      const callback = active.onSaved;
      setBusy(false);
      if (held) {
        active.preview = null;
        active.paymentUrl = '';
        try {
          const url = new URL(result.balanceRequest?.paymentUrl || '');
          if (url.origin === root.location.origin || url.origin === 'https://picklestreet.pages.dev') active.paymentUrl = url.href;
        } catch (_) { /* Only the private link returned by this venue is offered. */ }
        const deadline = new Date(result.balanceRequest?.deadlineAt || '');
        const deadlineLabel = Number.isFinite(deadline.getTime()) ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }).format(deadline) + ' PH' : 'the 15-minute deadline';
        $('[data-gr-form]').hidden = true;
        $('[data-gr-summary]').hidden = false;
        $('[data-gr-summary]').innerHTML = `<h3>New sessions held for payment</h3><p class="gr-notice">The player can pay the difference until ${escape(deadlineLabel)}. Every original session stays reserved until verification succeeds.</p>${active.paymentUrl ? '<button class="btn btn-g gr-copy-payment" type="button" data-gr-copy>Copy private payment link</button>' : ''}<p class="gr-muted">Reference ${escape(active.reference)} · one booking, one payment history.</p>`;
        $('[data-gr-save]').hidden = true;
        $('[data-gr-preview]').hidden = true;
        $('[data-gr-reload]').hidden = true;
        announce(active.paymentUrl ? 'Payment link created. Share the private link with the player.' : 'The additional payment request is saved.', true);
      } else close();
      await callback?.(result, held);
    } catch (error) {
      if (state !== active) return;
      announce(error.message || 'The result could not be confirmed. Refresh this booking before trying again.');
      if (/stale|version|quote|conflict|changed|unavailable|incomplete/i.test(String(error.code || '') + ' ' + error.message)) {
        active.preview = null;
        $('[data-gr-save]').hidden = true;
        $('[data-gr-preview]').hidden = false;
        $('[data-gr-reload]').hidden = false;
      }
    } finally { if (state === active) setBusy(false); }
  }
  async function loadContext() {
    const active = state;
    setBusy(true); announce('Loading the booking and its court sessions…');
    try {
      const result = await active.api.groupRescheduleContext(active.reference);
      if (state !== active) return;
      if (!result.version || !Array.isArray(result.sessions) || result.sessions.length < 2) throw new Error('This booking does not contain multiple court sessions.');
      active.sessions = result.sessions.map(normalizeSession);
      active.version = result.version;
      active.booking = result.booking;
      active.eligible = result.eligible !== false;
      if (!active.eligible) {
        $('[data-gr-form]').hidden = true;
        $('[data-gr-summary]').hidden = true;
        $('[data-gr-preview]').hidden = true;
        $('[data-gr-save]').hidden = true;
        $('[data-gr-reload]').hidden = false;
        if (result.pendingAdjustment) {
          const pending = result.pendingAdjustment;
          announce(`An additional payment of ${money(Number(pending.remainingAmount) || 0)} is ${pending.status === 'payment_review' ? 'being verified' : 'awaiting payment'}. The original booking remains reserved. Complete or resolve this request before changing the schedule again.`);
          active.paymentUrl = '';
          try { const url = new URL(pending.paymentUrl || ''); if (url.origin === root.location.origin || url.origin === 'https://picklestreet.pages.dev') active.paymentUrl = url.href; } catch (_) { /* No link was returned. */ }
          if (active.paymentUrl) { $('[data-gr-summary]').hidden = false; $('[data-gr-summary]').innerHTML = '<button class="btn btn-g gr-copy-payment" type="button" data-gr-copy>Copy private payment link</button>'; }
        } else announce('Only a fully paid, confirmed booking that has not checked in can be rescheduled. This booking is unchanged.');
        return;
      }
      active.mode = 'all'; active.preview = null; active.requestId = null; active.generation=0; active.options=[]; active.newStartTime=''; active.newDate=active.sessions[0].date < dateKey(new Date()) ? dateKey(new Date()) : active.sessions[0].date;
      active.drafts = Object.fromEntries(active.sessions.map(session => [session.sessionId, { selected: true, newDate: session.date < dateKey(new Date()) ? dateKey(new Date()) : session.date, newStartTime: '', generation: 0 }]));
      const reasons = result.reasonCodes || result.policies?.reasonCodes || [];
      $('[name="grReason"]').innerHTML = '<option value="">Select a reason</option>' + reasons.map(reason => {
        const value = typeof reason === 'string' ? reason : reason.value || reason.code;
        const label = typeof reason === 'string' ? reason.replaceAll('_', ' ') : reason.label || value;
        return `<option value="${escape(value)}">${escape(label)}</option>`;
      }).join('');
      active.hasEmail = Boolean(result.booking?.email || result.booking?.customerEmail || result.booking?.customer_email);
      $('[name="grNotify"]').checked = active.hasEmail;
      $('[data-gr-name]').textContent = `${result.booking?.fullName || result.booking?.customerName || result.booking?.customer_name || 'Guest'} · ${active.reference}`;
      $('[data-gr-form]').hidden = false;
      $('[data-gr-summary]').hidden = true;
      $('[data-gr-save]').hidden = true;
      $('[data-gr-preview]').hidden = false;
      $('[data-gr-reload]').hidden = true;
      announce('');
    } catch (error) { announce(error.message || 'The booking could not be loaded.'); $('[data-gr-reload]').hidden = false; }
    finally { if (state === active) { setBusy(false); $('[name="grNotify"]').disabled = !active.hasEmail; if (active.eligible && active.sessions?.length) renderSessions(); } }
  }
  async function open({ booking, api, returnFocus, onSaved }) {
    if (state?.saving) return false;
    close();
    modal = root.document.createElement('dialog');
    modal.className = 'gr-dialog'; modal.setAttribute('aria-labelledby', 'grTitle');
    modal.innerHTML = `<div class="gr-shell"><header class="gr-header"><div><p class="gr-eyebrow">One booking. Every court.</p><h2 id="grTitle">Reschedule court sessions</h2><p class="gr-muted" data-gr-name></p></div><button class="gr-close" type="button" data-gr-close aria-label="Close reschedule">×</button></header>
      <div class="gr-body"><div data-gr-form hidden><p class="gr-muted">Choose one date and time for your complete booking. Your courts, duration and booking reference stay together.</p><div class="gr-sessions" data-gr-sessions></div>
      <div class="gr-reasons"><label>Reason<select name="grReason"><option value="">Select a reason</option></select></label><label>Reason for the player<textarea name="grPublicReason" rows="2" maxlength="500" placeholder="Tell the player why the schedule is changing"></textarea></label><label>Internal note <span class="gr-muted">(optional)</span><textarea name="grInternalNote" rows="2" maxlength="1000"></textarea></label></div><label class="gr-notify"><input type="checkbox" name="grNotify" checked><span>Email the complete updated schedule after the change is confirmed</span></label></div>
      <section class="gr-summary" data-gr-summary hidden aria-live="polite"></section><p class="gr-feedback" data-gr-feedback role="status" hidden></p></div>
      <footer class="gr-footer"><button type="button" class="btn btn-g" data-gr-close>Close</button><button type="button" class="btn btn-g" data-gr-reload hidden>Refresh booking</button><button type="button" class="btn btn-p" data-gr-preview>Review changes</button><button type="button" class="btn btn-p" data-gr-save hidden>Confirm reschedule</button></footer></div>`;
    root.document.body.append(modal);
    state = { reference: String(booking.ref || booking.reference), api, booking, returnFocus: returnFocus || root.document.activeElement, onSaved, saving: false, loadingOptions: 0, sessions: [], drafts: {}, mode: 'all' };
    modal.addEventListener('cancel', event => { event.preventDefault(); close(); });
    modal.addEventListener('click', event => {
      const slot=event.target.closest('[data-gr-slot]');
      if(slot && state && !state.saving && !state.loadingOptions){
        const option=state.options[Number(slot.dataset.grSlot)];if(!option)return;
        invalidate();state.newStartTime=String(option.startTime).slice(0,5);
        Object.values(state.drafts).forEach(d=>{d.selected=true;d.newDate=state.newDate;d.newStartTime=state.newStartTime;});
        renderTimes();updateActionGuards();return;
      }
      if (event.target.closest('[data-gr-close]')) close();
      else if (event.target.closest('[data-gr-preview]')) void preview();
      else if (event.target.closest('[data-gr-save]')) void save();
      else if (event.target.closest('[data-gr-reload]')) void loadContext();
      else if (event.target.closest('[data-gr-copy]') && state?.paymentUrl) {
        if (!root.navigator.clipboard?.writeText) { announce('Copying is unavailable in this browser. Open the dashboard in a secure browser and try again.'); return; }
        void root.navigator.clipboard.writeText(state.paymentUrl).then(() => announce('Private payment link copied.', true)).catch(() => announce('The link could not be copied. Try again from a secure browser.'));
      }
    });
    modal.addEventListener('input', event => { if (event.target.matches('textarea')) invalidate(); });
    modal.addEventListener('change', event => {
      if (!state || state.saving) return;
      const input = event.target;
      invalidate();
      if (input.hasAttribute('data-gr-date')) {
        state.newDate=input.value;state.newStartTime='';void loadOptions();
      } else if (input.name === 'grReason') void loadOptions();
    });
    modal.showModal();
    await loadContext();
    return true;
  }
  root.PBGroupReschedule = { open, close };
})(typeof window === 'undefined' ? null : window);
