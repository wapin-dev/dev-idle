-- À exécuter dans Supabase : SQL Editor > New query > coller puis Run

create table if not exists public.users_progress (
  id uuid primary key references auth.users(id) on delete cascade,
  progress jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.users_progress enable row level security;

drop policy if exists "Users can read own progress" on public.users_progress;
create policy "Users can read own progress"
  on public.users_progress for select
  using (auth.uid() = id);

drop policy if exists "Users can insert own progress" on public.users_progress;
create policy "Users can insert own progress"
  on public.users_progress for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update own progress" on public.users_progress;
create policy "Users can update own progress"
  on public.users_progress for update
  using (auth.uid() = id);
