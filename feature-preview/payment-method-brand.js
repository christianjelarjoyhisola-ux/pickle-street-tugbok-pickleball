(function paymentMethodBrandModule(root) {
  'use strict';

  const ICONS = Object.freeze({
    gcash: 'assets/payment-methods/gcash.png',
    bdopay: 'assets/payment-methods/bdo-pay.png',
    maya: 'assets/payment-methods/maya.png',
    bpi: 'assets/payment-methods/bpi.png',
    gotyme: 'assets/payment-methods/gotyme.png',
    maribank: 'assets/payment-methods/maribank.png',
    pnb: 'assets/payment-methods/pnb.png',
    cash: 'assets/payment-methods/cash.svg',
  });

  function normalize(method) {
    return String(method || '').trim().toLowerCase();
  }

  function iconSrc(method) {
    return ICONS[normalize(method)] || '';
  }

  function safeClasses(value) {
    return String(value || '')
      .split(/\s+/)
      .filter(name => /^[a-z0-9_-]+$/i.test(name))
      .join(' ');
  }

  function iconHtml(method, className = 'pm-icon') {
    const src = iconSrc(method);
    if (!src) return '';
    const classes = safeClasses(className) || 'pm-icon';
    return `<img class="${classes}" src="${src}" width="32" height="32" alt="" aria-hidden="true" decoding="async" />`;
  }

  function markHtml(method, modifier = '') {
    const key = normalize(method);
    const icon = iconHtml(key);
    if (!icon) return '';
    const extra = safeClasses(modifier);
    return `<span class="pm-brand-mark pm-brand-mark--${key}${extra ? ` ${extra}` : ''}" data-payment-method="${key}" aria-hidden="true">${icon}</span>`;
  }

  function renderLabel(element, method, label, modifier = 'pm-brand-mark--inline') {
    if (!element) return;
    const src = iconSrc(method);
    element.replaceChildren();
    element.classList.add('pm-method-label');
    if (src) {
      const mark = document.createElement('span');
      mark.className = `pm-brand-mark pm-brand-mark--${normalize(method)} ${safeClasses(modifier)}`.trim();
      mark.dataset.paymentMethod = normalize(method);
      mark.setAttribute('aria-hidden', 'true');
      const image = document.createElement('img');
      image.className = 'pm-icon';
      image.src = src;
      image.width = 32;
      image.height = 32;
      image.alt = '';
      image.setAttribute('aria-hidden', 'true');
      image.decoding = 'async';
      mark.appendChild(image);
      element.appendChild(mark);
    }
    const text = document.createElement('span');
    text.textContent = String(label || '');
    element.appendChild(text);
  }

  root.PaymentMethodBrand = Object.freeze({
    iconSrc,
    iconHtml,
    markHtml,
    renderLabel,
  });
})(window);
