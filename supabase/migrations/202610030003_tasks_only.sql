-- Everything is a task. Assets, budget planning, coordinates, and monetary
-- fields are removed. Export assets before applying this migration if needed.
begin;

-- Proposals created for the previous schema can no longer be confirmed.
update public.messages set action_state = 'cancelled'
where action_state = 'pending';

drop function public.record_plan(jsonb);
drop table public.planning_sessions;
drop table public.assets;

alter table public.profiles
  drop column currency,
  drop column budget_minor,
  drop column starting_location;

alter table public.tasks rename column description to full_description;
alter table public.tasks rename column base_priority to priority;
alter table public.tasks rename column deadline to due_date;
alter table public.tasks drop constraint tasks_description_check;
alter table public.tasks alter column full_description drop not null;

alter table public.tasks
  add column name text,
  add column short_description text,
  add column location_name text,
  add column updated_at timestamptz not null default now(),
  add column completed_at timestamptz;

update public.tasks set
  name = btrim(left(btrim(regexp_replace(full_description, '\s+', ' ', 'g')), 80)),
  short_description = btrim(left(btrim(regexp_replace(full_description, '\s+', ' ', 'g')), 160)),
  location_name = nullif(btrim(left(btrim(coalesce(location ->> 'label', '')), 100)), ''),
  full_description = case
    when length(btrim(regexp_replace(full_description, '\s+', ' ', 'g'))) > 160
      then full_description
    else null
  end;

alter table public.tasks
  drop column location,
  drop column kind,
  drop column category,
  drop column destinations,
  drop column next_trip,
  drop column metadata,
  drop column estimated_cost_minor,
  drop column duration_minutes;
drop function public.valid_task_destinations(jsonb);

alter table public.tasks
  alter column name set not null,
  alter column short_description set not null,
  add constraint tasks_name_check
    check (length(name) between 1 and 80 and name = btrim(name)),
  add constraint tasks_short_description_check
    check (length(short_description) between 1 and 160
      and short_description = btrim(short_description)),
  add constraint tasks_full_description_check
    check (full_description is null or length(full_description) between 1 and 10000),
  add constraint tasks_location_name_check
    check (location_name is null or (length(location_name) between 1 and 100
      and location_name = btrim(location_name))),
  add constraint tasks_completed_at_check
    check (completed_at is null or status = 'done');

create index tasks_user_open_idx on public.tasks(user_id) where status = 'open';

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
  v_text text;
  v_target_id uuid;
  v_target_ids uuid[];
  v_rows bigint;
  v_expected_rows bigint := 1;
  v_max_open constant integer := 300;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- Serialize owner confirmations, including the open-task cap check.
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
     or v_proposal - array['op', 'data'] <> '{}'::jsonb then
    raise exception 'Invalid proposal';
  end if;
  v_op := v_proposal ->> 'op';
  v_data := v_proposal -> 'data';
  case v_op
    when 'add_task' then
      v_allowed := array['name', 'short_description', 'full_description',
        'location_name', 'priority', 'due_date'];
    when 'update_task' then
      v_allowed := array['id', 'name', 'short_description', 'full_description',
        'location_name', 'priority', 'due_date', 'status'];
    when 'delete_task' then v_allowed := array['id'];
    when 'complete_tasks' then v_allowed := array['ids'];
    when 'set_profile' then v_allowed := array['timezone', 'preferences'];
    when 'add_reminder' then
      v_allowed := array['description', 'cron', 'timezone', 'next_run'];
    when 'delete_reminder' then v_allowed := array['id'];
    else raise exception 'Unsupported proposal operation';
  end case;

  for v_field in select key, value from jsonb_each(v_data) loop
    if not (v_field.key = any(v_allowed)) then
      raise exception 'Unexpected proposal field: %', v_field.key;
    end if;
    if v_field.value = 'null'::jsonb
       and v_field.key = any(array['full_description', 'location_name', 'due_date']) then
      continue;
    end if;
    if v_field.key = 'ids' then
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
      continue;
    end if;
    if v_field.key = 'priority' then
      if jsonb_typeof(v_field.value) <> 'number'
         or (v_field.value #>> '{}') !~ '^[1-5]$' then
        raise exception 'Priority must be an integer from 1 to 5';
      end if;
      continue;
    end if;
    if jsonb_typeof(v_field.value) <> 'string' then
      raise exception 'Expected string for %', v_field.key;
    end if;
    v_text := v_field.value #>> '{}';
    if (v_field.key = 'name' and length(v_text) not between 1 and 80)
       or (v_field.key = 'short_description' and length(v_text) not between 1 and 160)
       or (v_field.key = 'full_description' and length(v_text) not between 1 and 10000)
       or (v_field.key = 'location_name' and length(v_text) not between 1 and 100)
       or (v_field.key = 'preferences' and length(v_text) > 10000)
       or (v_field.key = any(array['name', 'short_description', 'location_name'])
         and v_text <> btrim(v_text))
       or (v_field.key = 'due_date' and v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
       or (v_field.key = 'status' and v_text not in ('open', 'done', 'cancelled')) then
      raise exception 'Invalid value for %', v_field.key;
    end if;
  end loop;

  if v_op = 'add_task' and not (v_data ?& array['name', 'short_description']) then
    raise exception 'Name and short description required';
  end if;
  if v_op = 'add_reminder' and not (v_data ? 'description') then
    raise exception 'Description required';
  end if;
  if v_op = any(array['update_task', 'set_profile'])
     and (v_data - array['id']) = '{}'::jsonb then
    raise exception 'Update must include a changed field';
  end if;
  if v_op = 'update_task' and v_data ? 'full_description'
     and not (v_data ? 'short_description') then
    raise exception 'Changing the full description requires a new short description';
  end if;
  if v_op = 'add_reminder' and not (v_data ?& array['cron', 'timezone', 'next_run']) then
    raise exception 'Reminder schedule required';
  end if;
  if v_op = 'complete_tasks' and not (v_data ? 'ids') then
    raise exception 'Task IDs required';
  end if;
  if v_op = any(array['update_task', 'delete_task', 'delete_reminder']) then
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

  if (v_op = 'add_task' or (v_op = 'update_task' and v_data ->> 'status' = 'open'
      and exists (
        select 1 from public.tasks
        where id = v_target_id and user_id = v_user_id and status <> 'open'
      )))
     and (select count(*) from public.tasks
          where user_id = v_user_id and status = 'open') >= v_max_open then
    raise exception 'At most % open tasks are allowed', v_max_open;
  end if;

  case v_op
    when 'add_task' then
      insert into public.tasks(user_id, name, short_description, full_description,
        location_name, priority, due_date)
      values (v_user_id, v_data ->> 'name', v_data ->> 'short_description',
        v_data ->> 'full_description', v_data ->> 'location_name',
        coalesce((v_data ->> 'priority')::integer, 3), (v_data ->> 'due_date')::date);
    when 'update_task' then
      update public.tasks set
        name = case when v_data ? 'name' then v_data ->> 'name' else name end,
        short_description = case when v_data ? 'short_description'
          then v_data ->> 'short_description' else short_description end,
        full_description = case when v_data ? 'full_description'
          then v_data ->> 'full_description' else full_description end,
        location_name = case when v_data ? 'location_name'
          then v_data ->> 'location_name' else location_name end,
        priority = case when v_data ? 'priority'
          then (v_data ->> 'priority')::integer else priority end,
        due_date = case when v_data ? 'due_date'
          then (v_data ->> 'due_date')::date else due_date end,
        status = case when v_data ? 'status' then v_data ->> 'status' else status end,
        completed_at = case
          when not (v_data ? 'status') then completed_at
          when v_data ->> 'status' <> 'done' then null
          when status = 'done' then completed_at
          else now()
        end,
        updated_at = now()
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
      update public.tasks set status = 'done', completed_at = now(), updated_at = now()
      where id = any(v_target_ids) and user_id = v_user_id
        and status = 'open';
    when 'set_profile' then
      insert into public.profiles(id, timezone, preferences)
      values (v_user_id, coalesce(v_data ->> 'timezone', 'UTC'),
        coalesce(v_data ->> 'preferences', ''))
      on conflict (id) do update set
        timezone = case when v_data ? 'timezone' then excluded.timezone else public.profiles.timezone end,
        preferences = case when v_data ? 'preferences' then excluded.preferences else public.profiles.preferences end;
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
