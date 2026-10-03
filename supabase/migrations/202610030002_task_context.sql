begin;

create function public.valid_task_destinations(p_destinations jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_label jsonb;
  v_labels text[] := array[]::text[];
  v_text text;
begin
  if jsonb_typeof(p_destinations) is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(p_destinations) > 10 then
    return false;
  end if;
  for v_label in select value from jsonb_array_elements(p_destinations) loop
    if jsonb_typeof(v_label) <> 'string' then
      return false;
    end if;
    v_text := v_label #>> '{}';
    if length(v_text) not between 1 and 200
      or v_text ~ '^[[:space:]]|[[:space:]]$'
      or lower(v_text) = any(v_labels) then
      return false;
    end if;
    v_labels := array_append(v_labels, lower(v_text));
  end loop;
  return true;
end;
$$;

alter table public.tasks
  add column kind text not null default 'task'
    check (kind in ('task', 'purchase')),
  add column category text
    check (category is null or (
      length(category) between 1 and 100
      and category !~ '^[[:space:]]|[[:space:]]$'
    )),
  add column destinations jsonb not null default '[]'::jsonb
    check (public.valid_task_destinations(destinations)),
  add column next_trip boolean not null default false;

create or replace function public.confirm_action(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_proposal jsonb;
  v_data jsonb;
  v_op text;
  v_allowed text[];
  v_field record;
  v_target_id uuid;
  v_target_ids uuid[];
  v_rows bigint;
  v_expected_rows bigint := 1;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- Serialize owner confirmations even when their profile does not exist yet.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('planner.confirm_action:' || v_user_id::text, 0)
  );

  select proposal into v_proposal
  from public.messages
  where id = p_message_id and user_id = v_user_id
    and role = 'assistant' and action_state = 'pending'
  for update;
  if not found then
    return false;
  end if;

  if jsonb_typeof(v_proposal -> 'op') is distinct from 'string'
     or jsonb_typeof(v_proposal -> 'data') is distinct from 'object'
     or v_proposal - array['op', 'data', 'currency'] <> '{}'::jsonb
     or (v_proposal ? 'currency' and jsonb_typeof(v_proposal -> 'currency') <> 'string') then
    raise exception 'Invalid proposal';
  end if;
  v_op := v_proposal ->> 'op';
  v_data := v_proposal -> 'data';
  case v_op
    when 'add_asset' then v_allowed := array['description', 'value_minor', 'notes'];
    when 'update_asset' then v_allowed := array['id', 'description', 'value_minor', 'notes'];
    when 'delete_asset' then v_allowed := array['id'];
    when 'add_task' then
      v_allowed := array['description', 'location', 'base_priority', 'estimated_cost_minor',
        'duration_minutes', 'deadline', 'status', 'kind', 'category', 'destinations', 'next_trip'];
    when 'update_task' then
      v_allowed := array['id', 'description', 'location', 'base_priority', 'estimated_cost_minor',
        'duration_minutes', 'deadline', 'status', 'kind', 'category', 'destinations', 'next_trip'];
    when 'delete_task' then v_allowed := array['id'];
    when 'complete_tasks' then v_allowed := array['ids'];
    when 'set_profile' then
      v_allowed := array['timezone', 'currency', 'starting_location', 'preferences', 'budget_minor'];
    when 'add_reminder' then
      v_allowed := array['description', 'cron', 'timezone', 'next_run'];
    when 'delete_reminder' then v_allowed := array['id'];
    else raise exception 'Unsupported proposal operation';
  end case;

  if v_op = any(array['add_asset', 'update_asset', 'add_task', 'update_task', 'set_profile']) then
    if jsonb_typeof(v_proposal -> 'currency') is distinct from 'string' then
      raise exception 'Proposal currency required';
    end if;
    if v_proposal ->> 'currency' <> coalesce(
      (select currency from public.profiles where id = v_user_id), 'USD'
    ) then
      raise exception 'Proposal currency no longer matches profile currency';
    end if;
  end if;

  for v_field in select key, value from jsonb_each(v_data) loop
    if not (v_field.key = any(v_allowed)) then
      raise exception 'Unexpected proposal field: %', v_field.key;
    end if;
    if v_field.value = 'null'::jsonb and v_field.key = any(array[
      'location', 'starting_location', 'estimated_cost_minor', 'duration_minutes',
      'deadline', 'budget_minor', 'category'
    ]) then
      continue;
    end if;
    if v_field.key = 'destinations' then
      if not public.valid_task_destinations(v_field.value) then
        raise exception 'Invalid task destinations';
      end if;
    elsif v_field.key = 'next_trip' then
      if jsonb_typeof(v_field.value) <> 'boolean' then
        raise exception 'Expected boolean for next_trip';
      end if;
    elsif v_field.key = 'kind' then
      if jsonb_typeof(v_field.value) <> 'string'
        or v_field.value #>> '{}' not in ('task', 'purchase') then
        raise exception 'Invalid task kind';
      end if;
    elsif v_field.key = 'category' then
      if jsonb_typeof(v_field.value) <> 'string'
        or length(v_field.value #>> '{}') not between 1 and 100
        or (v_field.value #>> '{}') ~ '^[[:space:]]|[[:space:]]$' then
        raise exception 'Invalid task category';
      end if;
    elsif v_field.key = 'ids' then
      if jsonb_typeof(v_field.value) <> 'array' then
        raise exception 'Expected ID array';
      end if;
      if jsonb_array_length(v_field.value) not between 1 and 20 then
        raise exception 'Expected between 1 and 20 IDs';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_field.value) as item(value)
        where jsonb_typeof(value) <> 'string'
      ) then
        raise exception 'Expected UUID strings';
      end if;
      select array_agg((value #>> '{}')::uuid) into v_target_ids
      from jsonb_array_elements(v_field.value) as item(value);
      if (select count(distinct id) from unnest(v_target_ids) as item(id))
        <> cardinality(v_target_ids) then
        raise exception 'Duplicate task IDs';
      end if;
    elsif v_field.key = any(array['location', 'starting_location']) then
      if jsonb_typeof(v_field.value) <> 'object' then
        raise exception 'Invalid location object';
      end if;
    elsif v_field.key = any(array[
      'value_minor', 'base_priority', 'estimated_cost_minor', 'duration_minutes', 'budget_minor'
    ]) then
      if jsonb_typeof(v_field.value) <> 'number'
         or (v_field.value #>> '{}') !~ '^-?[0-9]+$' then
        raise exception 'Expected integer for %', v_field.key;
      end if;
    elsif jsonb_typeof(v_field.value) <> 'string' then
      raise exception 'Expected string for %', v_field.key;
    end if;
  end loop;

  if v_op = any(array['add_asset', 'add_task', 'add_reminder'])
     and not (v_data ? 'description') then
    raise exception 'Description required';
  end if;
  if v_op = 'add_asset' and not (v_data ? 'value_minor') then
    raise exception 'Asset value required';
  end if;
  if v_op = any(array['update_asset', 'update_task', 'set_profile'])
     and (v_data - array['id']) = '{}'::jsonb then
    raise exception 'Update must include a changed field';
  end if;
  if v_op = 'add_reminder' and not (v_data ?& array['cron', 'timezone', 'next_run']) then
    raise exception 'Reminder schedule required';
  end if;
  if v_op = 'complete_tasks' and not (v_data ? 'ids') then
    raise exception 'Task IDs required';
  end if;
  if v_op = any(array['update_asset', 'delete_asset', 'update_task', 'delete_task', 'delete_reminder']) then
    if not (v_data ? 'id') then
      raise exception 'Target ID required';
    end if;
    v_target_id := (v_data ->> 'id')::uuid;
  end if;
  if v_data ? 'timezone' and not exists (
    select 1 from pg_catalog.pg_timezone_names where name = v_data ->> 'timezone'
  ) then
    raise exception 'Unknown timezone';
  end if;

  case v_op
    when 'add_asset' then
      insert into public.assets(user_id, description, value_minor, notes)
      values (v_user_id, v_data ->> 'description', (v_data ->> 'value_minor')::bigint,
        coalesce(v_data ->> 'notes', ''));
    when 'update_asset' then
      update public.assets set
        description = case when v_data ? 'description' then v_data ->> 'description' else description end,
        value_minor = case when v_data ? 'value_minor' then (v_data ->> 'value_minor')::bigint else value_minor end,
        notes = case when v_data ? 'notes' then v_data ->> 'notes' else notes end
      where id = v_target_id and user_id = v_user_id;
    when 'delete_asset' then
      delete from public.assets where id = v_target_id and user_id = v_user_id;
    when 'add_task' then
      insert into public.tasks(user_id, description, location, base_priority,
        estimated_cost_minor, duration_minutes, deadline, status,
        kind, category, destinations, next_trip)
      values (v_user_id, v_data ->> 'description', nullif(v_data -> 'location', 'null'::jsonb),
        coalesce((v_data ->> 'base_priority')::integer, 3),
        (v_data ->> 'estimated_cost_minor')::bigint, (v_data ->> 'duration_minutes')::integer,
        (v_data ->> 'deadline')::date, coalesce(v_data ->> 'status', 'open'),
        coalesce(v_data ->> 'kind', 'task'), v_data ->> 'category',
        coalesce(v_data -> 'destinations', '[]'::jsonb),
        coalesce((v_data ->> 'next_trip')::boolean, false));
    when 'update_task' then
      update public.tasks set
        description = case when v_data ? 'description' then v_data ->> 'description' else description end,
        location = case when v_data ? 'location' then nullif(v_data -> 'location', 'null'::jsonb) else location end,
        base_priority = case when v_data ? 'base_priority' then (v_data ->> 'base_priority')::integer else base_priority end,
        estimated_cost_minor = case when v_data ? 'estimated_cost_minor' then (v_data ->> 'estimated_cost_minor')::bigint else estimated_cost_minor end,
        duration_minutes = case when v_data ? 'duration_minutes' then (v_data ->> 'duration_minutes')::integer else duration_minutes end,
        deadline = case when v_data ? 'deadline' then (v_data ->> 'deadline')::date else deadline end,
        status = case when v_data ? 'status' then v_data ->> 'status' else status end,
        kind = case when v_data ? 'kind' then v_data ->> 'kind' else kind end,
        category = case when v_data ? 'category' then v_data ->> 'category' else category end,
        destinations = case when v_data ? 'destinations' then v_data -> 'destinations' else destinations end,
        next_trip = case when v_data ? 'next_trip' then (v_data ->> 'next_trip')::boolean else next_trip end
      where id = v_target_id and user_id = v_user_id;
    when 'delete_task' then
      delete from public.tasks where id = v_target_id and user_id = v_user_id;
    when 'complete_tasks' then
      v_expected_rows := cardinality(v_target_ids);
      -- Lock every eligible row in UUID order before checking or changing the batch.
      perform id from public.tasks
      where id = any(v_target_ids) and user_id = v_user_id
        and status = 'open'
      order by id
      for update;
      get diagnostics v_rows = row_count;
      if v_rows <> v_expected_rows then
        raise exception 'Every task must be owned and open' using errcode = 'P0002';
      end if;
      update public.tasks set status = 'done'
      where id = any(v_target_ids) and user_id = v_user_id
        and status = 'open';
    when 'set_profile' then
      if v_data ? 'currency' and exists (
        select 1 from public.profiles
        where id = v_user_id and currency <> (v_data ->> 'currency')
      ) and (
        exists (select 1 from public.assets where user_id = v_user_id)
        or exists (select 1 from public.tasks where user_id = v_user_id)
      ) then
        raise exception 'Currency cannot be changed while assets or tasks exist';
      end if;
      insert into public.profiles(id, timezone, currency, starting_location, preferences, budget_minor)
      values (v_user_id, coalesce(v_data ->> 'timezone', 'UTC'),
        coalesce(v_data ->> 'currency', 'USD'),
        nullif(v_data -> 'starting_location', 'null'::jsonb),
        coalesce(v_data ->> 'preferences', ''), (v_data ->> 'budget_minor')::bigint)
      on conflict (id) do update set
        timezone = case when v_data ? 'timezone' then excluded.timezone else public.profiles.timezone end,
        currency = case when v_data ? 'currency' then excluded.currency else public.profiles.currency end,
        starting_location = case when v_data ? 'starting_location' then excluded.starting_location else public.profiles.starting_location end,
        preferences = case when v_data ? 'preferences' then excluded.preferences else public.profiles.preferences end,
        budget_minor = case when v_data ? 'budget_minor' then excluded.budget_minor else public.profiles.budget_minor end;
    when 'add_reminder' then
      insert into public.reminders(user_id, description, cron, timezone, next_run)
      values (v_user_id, v_data ->> 'description', v_data ->> 'cron',
        v_data ->> 'timezone', (v_data ->> 'next_run')::timestamptz);
    when 'delete_reminder' then
      delete from public.reminders where id = v_target_id and user_id = v_user_id;
  end case;
  get diagnostics v_rows = row_count;
  if v_rows <> v_expected_rows then
    raise exception 'Target does not exist or is not owned by you' using errcode = 'P0002';
  end if;

  update public.messages set action_state = 'confirmed'
  where id = p_message_id and user_id = v_user_id;
  return true;
end;
$$;

commit;
