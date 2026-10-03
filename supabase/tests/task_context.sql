-- Run after both migrations with a local administrative PostgreSQL connection.
-- All fixtures, helper functions, and mutations are rolled back.
begin;

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

do $$
declare
  v_owner uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_message uuid;
  v_purchase uuid;
  v_second uuid;
  v_foreign uuid;
  v_task uuid;
  v_done uuid;
  v_cancelled uuid;
  v_missing uuid := gen_random_uuid();
  v_data jsonb;
  v_value jsonb;
  v_category text;
  v_destinations jsonb;
  v_ids jsonb;
  v_failed boolean;
begin
  insert into auth.users(id) values (v_owner), (v_other);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('shopping_test.owner', v_owner::text, true);
  perform set_config('shopping_test.other', v_other::text, true);
  perform public.ensure_profile();

  -- Legacy task proposals retain their defaults.
  v_message := pg_temp.propose('{"op":"add_task","currency":"USD","data":{"description":"Legacy"}}');
  if public.confirm_action(v_message) is distinct from true then
    raise exception 'Legacy add_task failed';
  end if;
  select id into strict v_task from public.tasks
  where user_id = v_owner and description = 'Legacy'
    and kind = 'task' and category is null
    and destinations = '[]' and not next_trip;

  -- Categories are arbitrary task context, including the maximum length.
  v_message := pg_temp.propose('{"op":"add_task","currency":"USD","data":{"description":"Uncategorized","kind":"purchase"}}');
  if not public.confirm_action(v_message) then
    raise exception 'Uncategorized purchase failed';
  end if;
  select id into strict v_second from public.tasks
  where user_id = v_owner and description = 'Uncategorized'
    and category is null and destinations = '[]' and not next_trip;

  select jsonb_agg(repeat('x', 198) || lpad(i::text, 2, '0') order by i)
  into v_destinations from generate_series(1, 10) i;
  foreach v_category in array array['Personal errands', 'Equipment repairs', repeat('c', 100)] loop
    v_data := jsonb_build_object('description', v_category, 'kind', 'purchase',
      'category', v_category, 'destinations', v_destinations, 'next_trip', true,
      'location', jsonb_build_object('label', 'Store'), 'base_priority', 5,
      'estimated_cost_minor', 1234, 'duration_minutes', 30, 'deadline', '2026-10-05');
    v_message := pg_temp.propose(jsonb_build_object('op', 'add_task', 'currency', 'USD', 'data', v_data));
    if not public.confirm_action(v_message) then
      raise exception 'Valid category/bounds failed';
    end if;
  end loop;
  select id into strict v_purchase from public.tasks
  where user_id = v_owner and description = 'Personal errands';
  -- Preexisting metadata is not proposal-writable and must survive task changes.
  update public.tasks set metadata = '{"existing":"Preserved"}'
  where id in (v_purchase, v_task);

  v_message := pg_temp.propose(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_purchase, 'description', 'Renamed')));
  if not public.confirm_action(v_message) then
    raise exception 'Partial update failed';
  end if;
  if not exists (
    select 1 from public.tasks where id = v_purchase and description = 'Renamed'
      and kind = 'purchase' and category = 'Personal errands'
      and destinations = v_destinations and next_trip
      and metadata = '{"existing":"Preserved"}'
      and location = '{"label":"Store"}' and base_priority = 5
      and estimated_cost_minor = 1234 and duration_minutes = 30 and deadline = '2026-10-05'
  ) then
    raise exception 'Partial update lost existing fields';
  end if;
  v_message := pg_temp.propose(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_purchase, 'category', null)));
  if not public.confirm_action(v_message) then
    raise exception 'Explicit category null confirmation failed';
  end if;
  if not exists (
    select 1 from public.tasks where id = v_purchase and category is null
      and destinations = v_destinations and next_trip and kind = 'purchase'
  ) then
    raise exception 'Explicit category null did not preserve other fields';
  end if;
  v_message := pg_temp.propose(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_second, 'category', 'Custom grouping',
      'destinations', jsonb_build_array('Store'), 'next_trip', true)));
  if not public.confirm_action(v_message) then
    raise exception 'Shopping field confirmation failed';
  end if;
  if not exists (
    select 1 from public.tasks where id = v_second and category = 'Custom grouping'
      and destinations = '["Store"]' and next_trip and kind = 'purchase'
  ) then
    raise exception 'Shopping field update failed';
  end if;
  v_message := pg_temp.propose(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_second, 'next_trip', false)));
  if not public.confirm_action(v_message) then
    raise exception 'Partial next_trip update failed';
  end if;
  if not exists (
    select 1 from public.tasks where id = v_second and not next_trip
      and category = 'Custom grouping' and destinations = '["Store"]'
  ) then
    raise exception 'Partial next_trip update lost category/destinations';
  end if;
  v_message := pg_temp.propose(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_second, 'destinations', '[]'::jsonb)));
  if not public.confirm_action(v_message) then
    raise exception 'Partial destinations update failed';
  end if;
  if not exists (
    select 1 from public.tasks where id = v_second and not next_trip
      and category = 'Custom grouping' and destinations = '[]'
  ) then
    raise exception 'Partial destinations update lost category/next_trip';
  end if;
  -- Validate new fields for both additions and updates, including null/type errors.
  for v_data in select value from jsonb_array_elements(
    '[
      {"kind":"unknown"}, {"kind":null}, {"kind":1},
      {"category":""}, {"category":" "}, {"category":" Leading"},
      {"category":"Trailing "}, {"category":"\tLeading"}, {"category":true},
      {"category":1}, {"category":[]}, {"category":{}},
      {"next_trip":"true"}, {"next_trip":1}, {"next_trip":null},
      {"destinations":null}, {"destinations":{}}, {"destinations":"Store"},
      {"destinations":[""]}, {"destinations":[" "]}, {"destinations":[" Store"]},
      {"destinations":["Store "]}, {"destinations":["\tStore"]},
      {"destinations":["Store\n"]}, {"destinations":[null]},
      {"destinations":[1]}, {"destinations":[{}]},
      {"destinations":["Store","Store"]}, {"destinations":["Store","sTORE"]},
      {"user_id":"00000000-0000-0000-0000-000000000000"},
      {"metadata":null}, {"metadata":[]}, {"metadata":"text"}, {"metadata":{}},
      {"metadata":{"existing":"Overwrite attempt"}},
      {"purchase_category":"Removed field"}
    ]'::jsonb
  ) loop
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'add_task', 'currency', 'USD',
      'data', jsonb_build_object('description', 'Invalid', 'kind', 'purchase') || v_data));
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'currency', 'USD',
      'data', jsonb_build_object('id', v_purchase) || v_data));
  end loop;
  foreach v_value in array array[
    jsonb_build_array(repeat('x', 201)), v_destinations || jsonb_build_array('Eleventh')
  ] loop
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'add_task', 'currency', 'USD',
      'data', jsonb_build_object('description', 'Invalid', 'kind', 'purchase', 'destinations', v_value)));
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'currency', 'USD',
      'data', jsonb_build_object('id', v_purchase, 'destinations', v_value)));
  end loop;
  foreach v_data in array array[
    jsonb_build_object('category', repeat('c', 101))
  ] loop
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'add_task', 'currency', 'USD',
      'data', jsonb_build_object('description', 'Invalid bounds') || v_data));
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'currency', 'USD',
      'data', jsonb_build_object('id', v_task) || v_data));
  end loop;
  v_message := pg_temp.propose(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_task, 'category', 'Maintenance',
      'destinations', jsonb_build_array('Garage'), 'next_trip', true)));
  if not public.confirm_action(v_message) then
    raise exception 'Ordinary task context update failed';
  end if;
  if not exists (select 1 from public.tasks where id = v_task and kind = 'task'
    and category = 'Maintenance' and destinations = '["Garage"]' and next_trip
    and metadata = '{"existing":"Preserved"}') then
    raise exception 'Ordinary tasks cannot retain generic context';
  end if;
  v_message := pg_temp.propose('{"op":"add_task","currency":"USD","data":{"description":"Ordinary context","kind":"task","category":"Appointments","destinations":["Clinic"],"next_trip":true}}');
  if not public.confirm_action(v_message) then
    raise exception 'Ordinary task context addition failed';
  end if;
  if not exists (select 1 from public.tasks where description = 'Ordinary context'
    and user_id = v_owner and category = 'Appointments' and destinations = '["Clinic"]'
    and next_trip and metadata = '{}') then
    raise exception 'Ordinary task context addition lost fields';
  end if;
  v_message := pg_temp.propose(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_purchase, 'kind', 'task')));
  if not public.confirm_action(v_message) then
    raise exception 'Conversion to ordinary task failed';
  end if;
  if not exists (select 1 from public.tasks where id = v_purchase and kind = 'task'
    and destinations = v_destinations and next_trip
    and metadata = '{"existing":"Preserved"}') then
    raise exception 'Kind change lost generic context';
  end if;
  v_message := pg_temp.propose(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_purchase, 'kind', 'purchase')));
  if not public.confirm_action(v_message) then
    raise exception 'Conversion back to purchase failed';
  end if;

  -- Constraints also protect direct writes, not just the RPC.
  for v_data in select value from jsonb_array_elements(
    '[
      {"kind":"invalid"}, {"kind":null}, {"category":""}, {"category":" Untrimmed"},
      {"destinations":null}, {"destinations":["Store","store"]},
      {"destinations":{}}, {"destinations":[""]}
    ]'
  ) loop
    v_failed := false;
    begin
      insert into public.tasks(user_id, description, kind, category, destinations, next_trip)
      values (v_owner, 'Invalid direct write',
        case when v_data ? 'kind' then v_data ->> 'kind' else 'purchase' end,
        v_data ->> 'category',
        coalesce(v_data -> 'destinations', '[]'::jsonb),
        coalesce((v_data ->> 'next_trip')::boolean, false));
    exception when check_violation or not_null_violation then
      v_failed := true;
    end;
    if not v_failed then
      raise exception 'Direct write bypassed constraints: %', v_data;
    end if;
  end loop;

  insert into public.tasks(user_id, description, kind)
  values (v_other, 'Foreign purchase', 'purchase') returning id into v_foreign;
  insert into public.tasks(user_id, description, kind, status)
  values (v_owner, 'Done purchase', 'purchase', 'done') returning id into v_done;
  insert into public.tasks(user_id, description, kind, status)
  values (v_owner, 'Cancelled purchase', 'purchase', 'cancelled') returning id into v_cancelled;
  perform set_config('shopping_test.foreign_task', v_foreign::text, true);

  -- Owner scoping also holds for single-task mutations and proposal ownership.
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'currency', 'USD',
    'data', jsonb_build_object('id', v_foreign, 'next_trip', true)));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'delete_task',
    'data', jsonb_build_object('id', v_foreign)));
  insert into public.messages(user_id, role, content, proposal, action_state)
  values (v_other, 'assistant', 'Foreign proposal',
    jsonb_build_object('op', 'complete_tasks', 'data', jsonb_build_object('ids', jsonb_build_array(v_foreign))),
    'pending') returning id into v_message;
  perform set_config('shopping_test.foreign_message', v_message::text, true);
  if public.confirm_action(v_message) is distinct from false then
    raise exception 'Foreign proposal could be consumed';
  end if;
  if public.cancel_action(v_message) is distinct from false then
    raise exception 'Foreign proposal could be cancelled';
  end if;

  -- Preserve currency checks, existing field validation, and currency relabel protection.
  perform pg_temp.reject_proposal('{"op":"add_task","data":{"description":"Missing currency","kind":"purchase"}}');
  perform pg_temp.reject_proposal('{"op":"add_task","currency":"EUR","data":{"description":"Stale currency","kind":"purchase"}}');
  perform pg_temp.reject_proposal('{"op":"set_profile","currency":"USD","data":{"currency":"EUR"}}');
  if (select currency from public.profiles where id = v_owner) <> 'USD' then
    raise exception 'Currency changed while tasks existed';
  end if;
  for v_data in select value from jsonb_array_elements(
    '[{"estimated_cost_minor":-1},{"duration_minutes":0},{"base_priority":6},
      {"estimated_cost_minor":1.5},{"location":"Store"},{"deadline":"invalid"},
      {"status":"invalid"},{"description":""}]'
  ) loop
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'update_task', 'currency', 'USD',
      'data', jsonb_build_object('id', v_purchase) || v_data));
  end loop;

  -- A mixed valid/invalid batch must never partially complete or confirm.
  foreach v_value in array array[
    to_jsonb(v_missing), to_jsonb(v_foreign), to_jsonb(v_done), to_jsonb(v_cancelled)
  ] loop
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks',
      'data', jsonb_build_object('ids', jsonb_build_array(v_purchase, v_value))));
  end loop;
  for v_data in select value from jsonb_array_elements(
    '[{}, {"ids":null}, {"ids":"bad"}, {"ids":{}}, {"ids":[]},
      {"ids":[null]}, {"ids":[1]}, {"ids":[true]}, {"ids":[{}]},
      {"ids":["bad"]}, {"ids":[""]}, {"ids":[[]]}]'
  ) loop
    perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks', 'data', v_data));
  end loop;
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_purchase, v_purchase))));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_purchase, upper(v_purchase::text)))));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_purchase), 'status', 'done')));
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_purchase), 'user_id', v_other)));
  select jsonb_agg(gen_random_uuid()) into v_ids from generate_series(1, 21);
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', v_ids)));

  -- Cancellation and retry are no-ops; successful completion needs no currency.
  v_message := pg_temp.propose(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_purchase, v_second))));
  if public.cancel_action(v_message) is distinct from true then
    raise exception 'Cancellation failed';
  end if;
  if public.cancel_action(v_message) is distinct from false then
    raise exception 'Cancellation retry was not a no-op';
  end if;
  if public.confirm_action(v_message) is distinct from false then
    raise exception 'Cancelled proposal could be confirmed';
  end if;
  if (select action_state from public.messages where id = v_message) <> 'cancelled'
    or exists (select 1 from public.tasks where id in (v_purchase, v_second) and status <> 'open') then
    raise exception 'Cancelled proposal changed tasks';
  end if;
  v_message := pg_temp.propose(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_second, v_task, v_purchase))));
  if public.confirm_action(v_message) is distinct from true then
    raise exception 'Batch confirmation failed';
  end if;
  if (select action_state from public.messages where id = v_message) <> 'confirmed'
    or (select count(*) from public.tasks where id in (v_purchase, v_second, v_task) and status = 'done') <> 3 then
    raise exception 'Batch did not complete atomically';
  end if;
  if not exists (select 1 from public.tasks where id = v_task and kind = 'task'
    and category = 'Maintenance' and destinations = '["Garage"]' and next_trip
    and metadata = '{"existing":"Preserved"}') then
    raise exception 'Completion changed generic task context';
  end if;
  update public.tasks set status = 'open' where id = v_purchase;
  if public.confirm_action(v_message) is distinct from false then
    raise exception 'Confirmation retry was not a no-op';
  end if;
  if (select status from public.tasks where id = v_purchase) <> 'open' then
    raise exception 'Confirmation retry reapplied completion';
  end if;
  perform pg_temp.reject_proposal(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_second))));
  v_message := pg_temp.propose(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_purchase))));
  if not public.confirm_action(v_message) then
    raise exception 'Single-item batch failed';
  end if;

  with inserted as (
    insert into public.tasks(user_id, description, kind)
    select v_owner, 'Maximum batch ' || i,
      case when i % 2 = 0 then 'task' else 'purchase' end from generate_series(1, 20) i
    returning id
  )
  select jsonb_agg(id) into v_ids from inserted;
  v_message := pg_temp.propose(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', v_ids)));
  if not public.confirm_action(v_message) then
    raise exception 'Maximum batch confirmation failed';
  end if;
  if (select count(*) from public.tasks where id in (
      select (value #>> '{}')::uuid from jsonb_array_elements(v_ids)
    ) and status = 'done') <> 20 then
    raise exception 'Maximum batch failed';
  end if;
  if (select status from public.tasks where id = v_foreign) <> 'open'
    or (select status from public.tasks where id = v_task) <> 'done'
    or (select status from public.tasks where id = v_cancelled) <> 'cancelled' then
    raise exception 'Completion changed unrelated tasks';
  end if;

  insert into public.tasks(user_id, description, kind)
  values (v_owner, 'Authenticated batch', 'task') returning id into v_purchase;
  v_message := pg_temp.propose(jsonb_build_object('op', 'complete_tasks',
    'data', jsonb_build_object('ids', jsonb_build_array(v_purchase))));
  perform set_config('shopping_test.owned_message', v_message::text, true);
  perform set_config('shopping_test.owned_task', v_purchase::text, true);

  perform set_config('request.jwt.claim.sub', '', true);
  v_failed := false;
  begin
    perform public.confirm_action(v_message);
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed or (select action_state from public.messages where id = v_message) <> 'pending' then
    raise exception 'Unauthenticated confirmation was accepted';
  end if;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
end;
$$;

-- Existing non-shopping operations still confirm and mutate their owner records.
do $$
declare
  v_message uuid;
  v_id uuid;
begin
  v_message := pg_temp.propose('{"op":"add_asset","currency":"USD","data":{"description":"Asset regression","value_minor":100,"notes":"Before"}}');
  if not public.confirm_action(v_message) then
    raise exception 'add_asset regression';
  end if;
  select id into strict v_id from public.assets where user_id = auth.uid() and description = 'Asset regression';
  v_message := pg_temp.propose(jsonb_build_object('op', 'update_asset', 'currency', 'USD',
    'data', jsonb_build_object('id', v_id, 'notes', 'After')));
  if not public.confirm_action(v_message) then
    raise exception 'update_asset regression';
  end if;
  if not exists (select 1 from public.assets where id = v_id and notes = 'After' and value_minor = 100) then
    raise exception 'Asset partial update lost fields';
  end if;
  v_message := pg_temp.propose(jsonb_build_object('op', 'delete_asset', 'data', jsonb_build_object('id', v_id)));
  if not public.confirm_action(v_message) then
    raise exception 'delete_asset regression';
  end if;
  if exists (select 1 from public.assets where id = v_id) then
    raise exception 'Asset was not deleted';
  end if;

  v_message := pg_temp.propose('{"op":"set_profile","currency":"USD","data":{"timezone":"America/New_York","preferences":"SQL test","budget_minor":5000}}');
  if not public.confirm_action(v_message) then
    raise exception 'set_profile regression';
  end if;
  if not exists (
    select 1 from public.profiles where id = auth.uid() and currency = 'USD'
      and timezone = 'America/New_York' and preferences = 'SQL test' and budget_minor = 5000
  ) then
    raise exception 'Profile partial update failed';
  end if;
  perform pg_temp.reject_proposal('{"op":"set_profile","currency":"USD","data":{"timezone":"Not/A_Zone"}}');

  v_message := pg_temp.propose(jsonb_build_object('op', 'add_reminder', 'data',
    jsonb_build_object('description', 'Reminder regression', 'cron', '0 9 * * *',
      'timezone', 'UTC', 'next_run', '2026-10-05T09:00:00Z')));
  if not public.confirm_action(v_message) then
    raise exception 'add_reminder regression';
  end if;
  select id into strict v_id from public.reminders where user_id = auth.uid() and description = 'Reminder regression';
  v_message := pg_temp.propose(jsonb_build_object('op', 'delete_reminder', 'data', jsonb_build_object('id', v_id)));
  if not public.confirm_action(v_message) then
    raise exception 'delete_reminder regression';
  end if;
  if exists (select 1 from public.reminders where id = v_id) then
    raise exception 'Reminder was not deleted';
  end if;

  v_message := pg_temp.propose('{"op":"add_task","currency":"USD","data":{"description":"Delete regression","kind":"purchase","category":null}}');
  if not public.confirm_action(v_message) then
    raise exception 'Explicit null category addition failed';
  end if;
  select id into strict v_id from public.tasks where user_id = auth.uid() and description = 'Delete regression';
  v_message := pg_temp.propose(jsonb_build_object('op', 'delete_task', 'data', jsonb_build_object('id', v_id)));
  if not public.confirm_action(v_message) then
    raise exception 'delete_task regression';
  end if;
  if exists (select 1 from public.tasks where id = v_id) then
    raise exception 'Task was not deleted';
  end if;
end;
$$;

set local role authenticated;

do $$
declare
  v_message uuid := current_setting('shopping_test.owned_message')::uuid;
  v_task uuid := current_setting('shopping_test.owned_task')::uuid;
  v_failed boolean := false;
begin
  if exists (select 1 from public.tasks
    where user_id = current_setting('shopping_test.other')::uuid)
    or exists (select 1 from public.messages
      where id = current_setting('shopping_test.foreign_message')::uuid) then
    raise exception 'RLS exposed foreign records';
  end if;
  if public.confirm_action(current_setting('shopping_test.foreign_message')::uuid) is distinct from false then
    raise exception 'Authenticated role consumed foreign proposal';
  end if;
  if public.confirm_action(v_message) is distinct from true then
    raise exception 'Authenticated completion failed';
  end if;
  if public.confirm_action(v_message) is distinct from false then
    raise exception 'Authenticated retry was not a no-op';
  end if;
  if (select status from public.tasks where id = v_task) <> 'done' then
    raise exception 'Authenticated completion did not change status';
  end if;
  begin
    update public.tasks set next_trip = true where id = v_task;
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Authenticated role bypassed confirmation';
  end if;
end;
$$;

rollback;
