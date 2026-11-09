import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { useState, type FormEvent } from 'react';
import { api, type SettingsState } from '../api.ts';

function Result({ ok, text }: { ok: boolean; text: string }) {
  return <p className={`text-sm ${ok ? 'text-muted' : 'text-danger'}`} aria-live="polite">{text}</p>;
}

function AiSection({ state, restricted }: { state: SettingsState['ai']; restricted: boolean }) {
  const client = useQueryClient();
  const own = state.own;
  const [provider, setProvider] = useState(own?.provider ?? 'anthropic');
  const [model, setModel] = useState(own?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(own?.baseUrl ?? '');
  const [region, setRegion] = useState(own?.region ?? '');
  const [key, setKey] = useState('');
  const refresh = () => client.invalidateQueries();
  const save = useMutation({ mutationFn: () => api.saveAiSettings({ provider, model, baseUrl, region, apiKey: key }), onSuccess: () => { setKey(''); refresh(); } });
  const clear = useMutation({ mutationFn: api.clearAiSettings, onSuccess: refresh });
  const test = useMutation({ mutationFn: api.testAi });

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">AI provider</h2>
      <p className="text-sm text-muted">
        Your own key, used for the Review, Ask, category suggestions and receipt reading, each of which stays off until you turn it on.
        {state.usingServerDefault && ` Until you add one, this site's ${state.provider} (${state.model}) is used.`}
        {' '}Your key is stored encrypted and never shown again.
      </p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <label className="label">Provider<select className="field" value={provider} onChange={(e) => setProvider(e.target.value)}><option value="anthropic">Anthropic</option><option value="bedrock">Amazon Bedrock</option><option value="openai">OpenAI-compatible server</option></select></label>
        <label className="label">Model<input className="field w-56" value={model} placeholder={provider === 'anthropic' ? 'claude-sonnet-5-5' : ''} onChange={(e) => setModel(e.target.value)} /></label>
        {(provider === 'openai' || baseUrl) && <label className="label">Server address<input className="field w-72" value={baseUrl} placeholder="https://…/v1" onChange={(e) => setBaseUrl(e.target.value)} /></label>}
        {provider === 'bedrock' && <label className="label">Region<input className="field w-32" value={region} placeholder="ap-south-1" onChange={(e) => setRegion(e.target.value)} /></label>}
        <label className="label">API key<input className="field w-64" type="password" autoComplete="off" value={key} placeholder={own?.hasKey ? '•••••• saved' : ''} onChange={(e) => setKey(e.target.value)} /></label>
        <button className="button" disabled={save.isPending}>Save</button>
      </form>
      {restricted && <p className="text-xs text-muted">On this site a server address must be a public https address.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button className="button-quiet" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test'}</button>
        {own && <button className="button-quiet" disabled={clear.isPending} onClick={() => window.confirm('Remove your AI provider and key?') && clear.mutate()}>Remove</button>}
      </div>
      {test.data && <Result ok text={`Worked: ${test.data.destination.host}, ${test.data.milliseconds} ms.`} />}
      {(save.error || test.error || clear.error) && <Result ok={false} text={(save.error ?? test.error ?? clear.error)!.message} />}
    </section>
  );
}

function MailSection({ state, restricted }: { state: SettingsState['mail']; restricted: boolean }) {
  const client = useQueryClient();
  const own = state.own;
  const [host, setHost] = useState(own?.host ?? '');
  const [port, setPort] = useState(String(own?.port ?? 993));
  const [secure, setSecure] = useState(own?.secure ?? true);
  const [user, setUser] = useState(own?.user ?? '');
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState(own?.folder ?? 'INBOX');
  const [senders, setSenders] = useState((own?.senders ?? []).join(', '));
  const [requireAuth, setRequireAuth] = useState(own?.requireAuth ?? true);
  const refresh = () => client.invalidateQueries();
  const form = () => ({ host, port: Number(port), secure, user, password: password || undefined, folder, senders: senders.split(',').map((s) => s.trim()).filter(Boolean), requireAuth });
  const save = useMutation({
    mutationFn: () => api.saveMailSettings(form()),
    onSuccess: () => { setPassword(''); refresh(); },
  });
  const clear = useMutation({ mutationFn: api.clearMailSettings, onSuccess: refresh });
  // The test reads what is saved, so what is on the form is saved first.
  const test = useMutation({
    mutationFn: async () => {
      await api.saveMailSettings(form());
      setPassword('');
      await refresh();
      return api.testMail();
    },
  });

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Mailbox for statements</h2>
      <p className="text-sm text-muted">
        Use a mailbox just for statements, with an app password (not your main one). Only unread mail from the senders you list is read, and only if your mail provider confirmed the sender. Never deleted, moved or sent. Details are on the Import page.
        {state.usingServerDefault && ' This site has a mailbox set up that is used until you add yours.'}
      </p>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <label className="label">Server<input className="field" value={host} placeholder="imap.gmail.com" onChange={(e) => setHost(e.target.value)} /></label>
        <label className="label">Port<input className="field w-28" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} /></label>
        <label className="label">Username<input className="field" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} /></label>
        <label className="label">App password<input className="field" type="password" autoComplete="off" value={password} placeholder={own?.hasPassword ? '•••••• saved' : ''} onChange={(e) => setPassword(e.target.value)} /></label>
        <label className="label">Folder<input className="field" value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
        <label className="label">Senders to read (comma separated)<input className="field" value={senders} placeholder="axisbank.com, scripbox.com" onChange={(e) => setSenders(e.target.value)} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />Secure connection (TLS)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={requireAuth} onChange={(e) => setRequireAuth(e.target.checked)} />Only believe mail the provider confirmed</label>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button className="button" disabled={save.isPending}>Save</button>
          <button type="button" className="button-quiet" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test connection'}</button>
          {own && <button type="button" className="button-quiet" disabled={clear.isPending} onClick={() => window.confirm('Remove your mailbox?') && clear.mutate()}>Remove</button>}
        </div>
      </form>
      {restricted && <p className="text-xs text-muted">On this site the server must be on the public internet.</p>}
      {test.data && <Result ok={test.data.ok} text={test.data.ok ? 'Connected.' : `Could not connect: ${test.data.error}`} />}
      {(save.error || clear.error || test.error) && <Result ok={false} text={(save.error ?? clear.error ?? test.error)!.message} />}
    </section>
  );
}

function FolderSection({ state }: { state: SettingsState['watch'] }) {
  const client = useQueryClient();
  const [passwords, setPasswords] = useState('');
  const refresh = () => client.invalidateQueries();
  const save = useMutation({ mutationFn: (input: { enabled?: boolean; passwords?: string[] }) => api.saveWatchSettings(input), onSuccess: refresh });

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Statement folder and locked PDFs</h2>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={state.own || state.enabled} disabled={save.isPending || (state.enabled && !state.own)} onChange={(e) => save.mutate({ enabled: e.target.checked })} />
        Import statements dropped in my own folder
      </label>
      {state.folder && <p className="text-xs text-muted">The folder is <code>{state.folder}</code>. Statements put there are imported by the same safe rules as bulk import.</p>}
      <form className="flex flex-col gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate({ passwords: passwords.split('\n') }); setPasswords(''); }}>
        <label className="label">
          Passwords for your locked PDFs, one per line ({state.passwords} saved, never shown again)
          <textarea className="field min-h-20" autoComplete="off" value={passwords} placeholder="Replaces the saved ones" onChange={(e) => setPasswords(e.target.value)} />
        </label>
        <div><button className="button" disabled={save.isPending}>Save passwords</button></div>
      </form>
      {save.error && <Result ok={false} text={save.error.message} />}
    </section>
  );
}

function EmailSection({ state }: { state: SettingsState['summary'] }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(false);
  const change = useMutation({
    mutationFn: () => api.changeEmail(email, password),
    onSuccess: () => { setPassword(''); setEmail(''); setOpen(false); client.invalidateQueries(); },
  });
  const summary = useMutation({ mutationFn: (on: boolean) => api.saveSummary(on), onSuccess: () => client.invalidateQueries({ queryKey: ['settings'] }) });
  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Email</h2>
      <p className="text-sm text-muted">
        {state.email ? <>Mail goes to <span className="text-ink">{state.email}</span>.</> : 'No email address yet.'}{' '}
        {state.canSend ? 'It is used to reset a forgotten password and for the monthly summary.' : 'This server cannot send mail, so there are no reset or summary emails.'}
      </p>
      {state.canSend && (
        <>
          {!open ? (
            <div><button className="button-quiet" onClick={() => setOpen(true)}>{state.email ? 'Change address' : 'Add an address'}</button></div>
          ) : (
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); change.mutate(); }}>
              <label className="label">New address<input className="field" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              <label className="label">Your password<input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <button className="button" disabled={change.isPending || !email || !password}>Send confirmation</button>
              <button type="button" className="button-quiet" onClick={() => setOpen(false)}>Cancel</button>
            </form>
          )}
          {change.data && !change.data.changed && <p className="text-sm text-muted">We sent a link to {change.data.sentTo}. The address changes once you open it.</p>}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={state.enabled} disabled={summary.isPending || !state.email} onChange={(e) => summary.mutate(e.target.checked)} />
            <span>
              Email me a summary each month
              <span className="block text-xs text-muted">Last month's income, spending, saved, where most of it went, and anything needing attention. It contains your figures, and email is not private from your mail provider.</span>
            </span>
          </label>
        </>
      )}
      {(change.error || summary.error) && <p className="text-sm text-danger">{(change.error ?? summary.error)!.message}</p>}
    </section>
  );
}

function Storage({ usage }: { usage: SettingsState['usage'] }) {
  const mb = (n: number) => (n / 1_048_576).toFixed(n < 10 * 1_048_576 ? 1 : 0);
  return (
    <section className="card flex flex-col gap-2 p-4">
      <h2 className="font-medium">Storage</h2>
      <p className="text-sm text-muted">{mb(usage.used)} MB used{usage.quota ? ` of ${mb(usage.quota)} MB` : ''} by your books, statements, receipts and backups.</p>
      {usage.quota && (
        <div className="h-2 rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round((usage.used / usage.quota) * 100))} aria-label="Storage used">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, (usage.used / usage.quota) * 100)}%`, background: usage.used / usage.quota > 0.9 ? 'var(--color-danger)' : 'var(--color-accent)' }} />
        </div>
      )}
    </section>
  );
}

export function SettingsPage() {
  const state = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const data = state.data;
  return (
    <div className="flex flex-col gap-6">
      <SectionTabs section="settings" />
      <p className="text-sm text-muted">These belong to your books alone. Keys and passwords are stored encrypted and are never sent back to this page.</p>
      {data && (
        <>
          <Storage usage={data.usage} />
          <EmailSection state={data.summary} />
          <AiSection state={data.ai} restricted={data.restricted} />
          <MailSection state={data.mail} restricted={data.restricted} />
          <FolderSection state={data.watch} />
        </>
      )}
      {state.error && <p className="text-sm text-danger">{state.error.message}</p>}
    </div>
  );
}
