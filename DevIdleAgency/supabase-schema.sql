-- DevIdle Agency – Schéma Supabase pour sauvegarder toute la progression du joueur
-- À exécuter dans Supabase : SQL Editor > New query > coller puis Run

-- =============================================================================
-- Table principale : une ligne par joueur, tout l’état en JSONB (comme le save localStorage)
-- =============================================================================

create table if not exists public.users_progress (
  id uuid primary key references auth.users(id) on delete cascade,
  progress jsonb not null default '{}',
  save_version smallint not null default 1,
  updated_at timestamptz not null default now()
);

-- Si la table existait déjà sans save_version, l’ajouter :
alter table public.users_progress add column if not exists save_version smallint not null default 1;

comment on column public.users_progress.progress is 'État complet du jeu (voir PAYLOAD_STRUCTURE en bas de fichier)';
comment on column public.users_progress.save_version is 'Version du format de save pour migrations futures';

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

-- Index optionnel pour trier par mise à jour (ex: classement “dernière activité”)
create index if not exists idx_users_progress_updated_at
  on public.users_progress (updated_at desc);

-- =============================================================================
-- Structure du champ progress (JSONB) – même forme que le save localStorage
-- =============================================================================
/*
{
  "credits": number,
  "clickPower": number,
  "playerLevel": number,
  "playerXP": number,
  "levelBonuses": { "prodPercent"?: number, "clickPercent"?: number, "xpPercent"?: number, "eventBonusChance"?: number },
  "upgrades": [ { "id": string, "quantity": number } ],
  "offices": [ { "id": string, "quantity": number } ],
  "branding": [ { "id": string, "quantity": number } ],
  "managers": [ { "id": string, "quantity": number } ],
  "intlOffices": [ { "id": string, "quantity": number } ],
  "training": [ { "id": string, "quantity": number } ],
  "contrats": [ { "id": string, "endsAt": number, "done": boolean } ],
  "rnd": [ { "id": string, "purchased": boolean } ],
  "chapterBonuses": { "ch1"?: { "prodPercent": number }, ... },
  "completedQuests": [ string ],
  "chapter": number,
  "completedChapters": [ number ],
  "reputation": number,
  "prestigeBonuses": { "prodPercent"?: number, "clickPercent"?: number, "xpPercent"?: number },
  "purchasedPrestigeBonuses": [ string ],
  "agencyName": string,
  "bestRunCredits": number,
  "agencyEventChoice": { "name"?: string, "prod"?: number, "duration"?: number, ... } | null,
  "agencyEventEndsAt": number,
  "nextEventAt": number,
  "activeEvent": string | null,
  "eventEndsAt": number,
  "recruitmentContracts": [
    { "type": "stagiaire"|"junior"|"senior", "name": string, "prodPerSec": number, "errorChance": number, "trait": string, "cost": number }
  ],
  "employees": [
    { "id": string, "type": string, "name": string, "prodPerSec": number, "errorChance": number, "trait": string,
      "level": number, "xp": number, "isActive": boolean, "hasError": boolean, "errorUntil": number,
      "mentorId": string | null, "menteesIds": string[], "mentorSlots": number }
  ],
  "nextErrorRollAt": number,
  "lastContractRefreshAt": number (optionnel),
  "themeColor": string (optionnel)
}
*/

-- =============================================================================
-- VÉRIFICATION : exécuter la requête ci-dessous pour confirmer que tout est OK
-- =============================================================================
-- Résultat attendu : une ligne avec le nom de la table et 4 colonnes (id, progress, save_version, updated_at)

select
  t.tablename as table_name,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.tablename) as column_count
from pg_tables t
where t.schemaname = 'public' and t.tablename = 'users_progress';
