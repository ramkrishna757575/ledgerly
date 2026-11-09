import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { useState } from 'react';
import { api, fmtDateTime } from '../api.ts';

function OwnChannels({ own, onChange }: { own: { id: string; kind: string; host: string }[]; onChange: () => void }) {
  const [kind, setKind] = useState<'ntfy' | 'telegram' | 'webhook'>('ntfy');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [chat, setChat] = useState('');
  const add = useMutation({
    mutationFn: () => api.addChannel(kind === 'telegram' ? { kind, token, chat } : { kind, url }),
    onSuccess: () => {
      setUrl('');
      setToken('');
      setChat('');
      onChange();
    },
  });
  const remove = useMutation({ mutationFn: api.removeChannel, onSuccess: onChange });
  const LABEL = { ntfy: 'ntfy', telegram: 'Telegram', webhook: 'Webhook' } as const;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Your own places to send messages</h2>
      <p className="text-sm text-muted">Add a phone or chat of your own. The address or token is kept in your books and never shown again, only where it goes. Alerts from your books go here, whoever else uses this server.</p>
      {own.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {own.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2">
              <span>{LABEL[c.kind as keyof typeof LABEL]} <span className="text-muted">({c.host})</span></span>
              <button className="button-quiet" disabled={remove.isPending} onClick={() => remove.mutate(c.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <label className="label">Kind<select className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="ntfy">ntfy</option><option value="telegram">Telegram</option><option value="webhook">Webhook (Slack, Discord…)</option></select></label>
        {kind === 'telegram' ? (
          <>
            <label className="label">Bot token<input className="field" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
            <label className="label">Chat id<input className="field w-32" value={chat} onChange={(e) => setChat(e.target.value)} /></label>
          </>
        ) : (
          <label className="label">Address<input className="field w-72" type="password" autoComplete="off" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        )}
        <button className="button" disabled={add.isPending || (kind === 'telegram' ? !token || !chat : !url)}>Add</button>
      </form>
      {(add.error || remove.error) && <p className="text-sm text-danger">{(add.error ?? remove.error)!.message}</p>}
    </section>
  );
}

export function AlertsPage() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ['alerts'], queryFn: api.alerts });
  const refresh = () => client.invalidateQueries({ queryKey: ['alerts'] });
  const save = useMutation({ mutationFn: api.setAlertKinds, onSuccess: refresh });
  const digest = useMutation({ mutationFn: api.setDigest, onSuccess: refresh });
  const test = useMutation({ mutationFn: api.testAlert, onSuccess: refresh });
  const data = state.data;
  const enabled = data?.kinds.filter((k) => k.enabled).map((k) => k.kind) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <SectionTabs section="automation" />
      <p className="text-sm text-muted">
        A message to your phone or chat when something needs you, so you do not have to open the app to find out. Each finding is sent once, and a new bill or a new month is a new message. Only the finding's title and a line of detail are sent, never account names or numbers.
      </p>

      {data && <OwnChannels own={data.own} onChange={refresh} />}

      {data && data.channels.length === 0 && (
        <section className="card flex flex-col gap-2 p-4 text-sm text-muted">
          <p>No way to send messages is set up. Set one or more of these in <code>.env</code> and restart:</p>
          <pre className="overflow-x-auto rounded-md border border-line p-3 text-xs">{`# ntfy (free, works on your phone: https://ntfy.sh)
NOTIFY_NTFY_URL=https://ntfy.sh/your-private-topic

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Slack, Discord, Mattermost or your own endpoint
NOTIFY_WEBHOOK_URL=https://...`}</pre>
        </section>
      )}

      {data && data.channels.length > 0 && (
        <>
          <section className="card flex flex-col gap-3 p-4">
            <h2 className="font-medium">Sending to</h2>
            <ul className="text-sm">
              {data.channels.map((c) => (
                <li key={c.id}>{c.label} <span className="text-muted">({c.host})</span></li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <button className="button" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Sending…' : 'Send a test message'}</button>
              {test.data && <span className={`text-sm ${test.data.ok ? 'text-muted' : 'text-danger'}`}>{test.data.ok ? 'Sent.' : `Failed: ${test.data.error}`}</span>}
              {test.error && <span className="text-sm text-danger">{test.error.message}</span>}
            </div>
            <p className="text-xs text-muted">Checked every hour. {data.waiting > 0 ? `${data.waiting} finding${data.waiting === 1 ? ' is' : 's are'} waiting to go out.` : 'Nothing is waiting.'}</p>
          </section>

          <section className="card flex flex-col gap-3 p-4">
            <h2 className="font-medium">Tell me about</h2>
            <ul className="flex flex-col gap-2">
              {data.kinds.map((k) => (
                <li key={k.kind}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={k.enabled}
                      disabled={save.isPending}
                      onChange={(e) => save.mutate(e.target.checked ? [...enabled, k.kind] : enabled.filter((x) => x !== k.kind))}
                    />
                    {k.label}
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className="card flex flex-col gap-2 p-4">
            <h2 className="font-medium">Summary</h2>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              Send a short summary
              <select className="field" value={data.digest} disabled={digest.isPending} onChange={(e) => digest.mutate(e.target.value)}>
                <option value="off">Never</option>
                <option value="weekly">Every Monday</option>
                <option value="monthly">On the 1st of each month</option>
              </select>
            </label>
            <p className="text-xs text-muted">Net worth and its change, idle cash, what is due this week, budgets and the lowest bank balance ahead. Totals only: no names.</p>
          </section>

          {data.log.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="font-medium">Recently sent</h2>
              <ul className="card divide-y divide-line text-sm">
                {data.log.map((entry, i) => (
                  <li key={i} className="p-3">
                    <p className="text-xs text-muted">{fmtDateTime(entry.at)} · {entry.channels.join(', ')} · {entry.ok ? 'delivered' : <span className="text-danger">failed: {entry.error}</span>}</p>
                    <ul className="mt-1 list-disc pl-5">
                      {entry.titles.map((t, j) => <li key={j}>{t}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {state.error && <p className="text-sm text-danger">{state.error.message}</p>}
    </div>
  );
}
