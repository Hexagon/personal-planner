begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'UTC' check (length(btrim(timezone)) between 1 and 100),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  starting_location jsonb check (starting_location is null or jsonb_typeof(starting_location) = 'object'),
  preferences text not null default '' check (length(preferences) <= 10000),
  budget_minor bigint check (budget_minor between 0 and 1000000000000),
  created_at timestamptz not null default now()
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null check (length(btrim(description)) between 1 and 2000),
  value_minor bigint not null check (value_minor between 0 and 1000000000000),
  notes text not null default '' check (length(notes) <= 10000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null check (length(btrim(description)) between 1 and 2000),
  location jsonb check (location is null or jsonb_typeof(location) = 'object'),
  base_priority integer not null default 3 check (base_priority between 1 and 5),
  estimated_cost_minor bigint check (estimated_cost_minor between 0 and 1000000000000),
  duration_minutes integer check (duration_minutes between 1 and 1440),
  deadline date,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) between 1 and 20000),
  proposal jsonb check (
    proposal is null or (jsonb_typeof(proposal) = 'object' and octet_length(proposal::text) <= 65536)
  ),
  action_state text check (action_state in ('pending', 'confirmed', 'cancelled')),
  created_at timestamptz not null default now(),
  check (action_state is null or (role = 'assistant' and proposal is not null))
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null check (length(btrim(description)) between 1 and 2000),
  cron text not null check (length(btrim(cron)) between 1 and 200),
  timezone text not null default 'UTC' check (length(btrim(timezone)) between 1 and 100),
  next_run timestamptz not null check (isfinite(next_run)),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.planning_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now()
);

create index assets_user_id_idx on public.assets(user_id);
create index tasks_user_id_idx on public.tasks(user_id);
create index messages_user_created_idx on public.messages(user_id, created_at);
create index reminders_user_id_idx on public.reminders(user_id);
create index reminders_due_idx on public.reminders(next_run) where active;
create index planning_sessions_user_created_idx on public.planning_sessions(user_id, created_at);

alter table public.profiles enable row level security;
alter table public.assets enable row level security;
alter table public.tasks enable row level security;
alter table public.messages enable row level security;
alter table public.reminders enable row level security;
alter table public.planning_sessions enable row level security;

create policy profiles_owner on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy assets_owner on public.assets for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy tasks_owner on public.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy messages_owner on public.messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy reminders_owner on public.reminders for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy planning_sessions_owner on public.planning_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.profiles, public.assets, public.tasks, public.messages,
  public.reminders, public.planning_sessions from public, anon, authenticated;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.profiles, public.assets, public.tasks,
  public.messages, public.reminders, public.planning_sessions to authenticated, service_role;

create function public.confirm_action(p_message_id uuid)
returns boolean
language plpgsql
security invoker
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
  v_rows bigint;
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
        'duration_minutes', 'deadline', 'status'];
    when 'update_task' then
      v_allowed := array['id', 'description', 'location', 'base_priority', 'estimated_cost_minor',
        'duration_minutes', 'deadline', 'status'];
    when 'delete_task' then v_allowed := array['id'];
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
      'deadline', 'budget_minor'
    ]) then
      continue;
    end if;
    if v_field.key = any(array['location', 'starting_location']) then
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

  if v_op = any(array['add_asset', 'update_asset', 'add_task', 'update_task', 'add_reminder'])
     and not (v_data ? 'description') then
    raise exception 'Description required';
  end if;
  if v_op = any(array['add_asset', 'update_asset']) and not (v_data ? 'value_minor') then
    raise exception 'Asset value required';
  end if;
  if v_op = 'add_reminder' and not (v_data ?& array['cron', 'timezone', 'next_run']) then
    raise exception 'Reminder schedule required';
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
        description = v_data ->> 'description',
        value_minor = (v_data ->> 'value_minor')::bigint,
        notes = coalesce(v_data ->> 'notes', '')
      where id = v_target_id and user_id = v_user_id;
    when 'delete_asset' then
      delete from public.assets where id = v_target_id and user_id = v_user_id;
    when 'add_task' then
      insert into public.tasks(user_id, description, location, base_priority,
        estimated_cost_minor, duration_minutes, deadline, status)
      values (v_user_id, v_data ->> 'description', nullif(v_data -> 'location', 'null'::jsonb),
        coalesce((v_data ->> 'base_priority')::integer, 3),
        (v_data ->> 'estimated_cost_minor')::bigint, (v_data ->> 'duration_minutes')::integer,
        (v_data ->> 'deadline')::date, coalesce(v_data ->> 'status', 'open'));
    when 'update_task' then
      update public.tasks set
        description = v_data ->> 'description',
        location = nullif(v_data -> 'location', 'null'::jsonb),
        base_priority = coalesce((v_data ->> 'base_priority')::integer, 3),
        estimated_cost_minor = (v_data ->> 'estimated_cost_minor')::bigint,
        duration_minutes = (v_data ->> 'duration_minutes')::integer,
        deadline = (v_data ->> 'deadline')::date,
        status = coalesce(v_data ->> 'status', 'open')
      where id = v_target_id and user_id = v_user_id;
    when 'delete_task' then
      delete from public.tasks where id = v_target_id and user_id = v_user_id;
    when 'set_profile' then
      if exists (
        select 1 from public.profiles
        where id = v_user_id and currency <> coalesce(v_data ->> 'currency', 'USD')
      ) and (
        exists (select 1 from public.assets where user_id = v_user_id)
        or exists (select 1 from public.tasks where user_id = v_user_id)
      ) then
        raise exception 'Currency cannot be changed while assets or tasks exist';
      end if;
      insert into public.profiles(id, timezone, currency, starting_location, preferences, budget_minor)
      values (v_user_id, coalesce(v_data ->> 'timezone', 'UTC'),
        coalesce(v_data ->> 'currency', 'USD'), nullif(v_data -> 'starting_location', 'null'::jsonb),
        coalesce(v_data ->> 'preferences', ''), (v_data ->> 'budget_minor')::bigint)
      on conflict (id) do update set
        timezone = excluded.timezone, currency = excluded.currency,
        starting_location = excluded.starting_location, preferences = excluded.preferences,
        budget_minor = excluded.budget_minor;
    when 'add_reminder' then
      insert into public.reminders(user_id, description, cron, timezone, next_run)
      values (v_user_id, v_data ->> 'description', v_data ->> 'cron',
        v_data ->> 'timezone', (v_data ->> 'next_run')::timestamptz);
    when 'delete_reminder' then
      delete from public.reminders where id = v_target_id and user_id = v_user_id;
  end case;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Target does not exist or is not owned by you' using errcode = 'P0002';
  end if;

  update public.messages set action_state = 'confirmed'
  where id = p_message_id and user_id = v_user_id;
  return true;
end;
$$;

revoke all on function public.confirm_action(uuid) from public, anon, authenticated;
grant execute on function public.confirm_action(uuid) to authenticated;

create function public.deliver_reminder(
  p_id uuid, p_expected_run timestamptz, p_next_run timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reminder public.reminders%rowtype;
begin
  if p_expected_run is null or not isfinite(p_expected_run)
     or p_next_run is null or not isfinite(p_next_run)
     or p_next_run <= p_expected_run or p_next_run <= statement_timestamp() then
    raise exception 'Next occurrence must be finite, future, and after the expected occurrence';
  end if;

  select * into v_reminder from public.reminders
  where id = p_id and active and next_run = p_expected_run
    and next_run <= statement_timestamp()
  for update;
  if not found then
    return false;
  end if;

  insert into public.messages(user_id, role, content)
  values (v_reminder.user_id, 'assistant', 'Reminder: ' || v_reminder.description);
  update public.reminders set next_run = p_next_run where id = v_reminder.id;
  return true;
end;
$$;

revoke all on function public.deliver_reminder(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.deliver_reminder(uuid, timestamptz, timestamptz) to service_role;

commit;
