import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { solvePuzzle } from '../puzzle.ts';

function SignUp({ mode, onBack, needsEmail, legal }: { mode: 'invite' | 'approval' | 'open'; onBack: () => void; needsEmail: boolean; legal: boolean }) {
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [step, setStep] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [verify, setVerify] = useState(false);
  const [accept, setAccept] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      if (password !== again) throw new Error('The two passwords are not the same');
      setStep('Checking that you are a person…');
      const puzzle = await api.challenge();
      const nonce = await solvePuzzle(puzzle.token, puzzle.difficulty);
      setStep('Creating your account…');
      return api.signup({ username, password, code: code.trim() || undefined, email: email.trim() || undefined, accept: legal ? accept : undefined, challenge: puzzle.token, nonce, website });
    },
    onSuccess: (result) => {
      setStep('');
      if (result.verify) {
        setVerify(true);
        setWaiting(Boolean(result.pending));
      } else if (result.pending) setWaiting(true);
      else client.invalidateQueries();
    },
    onError: () => setStep(''),
  });

  if (verify) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-muted">We sent a link to {email}. Open it to confirm your address{waiting ? ', then wait for an administrator to approve your account' : ''}. The link works for 3 days.</p>
        <button className="button-quiet" onClick={onBack}>Back to log in</button>
      </div>
    );
  }

  if (waiting) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Thank you</h1>
        <p className="text-sm text-muted">Your account has been created and is waiting for an administrator to approve it. Come back and log in once they have.</p>
        <button className="button-quiet" onClick={onBack}>Back to log in</button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
      <h1 className="text-xl font-semibold">Create an account</h1>
      <p className="text-sm text-muted">You get your own private books. No one else on this site can see them.</p>
      <label className="label">Username<input className="field" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      {needsEmail && <label className="label">Email address<input className="field" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>}
      <label className="label">Password (10 or more characters)<input className="field" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <label className="label">Password again<input className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
      <label className="label">{mode === 'invite' ? 'Invite code' : 'Invite code (if you have one)'}<input className="field" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} /></label>
      {legal && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>I agree to the <a href="/terms" target="_blank" rel="noreferrer" className="underline">terms of use</a> and <a href="/privacy" target="_blank" rel="noreferrer" className="underline">privacy</a> pages</span>
        </label>
      )}
      {/* A field people never see; a form-filling robot fills it in. */}
      <input className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} />
      <p className="text-xs text-muted">{needsEmail ? 'We use your email to confirm it is you and to reset a forgotten password.' : 'There is no way to reset a forgotten password by email, so keep it somewhere safe. An administrator can set a new one, but your books stay as they are.'}</p>
      {create.error && <p className="text-sm text-danger">{create.error.message}</p>}
      {step && <p className="text-sm text-muted" aria-live="polite">{step}</p>}
      <button className="button" disabled={create.isPending || !username.trim() || password.length < 10 || (mode === 'invite' && !code.trim()) || (needsEmail && !email.includes('@')) || (legal && !accept)}>Create account</button>
      <button type="button" className="button-quiet" onClick={onBack}>I already have an account</button>
    </form>
  );
}

function ResendLink() {
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: () => api.resendVerification(email.trim()) });
  return (
    <div className="flex flex-col gap-2 text-sm">
      {send.isSuccess ? (
        <p className="text-muted">If that address is waiting to be confirmed, a new link is on its way.</p>
      ) : (
        <>
          <label className="label">Send the link again to<input className="field" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <div><button type="button" className="button-quiet" disabled={send.isPending || !email.includes('@')} onClick={() => send.mutate()}>Send again</button></div>
        </>
      )}
    </div>
  );
}

function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: () => api.forgotPassword(email.trim()) });
  if (send.isSuccess) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-muted">If an account uses that address, a link to choose a new password is on its way. It works for one hour and only once. If two-step sign-in is on, you will still need your code.</p>
        <button className="button-quiet" onClick={onBack}>Back to log in</button>
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
      <h1 className="text-xl font-semibold">Forgot your password?</h1>
      <p className="text-sm text-muted">Enter the email address on your account and we will send you a link.</p>
      <label className="label">Email address<input className="field" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      {send.error && <p className="text-sm text-danger">{send.error.message}</p>}
      <button className="button" disabled={send.isPending || !email.includes('@')}>Send the link</button>
      <button type="button" className="button-quiet" onClick={onBack}>Back to log in</button>
    </form>
  );
}

// The pages the links in our emails open.
export function EmailLinkPage({ kind }: { kind: 'verify' | 'reset' }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const verify = useMutation({ mutationFn: () => api.verifyEmail(token) });
  const reset = useMutation({ mutationFn: () => api.resetPassword(token, password) });
  useEffect(() => {
    if (kind === 'verify') verify.mutate();
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const home = <a className="button-quiet" href="/">Go to Ledgerly</a>;
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="card flex w-full max-w-sm flex-col gap-4 p-6">
        {kind === 'verify' ? (
          verify.isPending || verify.isIdle ? <p className="text-sm text-muted">Confirming your address…</p>
          : verify.isError ? <><h1 className="text-xl font-semibold">That did not work</h1><p className="text-sm text-danger">{verify.error.message}</p>{home}</>
          : <><h1 className="text-xl font-semibold">Email confirmed</h1><p className="text-sm text-muted">{verify.data?.pending ? 'An administrator still has to approve your account. You can log in once they have.' : 'You can now log in.'}</p>{home}</>
        ) : reset.isSuccess ? (
          <><h1 className="text-xl font-semibold">Password changed</h1><p className="text-sm text-muted">You have been signed out everywhere. Log in with your new password.</p>{home}</>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (password !== again) reset.reset(); else reset.mutate(); }}>
            <h1 className="text-xl font-semibold">Choose a new password</h1>
            <label className="label">New password (10 or more characters)<input className="field" type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label className="label">Again<input className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
            {password !== '' && again !== '' && password !== again && <p className="text-sm text-danger">The two passwords are not the same</p>}
            {reset.error && <p className="text-sm text-danger">{reset.error.message}</p>}
            <button className="button" disabled={reset.isPending || password.length < 10 || password !== again}>Change password</button>
          </form>
        )}
      </div>
    </main>
  );
}

export function LoginPage() {
  const client = useQueryClient();
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const multi = auth.data?.multiUser ?? false;
  const signupMode = auth.data?.signup ?? 'closed';
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [forgot, setForgot] = useState(false);
  const login = useMutation({
    mutationFn: () => api.login(password, multi ? username : undefined, needsCode ? code.trim() : undefined),
    onSuccess: () => client.invalidateQueries(),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'two_factor') setNeedsCode(true);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate();
  }

  return (
    <main className="grid min-h-screen place-items-center p-4">
      {forgot ? (
        <div className="card flex w-full max-w-sm flex-col gap-4 p-6"><ForgotPassword onBack={() => setForgot(false)} /></div>
      ) : creating && multi && signupMode !== 'closed' ? (
        <div className="card flex w-full max-w-sm flex-col gap-4 p-6"><SignUp mode={signupMode} needsEmail={auth.data?.email ?? false} legal={auth.data?.legal ?? false} onBack={() => setCreating(false)} /></div>
      ) : (
      <form onSubmit={submit} className="card flex w-full max-w-sm flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">Ledgerly</h1>
        {multi && (
          <label className="label">
            Username
            <input className="field" autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
        )}
        <label className="label">
          Password
          <input
            className="field"
            type="password"
            autoComplete="current-password"
            autoFocus={!multi}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {needsCode && (
          <label className="label">
            Code from your authenticator app
            <input className="field" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(event) => setCode(event.target.value)} />
            <span className="text-xs text-muted">Lost your phone? Use one of your recovery codes here instead.</span>
          </label>
        )}
        {login.isError && !(needsCode && !code.trim()) && <p className="text-sm text-danger">{login.error.message}</p>}
        <button className="button" disabled={login.isPending || !password || (multi && !username.trim()) || (needsCode && !code.trim())}>
          Log in
        </button>
        {login.error instanceof ApiError && login.error.code === 'verify_email' && <ResendLink />}
        {multi && auth.data?.email && <button type="button" className="text-left text-sm text-muted underline" onClick={() => setForgot(true)}>Forgot password?</button>}
        {multi && signupMode !== 'closed' && (
          <button type="button" className="button-quiet" onClick={() => setCreating(true)}>Create an account</button>
        )}
        {auth.data?.legal && <p className="text-center text-xs text-muted"><a href="/terms" className="underline">Terms</a> · <a href="/privacy" className="underline">Privacy</a></p>}
      </form>
      )}
    </main>
  );
}
