-- ShippingCloud: copy PRODUCTION data into the SANDBOX tenant.
-- Run in Supabase → SQL Editor. Safe to re-run any time you want to
-- refresh the sandbox with current production data (it overwrites sandbox,
-- never touches production rows).
insert into app_stores (tenant, key, value, updated_at)
select 'sandbox', key, value, now()
from app_stores
where tenant = 'main'
on conflict (tenant, key)
do update set value = excluded.value, updated_at = excluded.updated_at;

-- check it worked (should show a matching row count for both tenants):
select tenant, count(*) from app_stores group by tenant;
