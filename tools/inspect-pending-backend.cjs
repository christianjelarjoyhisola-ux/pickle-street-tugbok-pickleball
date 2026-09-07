'use strict';
const fs = require('node:fs');
const path = require('node:path');
const base = 'https://api.supabase.com/v1/projects/neqvrwtofiolcuxewdze';
const out = path.resolve(__dirname, '../operations/pending-flow/deployed');
async function main() {
  if (!process.env.SUPABASE_ACCESS_TOKEN) throw Error('Management authentication unavailable');
  fs.mkdirSync(out, {recursive:true});
  const headers = {Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`};
  const query = `select p.proname, pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and (p.proname ~ '(receipt|booking.*status|expire|release.*hold|payment.*session|booking.*cancel|booking.*hold|payment_review|tenant.*booking)' or p.proname in ('can_manage_tenant','is_system_owner','get_tenant_bookings')) order by p.proname`;
  const res = await fetch(base+'/database/query',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({query,read_only:true})});
  if (!res.ok) throw Error('Schema inspection failed: '+res.status);
  const functions = await res.json();
  fs.writeFileSync(path.join(out,'functions.json'),JSON.stringify(functions,null,2));
  console.log('Saved live function definitions:',functions.map(f=>f.proname).join(', '));
  const tables = "('bookings','booking_slots','receipt_verifications','payment_sessions','staged_payment_receipt_uploads','booking_balance_requests')";
  for (const [name,sql] of Object.entries({
    columns:`select table_name,column_name,data_type,column_default,is_nullable from information_schema.columns where table_schema='public' and table_name in ${tables} order by table_name,ordinal_position`,
    constraints:`select c.relname,con.conname,pg_get_constraintdef(con.oid) as definition from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ${tables}`,
    indexes:`select tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename in ${tables}`,
    triggers:`select c.relname,t.tgname,pg_get_triggerdef(t.oid) as definition,pg_get_functiondef(t.tgfoid) as function_definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ${tables} and not t.tgisinternal`,
  })) {
    const r=await fetch(base+'/database/query',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({query:sql,read_only:true})});
    if(!r.ok) throw Error('Metadata inspection failed '+r.status);
    fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(await r.json(),null,2));
  }
  for (const slug of []) {
    const r=await fetch(base+'/functions/'+slug+'/body',{headers});
    if(!r.ok){ console.log(slug,r.status); continue; }
    const bytes=Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(path.join(out,slug+'.bundle'),bytes);
    console.log(slug,r.headers.get('content-type'),bytes.length,bytes.subarray(0,8).toString('hex'));
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
