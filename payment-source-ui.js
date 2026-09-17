(function paymentSourceUi(global) {
  'use strict';
  const NAMES = Object.freeze({gcash:'GCash',bdopay:'BDO Pay',maya:'Maya',bpi:'BPI',gotyme:'GoTyme',maribank:'MariBank',pnb:'PNB',cash:'Cash'});
  const SHARED_GCASH_SOURCES = Object.freeze(['gcash','bdopay','maya','bpi','gotyme','maribank']);
  function uiCode(value) {
    const code = String(value || '').trim().toLowerCase();
    return ['bdo','bdo_pay','bdopay'].includes(code) ? 'bdopay' : code;
  }
  function name(value, fallback = 'Payment') { return NAMES[uiCode(value)] || fallback; }
  function destination(value) { const code=uiCode(value);return SHARED_GCASH_SOURCES.includes(code) ? 'gcash' : code; }
  function label(value, fallback = 'Payment') {
    const code=uiCode(value),source=name(code,fallback);
    return destination(code)==='gcash' && code!=='gcash' ? source+' → GCash' : source;
  }
  function referenceRules(value) {
    const code=uiCode(value);
    const rules={
      gcash:{maxLength:13,inputMode:'numeric',label:'GCash reference number',placeholder:'13-digit GCash reference',help:'Enter the 13-digit GCash reference number.'},
      bdopay:{maxLength:32,inputMode:'text',label:'BDO Pay Reference no.',placeholder:'BN-YYYYMMDD-########',help:'Use BDO Pay Reference no., not the invoice number.'},
      maya:{maxLength:64,inputMode:'text',label:'Maya Reference ID',placeholder:'e.g. 769CD5AA7D92',help:'Enter the complete Reference ID shown on the Maya Transaction details screen. Each Reference ID can be used only once.'},
      bpi:{maxLength:20,inputMode:'numeric',label:'BPI Confirmation No.',placeholder:'BPI Confirmation No.',help:'Use BPI Confirmation No., not the Transaction Ref. No.'},
    };
    return rules[code] || {maxLength:64,inputMode:'text',label:name(code)+' transaction reference',placeholder:'Complete '+name(code)+' reference',help:'Enter the complete '+name(code)+' transaction reference, including letters and hyphens shown on the successful receipt.'};
  }
  function normalizeReference(value, method) {
    const code=uiCode(method),raw=String(value || ''),max=referenceRules(code).maxLength;
    if (code==='gcash' || code==='bpi') return raw.replace(/\D/g,'').slice(0,max);
    if (code==='bdopay') return raw.toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,max);
    return raw.toUpperCase().replace(/[^A-Z0-9 -]/g,'').slice(0,max);
  }
  function referenceError(value, method) {
    const code=uiCode(method),raw=String(value || '').trim();
    const compact=raw.toUpperCase().replace(/\s/g,'');
    const valid=code==='gcash' ? /^\d{13}$/.test(raw)
      : code==='bdopay' ? /^BN-?\d{8}-?\d{8}$/.test(compact)
      : code==='bpi' ? /^\d{10,20}$/.test(raw)
      : /^[A-Z0-9][A-Z0-9 -]{5,63}$/i.test(raw);
    return valid ? '' : referenceRules(code).help;
  }
  global.PaymentSourceUI=Object.freeze({uiCode,name,destination,label,referenceRules,normalizeReference,referenceError});
})(window);
