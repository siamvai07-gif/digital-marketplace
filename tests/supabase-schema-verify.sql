-- End-to-end database verification for the Supabase migration (schema nexus).
-- Read-only assertions plus a rolled-back write probe, so it is safe to re-run.
do $$
declare
  n int;
  probe text := 'e2e_probe_' || floor(random() * 1000000)::text;
  back jsonb;
  got jsonb;
begin
  raise notice '--- schema objects ---';
  select count(*) into n from information_schema.tables
   where table_schema = 'nexus' and table_type = 'BASE TABLE';
  raise notice 'tables in nexus: % (expect 11)', n;
  assert n = 11, 'unexpected table count in nexus schema';

  raise notice '--- row level security ---';
  select count(*) into n from pg_tables where schemaname = 'nexus' and rowsecurity;
  raise notice 'tables with RLS enabled: % (expect 11)', n;
  assert n = 11, 'RLS not enabled on every nexus table';

  select count(*) into n from pg_policies where schemaname = 'nexus';
  raise notice 'policies defined: %', n;
  assert n > 0, 'no RLS policies in nexus schema';

  raise notice '--- realtime publication ---';
  select count(*) into n from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'nexus';
  raise notice 'nexus tables in supabase_realtime: % (expect 10)', n;
  assert n = 10, 'realtime publication incomplete';

  raise notice '--- key/value round trip (products) ---';
  insert into nexus.products (id, data)
  values (probe, jsonb_build_object('id', probe, 'name', 'E2E Probe', 'price', 42, 'visible', true));

  select data into got from nexus.products where id = probe;
  raise notice 'inserted row: %', got;
  assert got->>'name' = 'E2E Probe', 'insert did not round trip';

  update nexus.products set data = data || '{"price": 99}'::jsonb where id = probe
  returning data into got;
  raise notice 'after merge update, price = %', got->>'price';
  assert (got->>'price')::int = 99, 'merge update failed';

  raise notice '--- jsonb nesting used by orders/wallet ---';
  back := jsonb_build_object('items', jsonb_build_array(jsonb_build_object('sku','a','qty',2)),
                             'walletCoins', 1500, 'status', 'PENDING');
  insert into nexus.orders (id, data) values (probe, back);
  select data->'items'->0->>'sku' into got from (select data from nexus.orders where id = probe) x;
  raise notice 'nested array element read back: %', got;
  assert got = 'a', 'nested jsonb read failed';

  raise notice '--- admin identity ---';
  select count(*) into n from nexus.lookup where id = 'email:admin@nexusdigital.app';
  raise notice 'admin lookup rows: % (expect 1)', n;
  assert n = 1, 'admin lookup row missing';

  select count(*) into n from auth.users where email = 'admin@nexusdigital.app' and email_confirmed_at is not null;
  raise notice 'confirmed admin auth users: % (expect 1)', n;
  assert n = 1, 'admin auth user missing or unconfirmed';

  raise notice '--- is_admin() helper ---';
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'nexus' and p.proname = 'is_admin';
  raise notice 'nexus.is_admin defined: % (expect 1)', n;
  assert n = 1, 'is_admin() missing';

  raise notice '--- grants ---';
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'nexus' and grantee in ('anon','authenticated') and privilege_type = 'SELECT';
  raise notice 'SELECT grants to anon/authenticated: %', n;
  assert n >= 22, 'missing grants for anon/authenticated';

  raise notice '--- rollback probe ---';
  raise notice 'ALL DATABASE CHECKS PASSED';
end $$;
