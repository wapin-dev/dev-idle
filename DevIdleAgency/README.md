# DevIdle Agency

Jeu idle **mobile-first** (Agence AFK) : TypeScript + Vite, auth Supabase, sauvegarde des progrès. Prêt pour PWA et packaging Capacitor (Android / iOS).

## Lancer le projet

```bash
cd DevIdleAgency
cp .env.example .env
# Édite .env avec tes clés Supabase (optionnel pour jouer en local)
npm install
npm run dev
```

Ouvre **http://localhost:5173** dans ton navigateur.

---

## Faire essayer en local (à d’autres personnes)

1. **Sur ta machine** (à la racine du projet) :
   ```bash
   cd DevIdleAgency
   npm install
   npm run dev
   ```

2. **Sur la même machine**  
   Ouvre **http://localhost:5173**.

3. **Sur le même réseau Wi‑Fi (téléphone, autre PC)**  
   Le serveur écoute sur ton IP locale. Dans le terminal, Vite affiche par exemple :
   ```text
   ➜  Local:   http://localhost:5173/
   ➜  Network: http://192.168.1.42:5173/
   ```
   Donne le lien **Network** aux autres (en remplaçant par l’IP affichée chez toi). Ils ouvrent ce lien dans leur navigateur pour tester le jeu.

4. **Sans Node sur la machine des testeurs**  
   Seule ta machine doit avoir `npm run dev` lancé ; les autres accèdent au jeu via le lien Network dans leur navigateur.

**Résumé** : `npm run dev` une fois chez toi → partage le lien **Network** (ex. `http://192.168.1.42:5173`) pour que les gens testent en local sur le même réseau.

## Build

```bash
npm run build
```

Sortie dans `dist/`.

## Supabase

### 1. Créer le projet

Sur [supabase.com](https://supabase.com), crée un projet et récupère l’URL et la clé anonyme (anon key).

### 2. Table des progrès

Dans l’éditeur SQL Supabase, exécute :

```sql
create table if not exists public.users_progress (
  id uuid primary key references auth.users(id) on delete cascade,
  progress jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.users_progress enable row level security;

create policy "Users can read own progress"
  on public.users_progress for select
  using (auth.uid() = id);

create policy "Users can insert own progress"
  on public.users_progress for insert
  with check (auth.uid() = id);

create policy "Users can update own progress"
  on public.users_progress for update
  using (auth.uid() = id);
```

### 3. Auth

Dans le dashboard Supabase : **Authentication > Providers**, active **Email**. Les utilisateurs pourront s’inscrire et se connecter avec email + mot de passe.

## Publication (stores)

1. Build : `npm run build`
2. Capacitor :

```bash
npm install @capacitor/core @capacitor/cli
npx cap init
npx cap add android
npx cap add ios
```

3. Dans `capacitor.config.json`, `webDir` pointe déjà sur `dist`.
4. Après chaque build : `npx cap sync`
5. Ouvrir le projet natif : `npx cap open android` ou `npx cap open ios`

## Structure

- `src/main.ts` – entrée, auth, boucle de jeu, rendu UI
- `src/auth.ts` – signup / login / logout Supabase
- `src/storage.ts` – load / save progrès (table `users_progress`)
- `src/game.ts` – logique (credits, prod/s, upgrades)
- `src/types.ts` – types (Employe, Contrat, Progress, etc.)

Le jeu complet (contrats, employés, erreurs, prestige) du dossier parent peut être fusionné dans `game.ts` et les écrans étendus dans `index.html` + `main.ts`.
