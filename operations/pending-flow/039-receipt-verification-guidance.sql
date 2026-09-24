-- Correct only the retired Maya reference-only policy's customer-facing copy.
-- No receipt status, booking, amount, or receiving account is modified.
begin;
update public.tenant_payment_methods
set instructions = 'In Maya, use Bank Transfer to GCash. Enter the Reference ID and upload completed transaction details showing the recipient, amount, reference, and transaction date and time. Processing receipts stay pending. Each Reference ID can be used only once.'
where tenant_id = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'
  and method_code = 'maya'
  and instructions like '%Completed or Processing can auto-verify%';
commit;
