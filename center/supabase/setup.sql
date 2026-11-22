-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- Before running, put the real emails of the team on the last line.

create table if not exists public.members (email text primary key);
create table if not exists public.items (
  col text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);

alter table public.members enable row level security;
alter table public.items enable row level security;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where lower(email) = lower(auth.jwt() ->> 'email'))
$$;

drop policy if exists "team reads and writes items" on public.items;
create policy "team reads and writes items" on public.items
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "team sees members" on public.members;
create policy "team sees members" on public.members
  for select to authenticated using (public.is_member());

alter publication supabase_realtime add table public.items;

insert into storage.buckets (id, name, public) values ('recordings', 'recordings', false)
  on conflict (id) do nothing;

drop policy if exists "team recordings" on storage.objects;
create policy "team recordings" on storage.objects
  for all to authenticated
  using (bucket_id = 'recordings' and public.is_member())
  with check (bucket_id = 'recordings' and public.is_member());

-- The team: only these emails can sign in and see the data.
insert into public.members (email) values ('EMAIL-OF-DINA'), ('EMAIL-OF-ASHIA') on conflict do nothing;
