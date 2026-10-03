-- Task-only model: ownership, input bounds, open-task cap, asset rejection,
-- atomic batches and retry safety. All fixtures are rolled back.
begin;

create extension if not exists pgtap with schema extensions;
select plan(1);

create function pg_temp.propose(p_proposal jsonb)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into public.messages(user_id, role, content, proposal, action_state)
  values (auth.uid(), 'assistant', 'SQL test proposal', p_proposal, 'pending')
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.reject_proposal(p_proposal jsonb)
returns void
language plpgsql
as $$
declare
  v_id uuid := pg_temp.propose(p_proposal);
  v_failed boolean := false;
  v_before jsonb;
begin
  select jsonb_agg(to_jsonb(t) order by id) into v_before from public.tasks t;
  begin
    perform public.confirm_action(v_id);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Expected rejection: %', p_proposal;
  end if;
  if (select action_state from public.messages where id = v_id) <> 'pending' then
    raise exception 'Rejected proposal was consumed';
  end if;
  if v_before is distinct from (
    select jsonb_agg(to_jsonb(t) order by id) from public.tasks t
  ) then
    raise exception 'Rejected proposal partially mutated tasks';
  end if;
end;
$$;

create function pg_temp.accept(p_proposal jsonb)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := pg_temp.propose(p_proposal);
begin
  if public.confirm_action(v_id) is distinct from true then
    raise exception 'Expected confirmation: %', p_proposal;
  end if;
  if public.confirm_action(v_id) is distinct from false then
    raise exception 'Retry was not a no-op: %', p_proposal;
  end if;
  return v_id;
end;
$$;

do $$
declare
  v_owner uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_task uuid;
  v_second uuid;
  v_foreign uuid;
  v_message uuid;
  v_row public.tasks%rowtype;
begin
  insert into auth.users(id) values (v_owner), (v_other);

  perform set_config('request.jwt.claim.sub', v_other::text, true);
  perform pg_temp.accept('{"op":"add_task","data":{"name":"Foreign","short_description":"Other account"}}');
  select id into strict v_foreign from public.tasks where user_id = v_other;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform public.ensure_profile();

  -- Defaults and the full field set.
  perform pg_temp.accept('{"op":"add_task","data":{"name":"Milk","short_description":"Buy oat milk"}}');
  select * into strict v_row from public.tasks where user_id = v_owner and name = 'Milk';
  v_task := v_row.id;
  if v_row.priority <> 3 or v_row.status <> 'open' or v_row.full_description is not null
     or v_row.location_name is not null or v_row.due_date is not null
     or v_row.completed_at is not null then
    raise exception 'Unexpected task defaults';
  end if;
  perform pg_temp.accept(jsonb_build_object('op', 'add_task', 'data', jsonb_build_object(
    'name', repeat('n', 80), 'short_description', repeat('s', 160),
    'full_description', repeat('f', 10000), 'location_name', repeat('l', 100),
    'priority', 5, 'due_date', '2026-10-05')));
  select id into strict v_second from public.tasks where name = repeat('n', 80);

  -- Input checks.
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"Only name"}}');
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"short_description":"Only short"}}');
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'add_task', 'data',
    jsonb_build_object('name', repeat('n', 81), 'short_description', 's')));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'add_task', 'data',
    jsonb_build_object('name', 'n', 'short_description', repeat('s', 161))));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'add_task', 'data',
    jsonb_build_object('name', 'n', 'short_description', 's', 'full_description', repeat('f', 10001))));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'add_task', 'data',
    jsonb_build_object('name', 'n', 'short_description', 's', 'location_name', repeat('l', 101))));
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":" padded","short_description":"s"}}');
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"n","short_description":"s","location_name":{"label":"Home"}}}');
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"n","short_description":"s","priority":6}}');
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"n","short_description":"s","priority":"3"}}');
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"n","short_description":"s","due_date":"2026-02-30"}}');
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"n","short_description":"s","status":"done"}}');
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"n","short_description":"s","kind":"purchase"}}');
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"n","short_description":"s","user_id":"00000000-0000-0000-0000-000000000000"}}');
  perform pg_temp.reject_proposal('{"op":"add_task","currency":"USD","data":{"name":"n","short_description":"s"}}');
  perform pg_temp.reject_proposal('{"op":"add_asset","data":{"description":"Bike","value_minor":1}}');
  perform pg_temp.reject_proposal('{"op":"set_profile","data":{"currency":"SEK"}}');
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', v_task, 'full_description', 'Without a new summary')));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', v_task, 'status', 'archived')));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', v_task)));

  -- Ownership: foreign targets are rejected and unchanged.
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', v_foreign, 'name', 'Stolen')));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'delete_task', 'data',
    jsonb_build_object('id', v_foreign)));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks', 'data',
    jsonb_build_object('ids', jsonb_build_array(v_task, v_foreign))));
  if (select status from public.tasks where id = v_task) <> 'open' then
    raise exception 'Mixed-owner batch partially completed';
  end if;

  -- Partial updates preserve other fields and maintain timestamps.
  perform pg_temp.accept(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', v_second, 'name', 'Renamed')));
  select * into strict v_row from public.tasks where id = v_second;
  if v_row.short_description <> repeat('s', 160) or v_row.priority <> 5
     or v_row.location_name <> repeat('l', 100) or v_row.due_date <> '2026-10-05'
     or v_row.full_description <> repeat('f', 10000) then
    raise exception 'Partial update lost fields';
  end if;
  perform pg_temp.accept(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', v_second, 'full_description', 'New', 'short_description', 'New summary',
      'location_name', null, 'due_date', null)));
  perform pg_temp.accept(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', v_second, 'status', 'done')));
  select * into strict v_row from public.tasks where id = v_second;
  if v_row.full_description <> 'New' or v_row.location_name is not null
     or v_row.completed_at is null or v_row.status <> 'done' then
    raise exception 'Status/description update failed';
  end if;
  perform pg_temp.accept(jsonb_build_object('op', 'complete_tasks', 'data',
    jsonb_build_object('ids', jsonb_build_array(v_task))));
  if (select completed_at from public.tasks where id = v_task) is null then
    raise exception 'Completion did not record completed_at';
  end if;
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks', 'data',
    jsonb_build_object('ids', jsonb_build_array(v_task))));

  -- Open-task cap: 300 open tasks, including reopening.
  insert into public.tasks(user_id, name, short_description)
  select v_owner, 'Bulk ' || i, 'Bulk' from generate_series(1, 300) i;
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"name":"Too many","short_description":"Cap"}}');
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', v_task, 'status', 'open')));
  perform pg_temp.accept(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', (select id from public.tasks where name = 'Bulk 1'), 'priority', 1)));
  perform pg_temp.accept(jsonb_build_object('op', 'update_task', 'data',
    jsonb_build_object('id', (select id from public.tasks where name = 'Bulk 1'), 'status', 'cancelled')));
  perform pg_temp.accept('{"op":"add_task","data":{"name":"Fits again","short_description":"Cap"}}');
  if (select count(*) from public.tasks where user_id = v_owner and status = 'open') <> 300 then
    raise exception 'Open-task cap miscounted';
  end if;
  if (select count(*) from public.tasks where user_id = v_other) <> 1 then
    raise exception 'Cap or writes affected another account';
  end if;

  perform set_config('task_test.foreign', v_foreign::text, true);
  perform set_config('task_test.task', v_task::text, true);
end;
$$;

-- Authenticated users can read only their own rows and cannot write directly.
set local role authenticated;
do $$
declare
  v_failed boolean := false;
begin
  if exists (select 1 from public.tasks where id = current_setting('task_test.foreign')::uuid) then
    raise exception 'RLS exposed another account''s task';
  end if;
  begin
    update public.tasks set name = 'Direct' where id = current_setting('task_test.task')::uuid;
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Authenticated role bypassed confirmation';
  end if;
end;
$$;
reset role;

select pass('Task model, ownership, bounds, cap, atomicity and retry assertions passed');
select * from finish();

rollback;
