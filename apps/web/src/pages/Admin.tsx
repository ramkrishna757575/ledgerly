import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { useEffect, useState, type FormEvent } from 'react';
import { api, fmtDateTime } from '../api.ts';
import { Prose } from '../components/Prose.tsx';

const size = (bytes: number) => (bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1_073_741_824 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${(bytes / 1_073_741_824).toFixed(2)} GB`);
const KIND = { wrong_password: 'Wrong password', wrong_code: 'Wrong two-step code', paused: 'Paused after too many tries', unknown_name: 'Name that is not an account' } as const;

function Tile({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

function Legal() {
  const client = useQueryClient();
  const legal = useQuery({ queryKey: ['admin-legal'], queryFn: api.adminLegal });
  const [terms, setTerms] = useState('');
  const [privacy, setPrivacy] = useState('');
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (legal.data) {
      setTerms(legal.data.terms);
      setPrivacy(legal.data.privacy);
      setEnabled(legal.data.enabled);
    }
  }, [legal.data]);
  const save = useMutation({ mutationFn: () => api.saveLegal({ enabled, terms, privacy }), onSuccess: () => client.invalidateQueries() });
  if (!legal.data) return null;
  const { templates } = legal.data;
  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Terms and privacy pages</h2>
      <p className="text-sm text-muted">
        People put their financial records here, so say what you do with them. The templates describe what Ledgerly does, but they are a starting point: read them, fill in the [PLACEHOLDERS], and have them checked for where you live. When switched on, they are shown at <code>/terms</code> and <code>/privacy</code> and people must agree to them to sign up.
      </p>
      <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <label className="label">
          <span className="flex items-center justify-between">Terms of use <button type="button" className="text-xs underline" onClick={() => setTerms(templates.terms)}>Start from the template</button></span>
          <textarea className="field min-h-40 font-mono text-xs" value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>
        <label className="label">
          <span className="flex items-center justify-between">Privacy <button type="button" className="text-xs underline" onClick={() => setPrivacy(templates.privacy)}>Start from the template</button></span>
          <textarea className="field min-h-40 font-mono text-xs" value={privacy} onChange={(e) => setPrivacy(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Show these pages and require agreement at sign-up</label>
        <div className="flex items-center gap-3">
          <button className="button" disabled={save.isPending}>Save</button>
          {save.isSuccess && <span className="text-sm text-muted">Saved.</span>}
        </div>
        {save.error && <p className="text-sm text-danger">{save.error.message}</p>}
      </form>
      {terms.trim() && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Preview the terms</summary>
          <div className="mt-2 rounded-md border border-line p-3"><Prose text={terms} /></div>
        </details>
      )}
    </section>
  );
}

export function AdminPage() {
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: api.adminOverview, enabled: auth.data?.isAdmin ?? false, refetchInterval: 60_000 });
  if (auth.data && !auth.data.isAdmin) return <p className="text-sm text-muted">Only administrators can see this.</p>;
  const o = overview.data;
  const peak = Math.max(1, ...(o?.signups.map((s) => s.count) ?? [1]));
  return (
    <div className="flex flex-col gap-6">
      <SectionTabs section="settings" />
      {overview.error && <p className="text-sm text-danger">{overview.error.message}</p>}
      {o && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="People" value={o.counts.total} note={`${o.counts.active} active · ${o.counts.administrators} administrators`} />
            <Tile label="Waiting for approval" value={o.counts.waiting} note={o.counts.unconfirmed > 0 ? `${o.counts.unconfirmed} have not confirmed their email` : undefined} />
            <Tile label="Two-step sign-in" value={`${o.counts.twoFactor} of ${o.counts.total}`} />
            <Tile label="Storage used" value={size(o.totalBytes)} note={`${o.openLedgers} books open now`} />
          </div>
          <p className="text-sm text-muted">
            Sign-up is <strong>{o.signupMode}</strong>{o.signupMode === 'open' ? ' (anyone can create an account straight away)' : ''}. Mail is {o.mailOn ? 'on' : 'not set up, so there is no email confirmation or password reset'}. Change who can sign up under People.
          </p>

          <section className="card flex flex-col gap-3 p-4">
            <h2 className="font-medium">Sign-ups, last 14 days</h2>
            <div className="flex h-20 items-end gap-1" role="img" aria-label={`Sign-ups per day: ${o.signups.map((s) => s.count).join(', ')}`}>
              {o.signups.map((s) => (
                <div key={s.date} className="flex flex-1 flex-col justify-end" title={`${s.date}: ${s.count}`}>
                  <div className="rounded-t bg-accent" style={{ height: `${(s.count / peak) * 100}%`, minHeight: s.count > 0 ? 3 : 1, opacity: s.count > 0 ? 1 : 0.25 }} />
                </div>
              ))}
            </div>
          </section>

          <section className="card flex flex-col gap-3 p-4">
            <h2 className="font-medium">People, by space used</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-muted"><th className="py-1 pr-3 font-normal">Username</th><th className="py-1 pr-3 font-normal">Status</th><th className="py-1 pr-3 text-right font-normal">Space</th><th className="py-1 pr-3 font-normal">Last sign-in</th><th className="py-1 font-normal">Two-step</th></tr></thead>
                <tbody>
                  {o.people.map((p) => (
                    <tr key={p.id} className="border-t border-line">
                      <td className="py-2 pr-3">{p.username}{p.role === 'admin' && <span className="ml-2 text-xs text-muted">admin</span>}</td>
                      <td className="py-2 pr-3 text-muted">{p.status}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{size(p.bytes)}{o.quotaBytes && p.role !== 'admin' ? <span className="text-xs text-muted"> / {size(o.quotaBytes)}</span> : null}</td>
                      <td className="py-2 pr-3 text-muted">{p.lastLoginAt ? fmtDateTime(p.lastLoginAt) : 'never'}</td>
                      <td className="py-2 text-muted">{p.twoFactor ? 'on' : 'off'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card flex flex-col gap-3 p-4">
            <h2 className="font-medium">Failed sign-ins</h2>
            <p className="text-xs text-muted">The latest, since the server last started. A name is shown only if it is a real account. Many from one address is someone guessing.</p>
            {o.failures.length === 0 ? <p className="text-sm text-muted">None.</p> : (
              <ul className="divide-y divide-line text-sm">
                {o.failures.map((f, i) => (
                  <li key={`${f.at}${i}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
                    <span>{KIND[f.kind]}{f.username && <> for <strong>{f.username}</strong></>}</span>
                    <span className="text-muted">{f.ip} · {fmtDateTime(f.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <Legal />
    </div>
  );
}

// The public pages.
export function LegalPage({ which }: { which: 'terms' | 'privacy' }) {
  const legal = useQuery({ queryKey: ['legal'], queryFn: api.legal });
  const text = legal.data?.enabled ? legal.data[which] : '';
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 p-6">
      {legal.isPending ? null : text ? <Prose text={text} /> : <p className="text-sm text-muted">This page has not been written yet.</p>}
      <p><a href="/" className="text-sm text-accent underline">Back to Ledgerly</a></p>
    </main>
  );
}
