-- Place after BEGIN and BEFORE proposed migration to capture existing definitions.
create temporary table ps_hold_existing_functions as
select p.oid,p.proname,pg_get_function_identity_arguments(p.oid) signature,md5(pg_get_functiondef(p.oid)) fingerprint
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';
create function pg_temp.ps_hold_foreign_fingerprint() returns jsonb language plpgsql as $$
declare tab record;result jsonb:='{}';fingerprint text;
begin
  for tab in select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id'
    and table_name<>'picklestreet_provisional_holds' order by table_name
  loop
    execute format('select md5(coalesce(string_agg(to_jsonb(row_value)::text,E''\n'' order by to_jsonb(row_value)::text),'''')) from public.%I row_value where tenant_id is distinct from $1',tab.table_name)
      into fingerprint using 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'::uuid;
    result:=result||jsonb_build_object(tab.table_name,fingerprint);
  end loop;
  return result;
end;$$;
create temporary table ps_hold_foreign_before as select pg_temp.ps_hold_foreign_fingerprint() fingerprint;
