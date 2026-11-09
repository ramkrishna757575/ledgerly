import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { useState } from 'react';
import { api, fmtDateTime } from '../api.ts';

const size = (bytes: number) => (bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`);

function SafetyChecks() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['backups', 'status'], queryFn: api.backupStatus });
  const refresh = () => client.invalidateQueries({ queryKey: ['backups'] });
  const verify = useMutation({ mutationFn: api.verifyBackup, onSuccess: refresh });
  const copy = useMutation({ mutationFn: api.copyBackupOut, onSuccess: refresh });
  const s = status.data;
  if (!s) return null;
  const line = (label: string, o: { at: string; ok: boolean; detail: string } | null, empty: string) => (
    <p className="text-sm">
      <span className="font-medium">{label}:</span>{' '}
      {o ? <span className={o.ok ? 'text-muted' : 'text-danger'}>{o.ok ? '✓' : '✗'} {fmtDateTime(o.at)}. {o.detail}</span> : <span className="text-muted">{empty}</span>}
    </p>
  );
  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Are my backups safe?</h2>
      {line('Restore check', s.verified, 'Not checked yet. After each daily backup the newest is opened in a scratch copy to make sure it could really be restored.')}
      {s.configured ? line(`Copy kept somewhere else (${s.where.join(' and ')})`, s.last, 'No copy made yet. It happens after each daily backup.') : (
        <p className="text-sm text-muted">
          {s.problem ? <span className="text-danger">{s.problem}. </span> : null}
          <span className="font-medium text-ink">Off-machine copy:</span> not set up. Backups on the same disk do not survive the disk. Set <code>BACKUP_PASSPHRASE</code> and <code>BACKUP_COPY_DIR</code> (a mounted or synced folder) or the <code>BACKUP_S3_*</code> settings (Amazon S3, Backblaze B2, Cloudflare R2, MinIO) and each new backup is encrypted and copied there.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="button-quiet" disabled={verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? 'Checking…' : 'Check the newest backup now'}</button>
        {s.configured && <button className="button-quiet" disabled={copy.isPending} onClick={() => copy.mutate()}>{copy.isPending ? 'Copying…' : 'Copy the newest out now'}</button>}
      </div>
      {(verify.error || copy.error) && <p className="text-sm text-danger">{(verify.error ?? copy.error)!.message}</p>}
    </section>
  );
}

function Backups() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['backups'], queryFn: api.backups });
  const refresh = () => client.invalidateQueries({ queryKey: ['backups'] });
  const create = useMutation({ mutationFn: api.createBackup, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteBackup, onSuccess: refresh });

  const enabled = list.data?.enabled ?? true;
  const items = list.data?.items ?? [];
  const error = (create.error ?? remove.error)?.message;

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Backups</h2>
        {enabled && (
          <button className="button" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Backing up…' : 'Back up now'}
          </button>
        )}
      </header>
      <p className="text-sm text-muted">
        {enabled
          ? `A backup holds your whole ledger and the statements you uploaded. One is taken automatically every day, and the newest ${list.data?.keep ?? 14} are kept. They are stored in the data folder, so copy them somewhere else too: a backup on the same disk does not survive the disk.`
          : 'Backups are turned off in demo mode, which holds only sample data.'}
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {enabled && list.isSuccess && items.length === 0 && (
        <p className="card p-6 text-sm text-muted">No backups yet. The first one is taken when the server starts.</p>
      )}
      {items.length > 0 && (
        <ul className="card divide-y divide-line">
          {items.map((backup) => (
            <li key={backup.name} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{fmtDateTime(backup.createdAt)}</p>
                <p className="text-xs text-muted">{size(backup.size)}{backup.encrypted ? ' · encrypted' : ''}</p>
              </div>
              <div className="flex gap-2">
                <a className="button" href={`/api/backups/${backup.name}`} download>
                  Download
                </a>
                <button
                  className="button-quiet"
                  disabled={remove.isPending}
                  onClick={() => window.confirm('Delete this backup?') && remove.mutate(backup.name)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {enabled && (
        <details className="text-sm text-muted">
          <summary className="cursor-pointer">How to restore</summary>
          <p className="mt-2">
            Stop the server, then run <code>pnpm restore path/to/backup.tar.gz</code>. What was there before is kept beside it with a
            <code> .before-restore</code> suffix. In Docker, run it inside the container with the data volume mounted.
          </p>
        </details>
      )}
    </section>
  );
}

function Export() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = new URLSearchParams({ ...(from && { from }), ...(to && { to }) }).toString();
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Export transactions</h2>
      <p className="text-sm text-muted">
        A CSV for a spreadsheet or your accountant. Each ledger line gets a row, so a transfer shows both of its sides and amounts add up.
        Leave the dates empty for everything.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">
          From
          <input className="field" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="label">
          To
          <input className="field" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <a className="button" href={`/api/export/transactions.csv${params ? `?${params}` : ''}`} download>
          Download CSV
        </a>
      </div>
    </section>
  );
}

function StartOver() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const reset = useMutation({
    mutationFn: () => api.resetAccount(confirm),
    onSuccess: async () => {
      setOpen(false);
      setConfirm('');
      await client.invalidateQueries();
    },
  });
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Start over</h2>
      <p className="text-sm text-muted">
        Deletes every account, transaction, import, rule, budget, investment, receipt and statement, and brings back the starter categories. Your login, agent tokens and settings (AI key, mailbox, folder) stay. Download a backup or an export first: this cannot be undone.
      </p>
      {!open ? (
        <div><button className="button-quiet" onClick={() => setOpen(true)}>Delete all my data</button></div>
      ) : (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); reset.mutate(); }}>
          <label className="label">Type DELETE EVERYTHING to confirm<input className="field" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          <button className="button" disabled={reset.isPending || confirm !== 'DELETE EVERYTHING'}>Delete all data</button>
          <button type="button" className="button-quiet" onClick={() => { setOpen(false); setConfirm(''); }}>Cancel</button>
        </form>
      )}
      {reset.error && <p className="text-sm text-danger">{reset.error.message}</p>}
      {reset.isSuccess && <p className="text-sm text-muted">Everything has been deleted.</p>}
    </section>
  );
}

export function BackupsPage() {
  return (
    <div className="flex flex-col gap-8">
      <SectionTabs section="settings" />
      <Backups />
      <SafetyChecks />
      <Export />
      <StartOver />
    </div>
  );
}
