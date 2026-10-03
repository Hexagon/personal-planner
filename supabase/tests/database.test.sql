begin;

select plan(7);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'assets', 'assets table exists');
select has_table('public', 'tasks', 'tasks table exists');
select has_table('public', 'messages', 'messages table exists');
select has_table('public', 'reminders', 'reminders table exists');
select has_table('public', 'planning_sessions', 'planning_sessions table exists');
select ok(
  (select count(*) = 6
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relkind = 'r'
     and relrowsecurity),
  'row-level security is enabled on all user-owned tables'
);

select * from finish();

rollback;
