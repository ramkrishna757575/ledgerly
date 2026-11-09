import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { formatAmount } from '@ledgerly/core/money';
import { api, type ReceiptReading } from '../api.ts';

const size = (bytes: number) => (bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`);

function ReadingResult({ reading }: { reading: ReceiptReading }) {
  const { read, comparison: c } = reading;
  const tick = (ok: boolean | null, label: string) => (ok === null ? `${label}: not readable` : ok ? `${label}: matches` : `${label}: differs`);
  return (
    <div className="mt-1 w-full rounded-md border border-line p-2 text-xs">
      <p>
        The receipt says {read.total === null ? 'an amount it could not read' : formatAmount(Math.round(read.total * 100))}
        {read.date && ` on ${read.date}`}{read.vendor && ` from ${read.vendor}`}. This transaction is {formatAmount(reading.transaction.amount)} on {reading.transaction.date}.
      </p>
      <p className={c.amount === false ? 'text-danger' : 'text-muted'}>{[tick(c.amount, 'Amount'), tick(c.date, 'Date'), tick(c.vendor, 'Shop')].join(' · ')}</p>
      <p className="text-muted">A reading by a model can be wrong; nothing was changed.</p>
    </div>
  );
}

// Bills, invoices and receipts kept with a transaction, for warranties, tax
// proof and reimbursements.
export function Receipts({ transactionId }: { transactionId: number }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['attachments', transactionId], queryFn: () => api.attachments(transactionId) });
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['attachments', transactionId] }), client.invalidateQueries({ queryKey: ['transactions'] })]);
  const add = useMutation({
    mutationFn: (file: File) => api.attach(transactionId, file),
    onSuccess: () => {
      if (input.current) input.current.value = '';
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: api.deleteAttachment, onSuccess: refresh });
  const ai = useQuery({ queryKey: ['ai-status'], queryFn: api.aiStatus });
  const [readings, setReadings] = useState<Record<number, ReceiptReading>>({});
  const read = useMutation({ mutationFn: api.readReceipt, onSuccess: (result, id) => setReadings((all) => ({ ...all, [id]: result })) });
  const error = (add.error ?? remove.error ?? read.error)?.message;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
      {(list.data ?? []).length === 0 && list.isSuccess && <p className="text-muted">No receipts yet.</p>}
      <ul className="flex flex-col gap-1">
        {list.data?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
            <a className="min-w-0 truncate underline" href={a.url} target="_blank" rel="noreferrer" title={a.filename}>
              {a.filename} <span className="text-muted no-underline">({size(a.size)})</span>
            </a>
            <span className="flex gap-2">
              {ai.data?.configured && a.mimeType.startsWith('image/') && (
                <button className="button-quiet" disabled={read.isPending} title={`Sends this picture to ${ai.data.destination?.host}${ai.data.destination?.local ? ' (this machine)' : ''}`} onClick={() => read.mutate(a.id)}>
                  {read.isPending && read.variables === a.id ? 'Reading…' : 'Read with AI'}
                </button>
              )}
              <button className="button-quiet" disabled={remove.isPending} onClick={() => window.confirm(`Remove ${a.filename}?`) && remove.mutate(a.id)}>Remove</button>
            </span>
            {readings[a.id] && <ReadingResult reading={readings[a.id]!} />}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          aria-label="Attach a receipt"
          className="text-xs text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-ink"
          onChange={(e) => e.target.files?.[0] && add.mutate(e.target.files[0])}
        />
        {add.isPending && <span className="text-muted">Uploading…</span>}
      </div>
      <p className="text-xs text-muted">PDF, PNG, JPEG or WebP, up to 10 MB. Stored on this machine and included in backups.</p>
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}
