/**
 * Accounts, through Supabase Auth.
 *
 * The browser signs in with Supabase directly and gets an access token; the
 * sync API only ever sees that token (see backend/app/auth.py). Supabase keeps
 * the session in localStorage and refreshes it on its own, so a signed-in app
 * opens with no signal at all - being offline never signs anyone out.
 *
 * The URL and key come from the build (VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY). Both are public by design: the key only lets a
 * browser ask Supabase to sign someone in.
 */

import { createClient, type Session } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False in a build made without the two variables: the app says so instead of failing oddly. */
export const authConfigured = Boolean(url && anonKey);

export const supabase = authConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

/** The token to send with a sync request, refreshed first if it has run out. */
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function currentSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onSessionChange(listener: (session: Session | null) => void): () => void {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => listener(session));
  return () => data.subscription.unsubscribe();
}
