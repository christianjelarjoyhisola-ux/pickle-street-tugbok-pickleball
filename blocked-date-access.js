(function blockedDateAccessModule(global) {
  'use strict';

  const ALLOWED_DURATIONS = Object.freeze([0, 1, 2, 3]);

  function timestamp(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalize(raw, nowMs = Date.now()) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const expiresAtMs = timestamp(source.expiresAt ?? source.expires_at);
    const serverNow = source.serverNow ?? source.server_now ?? null;
    const serverNowMs = timestamp(serverNow);
    const suppliedOffset = Number(source.clockOffsetMs);
    const clockOffsetMs = Number.isFinite(suppliedOffset)
      ? suppliedOffset
      : serverNowMs === null ? 0 : serverNowMs - nowMs;
    const effectiveNowMs = nowMs + clockOffsetMs;
    const grantedAt = source.grantedAt ?? source.granted_at ?? null;
    const expiresAt = source.expiresAt ?? source.expires_at ?? null;
    const revokedAt = source.revokedAt ?? source.revoked_at ?? null;
    const durationDays = Number(source.durationDays ?? source.duration_days);
    const serverStatus = String(source.status || '').toLowerCase();
    const expired = expiresAtMs !== null && expiresAtMs <= effectiveNowMs;
    const unlimited = durationDays === 0 && expiresAt === 'infinity';
    const active = source.canManage === true && (unlimited || expiresAtMs !== null) && !revokedAt && !expired;
    const status = active
      ? 'active'
      : revokedAt || serverStatus === 'revoked'
        ? 'revoked'
        : expired || serverStatus === 'expired'
          ? 'expired'
          : serverStatus === 'unavailable'
            ? 'unavailable'
            : 'none';

    return Object.freeze({
      canManage: active,
      unlimited,
      status,
      durationDays: ALLOWED_DURATIONS.includes(durationDays) ? durationDays : null,
      grantedAt,
      expiresAt,
      expiresAtMs,
      revokedAt,
      serverNow,
      clockOffsetMs,
    });
  }

  function canManage(role, access, nowMs = Date.now()) {
    if (role === 'owner') return true;
    if (role !== 'court_owner') return false;
    const state = normalize(access, nowMs);
    return state.canManage && (state.unlimited || (state.expiresAtMs !== null && state.expiresAtMs > nowMs + state.clockOffsetMs));
  }

  function remainingParts(access, nowMs = Date.now()) {
    const state = normalize(access, nowMs);
    const remainingMs = state.expiresAtMs === null ? 0 : Math.max(0, state.expiresAtMs - nowMs - state.clockOffsetMs);
    const totalSeconds = Math.floor(remainingMs / 1000);
    return Object.freeze({
      remainingMs,
      days: Math.floor(totalSeconds / 86400),
      hours: Math.floor((totalSeconds % 86400) / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
    });
  }

  const api = Object.freeze({ ALLOWED_DURATIONS, normalize, canManage, remainingParts });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BlockedDateAccess = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
