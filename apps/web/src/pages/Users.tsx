import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { useState, type FormEvent } from 'react';
import { api, chooseLedger, fmtDateTime, type UserRow } from '../api.ts';

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setDone(true);
      setCurrent('');
      setNext('');
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setDone(false);
    change.mutate();
  }
  return (
    <form className="card flex flex-col gap-3 p-4" onSubmit={submit}>
      <h2 className="font-medium">Change your password</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">Current<input className="field" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label className="label">New (8 or more characters)<input className="field" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <button className="button" disabled={change.isPending || !current || next.length < 8}>Change</button>
      </div>
      <p className="text-xs text-muted">This signs you out everywhere else.</p>
      {done && <p className="text-sm text-muted" aria-live="polite">Password changed.</p>}
      {change.error && <p className="text-sm text-danger">{change.error.message}</p>}
    </form>
  );
}

const MODES = [
  ['closed', 'Closed: only administrators make accounts'],
  ['invite', 'Invite only: people need a code you give them'],
  ['approval', 'Open, with approval: anyone can sign up, you let them in'],
  ['open', 'Open: anyone can sign up and use it at once'],
] as const;

function SignupSection() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ['signup'], queryFn: api.signupSettings });
  const refresh = () => client.invalidateQueries();
  const setMode = useMutation({ mutationFn: api.setSignupMode, onSuccess: refresh });
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [note, setNote] = useState('');
  const [fresh, setFresh] = useState<{ code: string; expiresAt: string } | null>(null);
  const create = useMutation({ mutationFn: () => api.createInvite({ role, note: note || undefined }), onSuccess: (r) => { setFresh(r); setNote(''); refresh(); } });
  const revoke = useMutation({ mutationFn: api.revokeInvite, onSuccess: refresh });
  const data = state.data;
  if (!data) return null;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Who can create an account</h2>
      <label className="label max-w-xl">
        Sign-up
        <select className="field" value={data.mode} disabled={setMode.isPending} onChange={(e) => setMode.mutate(e.target.value)}>
          {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {data.mode === 'open' && <p className="text-xs text-muted">Anyone on the internet can create an account and store files here. Keep an eye on storage, and consider "open, with approval" for a public site.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">Invite for<select className="field" value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}><option value="user">A regular user</option><option value="admin">An administrator</option></select></label>
        <label className="label">Note (optional)<input className="field" value={note} placeholder="Who it is for" onChange={(e) => setNote(e.target.value)} /></label>
        <button className="button" disabled={create.isPending || data.mode === 'closed'} onClick={() => create.mutate()}>Make an invite code</button>
      </div>
      {data.mode === 'closed' && <p className="text-xs text-muted">Invite codes work once sign-up is not closed.</p>}
      {fresh && (
        <div className="rounded-md border border-line p-3 text-sm" aria-live="polite">
          <p>Give them this code. It is shown only now, works once, and expires {fmtDateTime(fresh.expiresAt)}.</p>
          <p className="mt-1 font-mono text-lg">{fresh.code}</p>
        </div>
      )}
      {data.invites.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {data.invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{i.role === 'admin' ? 'Administrator' : 'User'} invite{i.note ? `, ${i.note}` : ''} <span className="text-muted">· {i.usedBy ? `used ${fmtDateTime(i.usedAt!)}` : i.expiresAt < new Date().toISOString() ? 'expired' : `expires ${fmtDateTime(i.expiresAt)}`}</span></span>
              {!i.usedBy && <button className="button-quiet" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>Withdraw</button>}
            </li>
          ))}
        </ul>
      )}
      {(setMode.error || create.error || revoke.error) && <p className="text-sm text-danger">{(setMode.error ?? create.error ?? revoke.error)!.message}</p>}
    </section>
  );
}

function CloseAccount({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const close = useMutation({ mutationFn: () => api.closeAccount(password, confirm), onSuccess: () => window.location.assign('/') });
  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Close my account</h2>
      <p className="text-sm text-muted">This deletes all of your books, statements and receipts for good. Download a backup first from Backups and export.</p>
      {!open ? (
        <div><button className="button-quiet" onClick={() => setOpen(true)}>I want to close my account</button></div>
      ) : (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); close.mutate(); }}>
          <label className="label">Your password<input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label className="label">Type your username ({username})<input className="field" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          <button className="button" disabled={close.isPending || !password || confirm !== username}>Delete everything</button>
        </form>
      )}
      {close.error && <p className="text-sm text-danger">{close.error.message}</p>}
    </section>
  );
}

function Sharing() {
  const client = useQueryClient();
  const shares = useQuery({ queryKey: ['shares'], queryFn: api.shares });
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');
  const refresh = () => client.invalidateQueries({ queryKey: ['shares'] });
  const add = useMutation({ mutationFn: () => api.share(username.trim(), role), onSuccess: () => { setUsername(''); refresh(); } });
  const remove = useMutation({ mutationFn: (id: number) => api.unshare(id), onSuccess: refresh });
  const leave = useMutation({ mutationFn: (id: number) => api.leaveShare(id), onSuccess: refresh });
  const granted = shares.data?.granted ?? [];
  const received = shares.data?.received ?? [];
  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Share my books</h2>
      <p className="text-sm text-muted">
        Let someone with an account here (a partner, an accountant) into your books. A <strong>viewer</strong> can look at everything and change nothing. An <strong>editor</strong> can also add and change transactions, accounts and budgets. Neither can see your settings, keys, mailbox or backups, and you can take access away at any time.
      </p>
      {granted.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {granted.map((g) => (
            <li key={g.memberId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{g.username} <span className="text-muted">· {g.role}</span></span>
              <button className="button-quiet" disabled={remove.isPending} onClick={() => window.confirm(`Take ${g.username}'s access away?`) && remove.mutate(g.memberId)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
        <label className="label">Their username<input className="field" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label className="label">Can<select className="field" value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}><option value="viewer">Look only</option><option value="editor">Look and change</option></select></label>
        <button className="button" disabled={add.isPending || username.trim().length < 3}>Share</button>
      </form>
      {received.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="text-sm font-medium">Books shared with me</h3>
          <ul className="divide-y divide-line text-sm">
            {received.map((r) => (
              <li key={r.ownerId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{r.username}'s books <span className="text-muted">· {r.role}</span></span>
                <span className="flex gap-2">
                  <button className="button-quiet" onClick={() => chooseLedger(r.ownerId)}>Open</button>
                  <button className="button-quiet" disabled={leave.isPending} onClick={() => window.confirm(`Stop having access to ${r.username}'s books?`) && leave.mutate(r.ownerId)}>Leave</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(add.error || remove.error || leave.error) && <p className="text-sm text-danger">{(add.error ?? remove.error ?? leave.error)!.message}</p>}
    </section>
  );
}

function TwoFactor() {
  const client = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const on = auth.data?.twoFactor ?? false;
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const setup = useMutation({ mutationFn: () => api.twoFactorSetup(password) });
  const enable = useMutation({
    mutationFn: () => api.twoFactorEnable(code),
    onSuccess: () => {
      setCode('');
      setPassword('');
      client.invalidateQueries({ queryKey: ['auth'] });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.twoFactorDisable(password, code),
    onSuccess: () => {
      setCode('');
      setPassword('');
      setOpen(false);
      client.invalidateQueries({ queryKey: ['auth'] });
    },
  });
  const recovery = enable.data?.recoveryCodes;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Two-step sign-in</h2>
      <p className="text-sm text-muted">
        {on
          ? 'On. Signing in needs your password and a 6-digit code from your authenticator app, so a stolen password alone is not enough.'
          : 'Adds a 6-digit code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy or 1Password) to your password. Recommended, since your books are private financial records.'}
      </p>

      {recovery && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
          <p className="font-medium">Save your recovery codes now. They are shown only once.</p>
          <p className="text-muted">Each works once if you lose your phone. Keep them somewhere safe, apart from your password.</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-4">
            {recovery.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <label className="flex items-center gap-2"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved them</label>
          {saved && <div><button className="button-quiet" onClick={() => { enable.reset(); setup.reset(); setSaved(false); }}>Done</button></div>}
        </div>
      )}

      {!on && !recovery && !setup.data && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); setup.mutate(); }}>
          <label className="label">Your password<input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="button" disabled={setup.isPending || !password}>Set up</button>
        </form>
      )}

      {!on && setup.data && !recovery && (
        <div className="flex flex-col gap-3 text-sm">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted">
            <li>Open your authenticator app and add an account by scanning this picture.</li>
            <li>No camera? Choose "enter a key" and type <span className="font-mono text-ink">{setup.data.secret}</span> (time based).</li>
            <li>Type the 6-digit code it shows below.</li>
          </ol>
          <div className="w-48 rounded-md bg-white p-1" aria-label="QR code" dangerouslySetInnerHTML={{ __html: setup.data.qr }} />
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); enable.mutate(); }}>
            <label className="label">Code<input className="field w-36" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <button className="button" disabled={enable.isPending || code.trim().length < 6}>Turn on</button>
          </form>
        </div>
      )}

      {on && !recovery && (
        !open ? (
          <div><button className="button-quiet" onClick={() => setOpen(true)}>Turn off</button></div>
        ) : (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); disable.mutate(); }}>
            <label className="label">Your password<input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label className="label">Code or recovery code<input className="field" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <button className="button" disabled={disable.isPending || !password || !code.trim()}>Turn off</button>
            <button type="button" className="button-quiet" onClick={() => setOpen(false)}>Cancel</button>
          </form>
        )
      )}
      {(setup.error || enable.error || disable.error) && <p className="text-sm text-danger">{(setup.error ?? enable.error ?? disable.error)!.message}</p>}
    </section>
  );
}

function UserForm() {
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const create = useMutation({
    mutationFn: () => api.createUser({ username, password, role }),
    onSuccess: () => {
      setUsername('');
      setPassword('');
      client.invalidateQueries({ queryKey: ['users'] });
    },
  });
  return (
    <form className="card flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <h2 className="font-medium">Add a person</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">Username<input className="field" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label className="label">Password (8 or more)<input className="field" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label className="label">Can<select className="field" value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}><option value="user">Use their own books</option><option value="admin">Also manage people</option></select></label>
        <button className="button" disabled={create.isPending || username.trim().length < 3 || password.length < 8}>Add</button>
      </div>
      <p className="text-xs text-muted">They get a separate, empty ledger. You cannot see their books, and they cannot see yours.</p>
      {create.error && <p className="text-sm text-danger">{create.error.message}</p>}
    </form>
  );
}

function Row({ user, me }: { user: UserRow; me: string | null | undefined }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['users'] });
  const update = useMutation({ mutationFn: (patch: { disabled?: boolean; role?: 'admin' | 'user'; password?: string; approve?: boolean }) => api.updateUser(user.id, patch), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (confirm: string) => api.deleteUser(user.id, confirm), onSuccess: refresh });
  const error = (update.error ?? remove.error)?.message;
  const self = user.username === me;

  return (
    <li className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{user.username}{self && <span className="ml-2 text-sm font-normal text-muted">you</span>}</p>
        <p className="text-sm text-muted">{user.role === 'admin' ? 'Administrator' : 'User'}{user.pending && ' · waiting for approval'}{user.twoFactor && ' · two-step on'}{user.disabled && ' · disabled'} · since {fmtDateTime(user.createdAt)}</p>
      </div>
      {!self && (
        <div className="flex flex-wrap gap-2">
          {user.pending && <button className="button" disabled={update.isPending} onClick={() => update.mutate({ approve: true })}>Approve</button>}
          {user.pending && <button className="button-quiet" disabled={remove.isPending} onClick={() => window.confirm(`Turn ${user.username} away?`) && remove.mutate(user.username)}>Turn away</button>}
          <button className="button-quiet" disabled={update.isPending} onClick={() => update.mutate({ role: user.role === 'admin' ? 'user' : 'admin' })}>{user.role === 'admin' ? 'Make a regular user' : 'Make an administrator'}</button>
          <button
            className="button-quiet"
            onClick={() => {
              const password = window.prompt(`New password for ${user.username} (8 or more characters)`);
              if (password) update.mutate({ password });
            }}
          >
            Set a new password
          </button>
          {user.twoFactor && (
            <button className="button-quiet" onClick={() => window.confirm(`Turn off two-step sign-in for ${user.username}? Do this only if they have lost their phone and recovery codes, and you are sure it is them.`) && api.resetTwoFactor(user.id).then(refresh)}>
              Reset two-step
            </button>
          )}
          <button className="button-quiet" disabled={update.isPending} onClick={() => update.mutate({ disabled: !user.disabled })}>{user.disabled ? 'Enable' : 'Disable'}</button>
          {user.disabled && !user.holdsFirstBooks && (
            <button
              className="button-quiet"
              disabled={remove.isPending}
              onClick={() => {
                const typed = window.prompt(`This deletes ${user.username}'s books, statements and receipts for good. Type their username to confirm.`);
                if (typed) remove.mutate(typed);
              }}
            >
              Delete everything
            </button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </li>
  );
}

export function UsersPage() {
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const admin = auth.data?.isAdmin ?? false;
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: admin });

  return (
    <div className="flex flex-col gap-6">
      <SectionTabs section="settings" />
      {auth.data?.multiUser ? (
        <>
          {admin && (
            <>
              <p className="text-sm text-muted">Everyone has their own separate books, statements, receipts, backups, agent tokens and settings. Administrators manage who can sign in, and cannot read anyone else's money.</p>
              <ul className="card divide-y divide-line">
                {users.data?.map((u) => <Row key={u.id} user={u} me={auth.data?.username} />)}
              </ul>
              <SignupSection />
              <UserForm />
            </>
          )}
          <ChangePassword />
          <Sharing />
          <TwoFactor />
          {auth.data?.username && <CloseAccount username={auth.data.username} />}
        </>
      ) : (
        <p className="card p-6 text-sm text-muted">This server is set up for one person. To let others in with their own separate books, set <code>MULTI_USER=true</code> (with <code>AUTH_PASSWORD</code>, which becomes the first administrator's password) and restart. Your existing books stay with that first administrator.</p>
      )}
    </div>
  );
}
