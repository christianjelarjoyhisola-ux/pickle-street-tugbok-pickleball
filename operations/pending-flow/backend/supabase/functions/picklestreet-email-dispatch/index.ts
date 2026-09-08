import { createClient } from '@supabase/supabase-js';
import { requireHighEntropySecret, secretsMatch } from '../_shared/security.ts';
import { sendDuplicateRejectionEmail } from '../picklestreet-receipts/duplicate-rejection.ts';
import { createGroupedRescheduleEmailSender, dispatchDueGroupRescheduleEmails } from '../picklestreet-reschedule/email.ts';

const TENANT = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';

// This endpoint is invoked by the venue's scheduled outbox job, never by a player.
export async function dispatch(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  try {
    const secret = requireHighEntropySecret('PICKLESTREET_EMAIL_DISPATCH_SECRET', Deno.env.get('PICKLESTREET_EMAIL_DISPATCH_SECRET'));
    if (!await secretsMatch(request.headers.get('x-dispatch-secret'), secret)) {
      return Response.json({ ok: false }, { status: 401 });
    }
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const due = await db.from('picklestreet_rejection_emails').select('booking_id')
      .eq('tenant_id', TENANT).neq('status', 'sent')
      .or('lease_until.is.null,lease_until.lt.' + new Date().toISOString())
      .order('created_at').limit(10);
    if (due.error) throw new Error('Outbox unavailable');
    // The sender atomically leases each row; concurrent status reads cannot send it twice.
    const results = await Promise.all((due.data || []).map(row => sendDuplicateRejectionEmail(db, row.booking_id)));
    const grouped = await dispatchDueGroupRescheduleEmails(db, createGroupedRescheduleEmailSender());
    return Response.json({ ok: true, checked: results.length + grouped.checked, sent: results.filter(x => x === 'sent').length + grouped.sent });
  } catch {
    return Response.json({ ok: false, error: 'Email dispatch unavailable' }, { status: 503 });
  }
}

if (import.meta.main) Deno.serve(dispatch);
