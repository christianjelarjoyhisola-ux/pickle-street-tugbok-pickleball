import { RequestError } from '../_shared/http.ts';

export async function creditHistory(db: any, tenant: string, actor: string, offset: unknown) {
  const page = offset === undefined ? 0 : Number(offset);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) throw new RequestError(400,'PAGE_INVALID','Choose a valid history page.');
  const [owner,member] = await Promise.all([
    db.from('platform_profiles').select('user_id').eq('user_id',actor).eq('is_platform_owner',true).maybeSingle(),
    db.from('tenant_memberships').select('id').eq('tenant_id',tenant).eq('user_id',actor).eq('status','active').in('role',['owner','admin']).maybeSingle(),
  ]);
  if (owner.error || member.error) throw new RequestError(503,'ACCESS_UNAVAILABLE','Access could not be checked.');
  if (!owner.data && !member.data) throw new RequestError(403,'ACCESS_DENIED','Owner or administrator access is required.');
  const result = await db.from('picklestreet_weather_credits')
    .select('booking_id,email,minutes,balance_minutes,created_at,email_sent_at')
    .eq('tenant_id',tenant).order('created_at',{ascending:false}).order('id',{ascending:false}).range(page,page+50);
  if (result.error) throw new RequestError(503,'HISTORY_UNAVAILABLE','Credit history could not be loaded.');
  const rows = (result.data || []).slice(0,50);
  let bookings: any[] = [];
  if (rows.length) {
    const result = await db.from('bookings').select('id,reference,customer_name').eq('tenant_id',tenant).in('id',rows.map((r:any)=>r.booking_id));
    if (result.error) throw new RequestError(503,'HISTORY_UNAVAILABLE','Credit history could not be loaded.');
    bookings=result.data || [];
  }
  return {ok:true,hasMore:(result.data || []).length>50,credits:rows.map((r:any)=>{
    const booking=bookings.find(b=>b.id===r.booking_id);
    return {reference:booking?.reference || '',name:booking?.customer_name || '',email:r.email,minutes:r.minutes,balanceMinutes:r.balance_minutes,createdAt:r.created_at,emailSent:!!r.email_sent_at};
  })};
}
