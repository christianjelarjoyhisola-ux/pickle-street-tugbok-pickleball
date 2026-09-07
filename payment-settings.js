(function paymentSettingsModule(root) {
  'use strict';
  const definitions = Object.freeze([
    {code:'cash',displayName:'Cash',icon:'cash'},
    {code:'gcash',displayName:'GCash',icon:'gcash'},
    {code:'bdo_pay',displayName:'BDO Pay',icon:'bdopay'},
    {code:'maya',displayName:'Maya',icon:'maya'},
    {code:'bpi',displayName:'BPI',icon:'bpi'},
    {code:'gotyme',displayName:'GoTyme → GCash',icon:'gotyme'},
    {code:'maribank',displayName:'MariBank → GCash',icon:'maribank'},
    {code:'pnb',displayName:'PNB',icon:'pnb'},
  ]);
  const sharedCodes = new Set(['gcash','bdo_pay','maya','bpi','gotyme','maribank']);
  const canonical = code => ['bdo','bdopay'].includes(String(code).toLowerCase()) ? 'bdo_pay' : String(code || '').toLowerCase();
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const defaults = {
    gcash:'Send the full booking amount to the GCash recipient shown. Upload your completed receipt and its reference number.',
    bdo_pay:'Pay from BDO Pay to the GCash recipient shown. Upload the completed receipt and enter its reference number.',
    maya:'In Maya, choose Bank Transfer, then GCash. Send the full booking amount. Enter the Maya Reference ID, not the InstaPay reference.',
    bpi:'Pay from BPI to the GCash recipient shown. Upload the completed receipt and enter its confirmation reference.',
    gotyme:'Send from GoTyme to the GCash recipient shown. Upload the completed receipt and enter its GoTyme reference.',
    maribank:'Send from MariBank to the GCash recipient shown. Upload the completed receipt and enter its transaction reference.',
    cash:'Pay at the venue. Your booking remains pending until staff confirms payment.',
  };
  function methods(saved = []) {
    const values = new Map();
    for (const method of saved) {
      const code = canonical(method.code);
      if (values.has(code)) throw new Error('Duplicate payment methods need to be resolved before saving.');
      values.set(code, {...method,code});
    }
    const all = [...definitions];
    for (const [code,method] of values) if (!all.some(d=>d.code===code)) all.push({code,displayName:method.displayName || code});
    return all.map((definition,index)=>({...values.get(definition.code),...definition,
      isActive:values.get(definition.code)?.isActive === true,
      sortOrder:index,
    }));
  }
  function mark(icon) { return root.PaymentMethodBrand?.markHtml(icon,'pm-brand-mark--small') || ''; }
  function qr(method, name) {
    const url = esc(method.qrImageUrl);
    return `<div class="platform-qr-upload">
      <div class="platform-qr-preview">${url ? `<img src="${url}" alt="${esc(name)} QR preview" />` : '<span>No QR</span>'}</div>
      <div class="platform-qr-copy"><div class="platform-qr-title">${esc(name)} QR code image</div>
        <p class="platform-qr-help">JPEG, PNG or WebP, up to 2 MB. Changes take effect when you save.</p>
        <div class="platform-qr-actions"><button class="btn btn-g platform-qr-upload-btn" type="button" onclick="choosePlatformPaymentQr(this)">${url?'Replace':'Upload'} ${esc(name)} QR image</button>
          <button class="btn btn-g platform-qr-remove-btn" type="button" onclick="removePlatformPaymentQr(this)" ${url?'':'hidden'}>Remove QR</button></div>
        <div class="platform-qr-status" role="status" aria-live="polite">${url?'QR image saved.':'No QR image uploaded.'}</div>
        <input class="platform-method-qr-url" type="hidden" value="${url}" />
        <input class="platform-qr-file" type="file" accept="image/jpeg,image/png,image/webp" onchange="uploadPlatformPaymentQr(this)" />
      </div></div>`;
  }
  function accountFields(method, name) {
    const prefix = 'payment-account-'+method.code;
    return `<div class="ps-payment-fields">
      <div class="fg"><label class="fl" for="${prefix}-number">${esc(name)} ${method.code==='gcash'?'number':'account number'}</label><input class="fi platform-method-account-reference" id="${prefix}-number" maxlength="120" value="${esc(method.accountReference)}" autocomplete="off" placeholder="${method.code==='gcash'?'09XX XXX XXXX':'Receiving account number'}" /></div>
      <div class="fg"><label class="fl" for="${prefix}-name">Account name</label><input class="fi platform-method-account-name" id="${prefix}-name" maxlength="120" value="${esc(method.accountName)}" autocomplete="off" placeholder="Exact receiving account name" /></div>
      </div>${qr(method,name)}`;
  }
  function render(items, receipt = {}) {
    const gcash = items.find(m=>m.code==='gcash') || {code:'gcash'};
    const standalone = items.filter(m=>!sharedCodes.has(m.code) && m.code!=='cash');
    return `<fieldset class="ps-payment-switches"><legend class="fl">Enabled payment methods</legend><div class="pm-toggle-grid">${items.map(method=>`<label class="pm-toggle"><input class="platform-method-active" type="checkbox" data-code="${esc(method.code)}" ${method.code==='cash'?'disabled title="Cash bookings are recorded by staff at the venue"':''} ${method.isActive?'checked':''} /><span class="pm-method-label">${mark(method.icon)}<span>${esc(method.displayName)}</span></span></label>`).join('')}</div></fieldset>
      <section class="ps-payment-card platform-payment-method" data-code="gcash" data-display-name="GCash" aria-labelledby="sharedGcashHeading">
        <h4 class="pm-brand-heading" id="sharedGcashHeading">${mark('gcash')} Shared GCash recipient</h4>
        <p>Used by GCash, BDO Pay, Maya, BPI, GoTyme and MariBank. All enabled methods send to this account.</p>
        ${accountFields(gcash,'GCash')}
      </section>
      <section class="ps-payment-card ps-payment-advanced" aria-labelledby="advancedGcashHeading">
        <h4 class="pm-brand-heading" id="advancedGcashHeading">${mark('gcash')} Advanced GCash QR receipt verification</h4>
        <p>Use the alias and destination token printed on receipts sent to your GCash QR. BDO Pay checks the full token; BPI checks the visible account suffix. If these details are missing, those receipts stay Pending for staff review.</p>
        <div class="ps-payment-fields"><div class="fg"><label class="fl" for="platformGcashQrAlias">GCash QR receipt alias</label><input class="fi" id="platformGcashQrAlias" maxlength="120" value="${esc(receipt.gcashQrAlias)}" placeholder="Your recipient name as printed on the receipt" autocomplete="off" /></div>
        <div class="fg"><label class="fl" for="platformGcashQrToken">GCash QR destination token</label><input class="fi" id="platformGcashQrToken" maxlength="120" value="${esc(receipt.gcashQrToken)}" placeholder="Exact destination token from your receipt" autocomplete="off" /></div></div>
      </section>
      ${['gotyme','maribank'].map(code=>{const method=items.find(m=>m.code===code);return `<section class="ps-payment-card ps-payment-route"><h4 class="pm-brand-heading">${mark(code)} ${esc(method.displayName)}</h4><p>Players pay from ${code==='gotyme'?'GoTyme':'MariBank'} to the shared GCash account above. Its dedicated receipt checker validates the recipient, amount, transaction reference and payment time.</p></section>`;}).join('')}
      ${standalone.map(method=>`<details class="ps-payment-card platform-payment-method" data-code="${esc(method.code)}" data-display-name="${esc(method.displayName)}" ${method.isActive?'open':''}><summary class="pm-brand-heading">${mark(method.icon)} ${esc(method.displayName)} receiving account</summary><div class="ps-payment-standalone">${accountFields(method,method.displayName)}<label class="fl" for="payment-instructions-${esc(method.code)}">Payment instructions</label><textarea class="fi platform-method-instructions" id="payment-instructions-${esc(method.code)}" maxlength="1000" rows="2">${esc(method.instructions)}</textarea></div></details>`).join('')}
      <p class="ps-payment-help">Cash bookings are recorded by staff at the venue. Successful receipt checks can confirm a booking automatically. Unclear receipts stay Pending, with Confirm and Reject available to staff.</p>`;
  }
  function collect(items, form) {
    const rowValues = row => ({accountName:row?.querySelector('.platform-method-account-name')?.value.trim() || '',
      accountReference:row?.querySelector('.platform-method-account-reference')?.value.trim() || '',
      qrImageUrl:row?.querySelector('.platform-method-qr-url')?.value.trim() || ''});
    const shared = rowValues(form.querySelector('[data-code="gcash"].platform-payment-method'));
    const selected = new Map([...form.querySelectorAll('.platform-method-active')].map(input=>[input.dataset.code,input.checked]));
    return items.filter(method=>method.code!=='cash').map((method,index)=>{
      const row = [...form.querySelectorAll('.platform-payment-method')].find(r=>r.dataset.code===method.code);
      const account = sharedCodes.has(method.code) ? shared : rowValues(row);
      const isActive = selected.get(method.code)===true;
      const hasAccount = !!(account.accountName || account.accountReference || account.qrImageUrl);
      return {...method,...account,isActive,sortOrder:index,
        // Empty unchecked methods are not configured solely by help text.
        // Partial accounts retain validation; configured disabled methods keep instructions.
        instructions:!isActive && !hasAccount ? '' : row?.querySelector('.platform-method-instructions')?.value.trim() || method.instructions || defaults[method.code] || '',
      };
    });
  }
  root.PBPaymentSettings = Object.freeze({definitions,canonical,methods,render,collect,sharedCodes:[...sharedCodes]});
})(window);
