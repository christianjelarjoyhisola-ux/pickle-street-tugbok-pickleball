(function receiptPending(global) {
  'use strict';
  const enabled = () => global.PB_TENANT_CONFIG?.tenantSlug === 'pickle-street-tugbok' && global.PB_TENANT_CONFIG?.receiptReviewMode === 'auto_pending';
  const automatic = b => enabled() && (!!b?.receiptFlow || ['gcash','maya','bdopay','bdo_pay','bdo','bpi','gotyme','pnb'].includes(String(b?.paymentMethod || '').toLowerCase()));
  // Booking state and an additional-payment receipt are separate authorities.
  const pending = b => automatic(b) && !['confirmed','completed','cancelled'].includes(b?.platformStatus || b?.status) && (b?.receiptPending === true || ['pending','for_verification'].includes(b?.paymentStatus));
  const balanceId = b => String(b?.balanceRequestId || b?.receiptBalanceRequestId || b?.balance_request_id || '');
  const balancePending = b => {
    if (!enabled() || !balanceId(b) || ['cancelled','completed'].includes(b?.platformStatus || b?.status)) return false;
    const status = b?.balanceRequestStatus || b?.balanceStatus || (b?.requestType ? b?.status : '');
    return ['awaiting_payment','payment_review','pending'].includes(status) || (status === 'expired' && !!b.balanceReceiptFlow && b.receiptBalanceRequestId === b.balanceRequestId && ['pending','manual_review'].includes(b.receiptStatus));
  };
  const receiptPending = b => automatic(b) && (balanceId(b) ? !!b?.receiptBalanceRequestId && b.balanceRequestId === b.receiptBalanceRequestId && balancePending(b) : pending(b));
  const receiptRetryTarget = b => !receiptPending(b) || !b?.receiptVerificationId ? null : {bookingReference:b.primaryRef || b.ref,balanceRequestId:b.receiptBalanceRequestId || '',verificationId:b.receiptVerificationId};
  const manualReviewTarget = b => {
    if (!enabled() || global.PB_TENANT_CONFIG?.manualReceiptReviewEnabled !== true ||
      !['pending','manual_review'].includes(b?.receiptStatus) || !b?.receiptImageUrl || !b?.receiptVerificationId ||
      (Array.isArray(b?.items) && b.items.length > 1)) return null;
    // A pending additional receipt can still be rejected after the original
    // paid booking completes. The server separately decides if approval is eligible.
    if (b.receiptBalanceRequestId && b.balanceRequestId === b.receiptBalanceRequestId &&
      ['awaiting_payment','payment_review','pending','expired'].includes(b.balanceRequestStatus) &&
      (b.platformStatus || b.status) !== 'cancelled') return {bookingReference:b.primaryRef || b.ref,balanceRequestId:b.receiptBalanceRequestId,verificationId:b.receiptVerificationId};
    return receiptRetryTarget(b);
  };
  const receiptReason = b => b?.receiptBalanceRequestId ? (b.balancePendingReason || 'The additional payment is pending until every receipt check passes.') : reason(b);
  const receiptHold = b => b?.receiptBalanceRequestId ? (b.balanceReservationHeld === false ? (b.balanceRequestType === 'reschedule_adjustment' ? 'The requested new-time hold has ended. The original confirmed schedule remains in place; availability will be checked again before the move is confirmed.' : 'The court hold has ended. The payment remains pending; availability will be checked again before confirmation.') : '') : hold(b);
  const label = b => pending(b) ? 'Pending' : String(b?.status || 'pending').replaceAll('_',' ');
  const reason = b => b?.publicReason || b?.pendingReason || (pending(b) ? 'Your receipt is saved. Confirmation is pending until every payment check passes.' : '');
  const hold = b => b?.reservationHeld === false && pending(b)
    ? 'The court hold has ended. Your receipt remains pending. Availability will be checked again before confirmation.'
    : b?.reservationHeld && b?.expiresAt && Number.isFinite(new Date(b.expiresAt).getTime())
      ? 'Court held until '+new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(b.expiresAt))+'.'
      : '';
  let activeDialog = null;
  async function openUpload(access, booking, onUpdated) {
    if (!enabled() || !access?.bookingToken || !access?.reference || booking?.canSubmitReceipt !== true || activeDialog) return;
    const opener = document.activeElement;
    const dialog = document.createElement('dialog');
    activeDialog = dialog;
    dialog.className = 'ps-receipt-dialog';
    dialog.setAttribute('aria-labelledby','psReceiptTitle');
    dialog.innerHTML = '<form><h2 id="psReceiptTitle">Update your payment receipt</h2><p class="ps-receipt-reason"></p><p class="ps-receipt-hold"></p><label>Payment method<select name="method" required></select></label><label>Transaction reference<input name="reference" required minlength="6" maxlength="64" autocomplete="off"></label><label>Receipt image<input name="receipt" type="file" accept="image/jpeg,image/png,image/webp" required></label><p>Upload proof of the payment you already made. Do not pay again just because verification is pending.</p><p class="ps-receipt-message" role="status" aria-live="polite"></p><div class="ps-receipt-actions"><button type="button" class="btn btn-g">Close</button><button type="submit" class="btn btn-p">Submit receipt</button></div></form>';
    const form = dialog.querySelector('form');
    const message = dialog.querySelector('.ps-receipt-message');
    const submit = form.querySelector('[type="submit"]');
    const close = form.querySelector('[type="button"]');
    let saving = false;
    let requestId = global.crypto.randomUUID();
    dialog.querySelector('.ps-receipt-reason').textContent = reason(booking);
    dialog.querySelector('.ps-receipt-hold').textContent = hold(booking);
    form.elements.reference.value = booking.submittedReference || '';
    form.addEventListener('change', () => { if (!saving) requestId = global.crypto.randomUUID(); });
    close.addEventListener('click', () => { if (!saving) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { activeDialog = null; dialog.remove(); opener?.focus?.(); });
    document.body.append(dialog);dialog.showModal();
    submit.disabled = true;
    try {
      await DB.getSettings();
      for (const method of Object.values(global.PB_PAYMENT_METHODS_BY_CODE || {})) {
        if (method.code === 'cash') continue;
        const option = document.createElement('option');option.value=method.code;option.textContent=method.displayName;
        form.elements.method.append(option);
      }
      if (Array.from(form.elements.method.options).some(o=>o.value===booking.paymentMethod)) form.elements.method.value=booking.paymentMethod;
      submit.disabled = !form.elements.method.options.length;
      if(submit.disabled) message.textContent='No receiving payment method is configured. Contact the venue.';
    } catch (_) { message.textContent='Payment settings could not be loaded. Close this window and try again.'; }
    form.addEventListener('submit', async event => {
      event.preventDefault();if(saving || submit.disabled)return;
      saving=true;submit.disabled=true;close.disabled=true;
      for (const field of [form.elements.method,form.elements.reference,form.elements.receipt]) field.disabled=true;
      message.textContent='Saving and checking your receipt…';
      try {
        const result=await DB.submitPublicPaymentReceipt({bookingReference:access.reference,bookingToken:access.bookingToken,paymentMethod:form.elements.method.value,paymentReference:form.elements.reference.value.trim(),receiptFile:form.elements.receipt.files[0],idempotencyKey:requestId});
        message.textContent=result.publicReason || (result.bookingStatus==='confirmed'?'Your booking is confirmed.':'Receipt saved. Your booking remains pending.');
        requestId=global.crypto.randomUUID();
        form.elements.receipt.value='';
        try { await onUpdated?.(); } catch (_) { message.textContent+=' Refresh your booking to see the latest status.'; }
        if(result.bookingStatus==='confirmed') { form.querySelectorAll('label').forEach(el=>el.hidden=true);submit.hidden=true; }
      } catch(error) { message.textContent=(error.message || 'We could not complete the request.')+' Your booking has not been rejected. Check its status before retrying an interrupted upload.'; }
      finally {saving=false;submit.disabled=false;close.disabled=false;for(const field of [form.elements.method,form.elements.reference,form.elements.receipt])field.disabled=false;}
    });
  }
  global.PBReceiptPending=Object.freeze({enabled,automatic,pending,label,reason,hold,balancePending,receiptPending,receiptRetryTarget,manualReviewTarget,receiptReason,receiptHold,openUpload});
})(window);
