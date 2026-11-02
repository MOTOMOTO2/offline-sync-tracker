import { useState } from 'react';

import { supabase } from '../lib/auth';

/**
 * Email and password, against Supabase.
 *
 * The one screen in the app that needs a connection: there is no account to
 * open offline until this device has signed in once. After that, the session
 * is kept on the device and the ledger opens with no signal.
 */

type Mode = 'sign-in' | 'sign-up';

/**
 * Off unless the build says otherwise: the hosted app shares a Supabase project,
 * and its accounts, with another app, so sign-ups are closed there and the way
 * in is an account that already exists.
 */
const allowSignUp = import.meta.env.VITE_ALLOW_SIGNUP === 'true';

export function SignIn() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    if (!navigator.onLine) {
      setError('Signing in needs a connection the first time. After that, Tally works offline.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'sign-in') {
        const { error: failed } = await supabase.auth.signInWithPassword({ email, password });
        if (failed) setError(failed.message);
        // On success the session listener in App takes it from here.
      } else {
        const { data, error: failed } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (failed) setError(failed.message);
        else if (!data.session) {
          setNotice(`Check ${email} for a link to confirm your account, then sign in here.`);
          setMode('sign-in');
          setPassword('');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  return (
    <div className="sign-in">
      <img src="/icons/logo.svg" alt="" width="48" height="48" />
      <h1>Tally</h1>
      <p className="sign-in-lede">
        {mode === 'sign-in' ? 'Sign in to your ledger.' : 'Make an account for your ledger.'}
      </p>

      <form className="composer entry-form" onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            minLength={mode === 'sign-up' ? 8 : undefined}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error && <p className="form-error">{error}</p>}
        {notice && <p className="form-notice">{notice}</p>}

        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'One moment…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </div>
      </form>

      {allowSignUp && <p className="sign-in-switch">
        {mode === 'sign-in' ? (
          <>
            New here?{' '}
            <button type="button" className="link" onClick={() => switchTo('sign-up')}>
              Create an account
            </button>
          </>
        ) : (
          <>
            Already have one?{' '}
            <button type="button" className="link" onClick={() => switchTo('sign-in')}>
              Sign in
            </button>
          </>
        )}
      </p>}
    </div>
  );
}
