import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

let supabase: SupabaseClient;

try {
  supabase = createClient(url || '', anonKey || '');
} catch (e) {
  console.error('Supabase init failed:', e);
  supabase = createClient('https://placeholder.supabase.co', 'placeholder-key');
}

export { supabase };
