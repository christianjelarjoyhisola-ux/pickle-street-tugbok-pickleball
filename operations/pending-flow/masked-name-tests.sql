create temp table critical_confidence_results(name text,passed boolean);
do $$
declare j jsonb; data jsonb; changed jsonb; result jsonb; field text; snapshot jsonb;
begin
 j:=pg_temp.ps_identity_begin(1,'gcash','9912345678901');
 data:=pg_temp.ps_identity_data(j);
 snapshot:=pg_temp.ps_identity_snapshot('gcash');
 data:=jsonb_set(data,'{confidence,vision}','0.8929');
 if public.picklestreet_receipt_route_ready('gcash',data,snapshot) then raise exception 'Low global score without field evidence accepted';end if;
 data:=jsonb_set(data,'{detected,route,fieldConfidenceVersion}','1');
 data:=jsonb_set(data,'{detected,route,fieldConfidence}','{"recipientName":0.99,"recipientAccount":0.99,"amount":0.99,"reference":0.99,"timestamp":0.99,"source":0.99,"success":0.99}');
 if not public.picklestreet_receipt_route_ready('gcash',data,snapshot) then raise exception 'Complete field confidence rejected';end if;
 foreach field in array array['recipientName','recipientAccount','amount','reference','timestamp','source','success'] loop
  changed:=jsonb_set(data,array['detected','route','fieldConfidence',field],'0.7');
  if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Weak critical field accepted: %',field;end if;
  changed:=data#-array['detected','route','fieldConfidence',field];
  if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Missing critical field accepted';end if;
  changed:=jsonb_set(data,array['detected','route','fieldConfidence',field],'"0.99"');
  if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Nonnumeric field accepted';end if;
 end loop;
 foreach field in array array['sourceMatched','destinationMatched','successMatched','recipientMatched','referenceMatched'] loop
  changed:=jsonb_set(data,array['detected','route',field],'false');
  if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Evidence gate bypassed: %',field;end if;
 end loop;
 changed:=jsonb_set(data,'{timing,withinWindow}','false');
 if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Timing bypassed';end if;
 changed:=jsonb_set(data,'{comparison,amountMatched}','false');
 if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Amount bypassed';end if;

 data:=jsonb_set(data,'{detected,route,fieldConfidence,recipientName}','0.6511968');
 data:=jsonb_set(data,'{detected,route,maskedNameExactAccountPolicy}','true');
 data:=jsonb_set(data,'{detected,route,recipient}',jsonb_build_object('observedName','T*** V. O.','observedNumber',snapshot->>'account','phoneMatch','exact','nameMatch','masked_compatible'));
 if not public.picklestreet_receipt_route_ready('gcash',data,snapshot) then raise exception 'Exact account masked policy not accepted';end if;
 foreach field in array array['amount','recipientAccount','reference','timestamp','source','success'] loop
   changed:=jsonb_set(data,array['detected','route','fieldConfidence',field],'0.7');
   if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Masked policy bypassed critical field';end if;
 end loop;
 changed:=jsonb_set(data,'{detected,route,recipient,observedNumber}','"09170000099"');
 if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Wrong account accepted';end if;
 changed:=jsonb_set(data,'{detected,route,recipient,observedNumber}','"0976***9684"');
 if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Partial account accepted';end if;
 changed:=jsonb_set(data,'{detected,route,recipient,nameMatch}','"mismatch"');
 if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Name mismatch accepted';end if;
 changed:=jsonb_set(data,'{detected,route,recipient,nameMatch}','"exact"');
 if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Unmasked name exception accepted';end if;
 changed:=data#-'{detected,route,fieldConfidence,recipientName}';
 if public.picklestreet_receipt_route_ready('gcash',changed,snapshot) then raise exception 'Missing name score accepted';end if;
  result:=pg_temp.ps_identity_finish(j,data,true);
 if not exists(select 1 from public.bookings where id=(j->>'testBookingId')::uuid and status='confirmed' and payment_status='paid') then raise exception 'End-to-end synthetic approval failed: %',result;end if;
 insert into critical_confidence_results values('Compatible masked name with exact full account passes database finalization',true),('Normal names retain seven-field checks; masked exception rejects wrong or partial accounts',true),('Source, recipient, success, reference, amount and timing gates preserved',true),('Original bookings preserved; all fixtures rolled back',true);
end $$;
