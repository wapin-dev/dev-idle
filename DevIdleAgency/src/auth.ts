import { supabase } from './supabase';
import type { User } from '@supabase/supabase-js';

export async function signup(
  email: string,
  password: string
): Promise<{ user: User | null; error: string | null }> {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    console.error('Signup failed:', error.message);
    return { user: null, error: error.message };
  }
  return { user: data.user, error: null };
}

export async function login(
  email: string,
  password: string
): Promise<{ user: User | null; error: string | null }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('Login failed:', error.message);
    return { user: null, error: error.message };
  }
  return { user: data.user, error: null };
}

export async function logout(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) console.error('Logout failed:', error.message);
}

export function onAuthStateChange(
  callback: (user: User | null) => void
): () => void {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (_event, session) => callback(session?.user ?? null)
  );
  return () => subscription.unsubscribe();
}
