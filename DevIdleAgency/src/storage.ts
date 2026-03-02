import { supabase } from './supabase';
import type { UserProgress } from './types';

const TABLE = 'users_progress';

/**
 * Charge les progrès du joueur depuis Supabase.
 * Table attendue : id (uuid, primary key = user id), progress (jsonb), updated_at (timestamptz)
 */
export async function loadProgress(userId: string): Promise<Partial<UserProgress> | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('progress')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('Load progress failed:', error.message);
    return null;
  }
  return (data?.progress as Partial<UserProgress>) ?? null;
}

/**
 * Sauvegarde les progrès du joueur dans Supabase (upsert).
 */
export async function saveProgress(
  userId: string,
  progress: UserProgress
): Promise<boolean> {
  const { error } = await supabase
    .from(TABLE)
    .upsert(
      { id: userId, progress: { ...progress, lastSave: Date.now() }, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );

  if (error) {
    console.error('Save progress failed:', error.message);
    return false;
  }
  return true;
}
