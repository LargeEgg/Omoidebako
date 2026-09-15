-- Run this once in your Supabase project's SQL editor (Supabase dashboard -> SQL Editor -> New query).
-- It creates the table that holds your library and locks it down so only you can read/write your own rows.

create table if not exists entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  media_type text not null check (media_type in ('anime','manga')),
  mal_id integer,
  title text not null,
  image_url text,
  status text not null default 'plan' check (status in ('watching','completed','plan','dropped','on_hold')),
  score numeric check (score >= 0 and score <= 10),
  progress integer not null default 0,
  total_units integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Row Level Security: every visitor can only ever see/change their own rows.
alter table entries enable row level security;

create policy "select own entries"
  on entries for select
  using (auth.uid() = user_id);

create policy "insert own entries"
  on entries for insert
  with check (auth.uid() = user_id);

create policy "update own entries"
  on entries for update
  using (auth.uid() = user_id);

create policy "delete own entries"
  on entries for delete
  using (auth.uid() = user_id);

-- Keep updated_at fresh automatically.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger entries_set_updated_at
before update on entries
for each row execute function set_updated_at();
