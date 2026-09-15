-- Omoidebako Supabase schema

-- Run this once in your Supabase project's SQL editor
-- Safe to re-run 


-- Table
create table if not exists entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  media_type   text not null check (media_type in ('anime', 'manga')),
  mal_id       integer,
  title        text not null,
  image_url    text,
  banner_url   text,
  status       text not null default 'plan' check (status in ('watching', 'completed', 'plan', 'dropped', 'on_hold')),
  score        numeric check (score >= 0 and score <= 10),
  progress     integer not null default 0,
  total_units  integer,
  notes        text,
  folder       text,
  source_name  text,
  external_id  text,
  tags         text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table entries add column if not exists banner_url  text;
alter table entries add column if not exists folder      text;
alter table entries add column if not exists source_name text;
alter table entries add column if not exists external_id text;
alter table entries add column if not exists tags        text[] not null default '{}';

-- Row Level Security: every visitor can only ever see/change their own rows.
alter table entries enable row level security;

drop policy if exists "select own entries" on entries;
create policy "select own entries"
  on entries for select
  using (auth.uid() = user_id);

drop policy if exists "insert own entries" on entries;
create policy "insert own entries"
  on entries for insert
  with check (auth.uid() = user_id);

drop policy if exists "update own entries" on entries;
create policy "update own entries"
  on entries for update
  using (auth.uid() = user_id);

drop policy if exists "delete own entries" on entries;
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

drop trigger if exists entries_set_updated_at on entries;
create trigger entries_set_updated_at
before update on entries
for each row execute function set_updated_at();

-- Indexes
create index if not exists entries_tags_idx   on entries using gin (tags);
create index if not exists entries_folder_idx on entries (user_id, media_type, folder);