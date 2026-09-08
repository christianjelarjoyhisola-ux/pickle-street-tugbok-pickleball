import { publicRescheduleSessions } from './balance-status.ts';
Deno.test('group payment status exposes schedules without internal notes or receipt evidence',()=>{
  const rows=publicRescheduleSessions([{sessionId:'s1',courtId:'c1',courtName:'Court 1',startsAt:'2026-10-10T10:00:00Z',endsAt:'2026-10-10T11:00:00Z',durationHours:1,internalNote:'private',token_hash:'private',receipt:{secret:true}}]);
  if(rows.length!==1 || rows[0].courtName!=='Court 1' || 'internalNote' in rows[0] || 'token_hash' in rows[0] || 'receipt' in rows[0])throw new Error('Unsafe schedule projection');
});
Deno.test('missing grouped schedule metadata yields an empty session list',()=>{
  if(publicRescheduleSessions(null).length || publicRescheduleSessions({}).length)throw new Error('Unexpected schedule');
});
