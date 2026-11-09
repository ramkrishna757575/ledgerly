import { formatAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate, type RecurringPayment } from '../api.ts';

const EVERY = { weekly: 'Every week', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year' } as const;

function when(item: RecurringPayment) {
  if (item.status === 'lapsed') return `Last paid ${fmtDate(item.lastDate)}`;
  if (item.status === 'overdue') return `Expected ${fmtDate(item.nextDue)}, not seen yet`;
  if (item.dueIn === 0) return 'Due today';
  if (item.dueIn === 1) return 'Due tomorrow';
  return `Due ${fmtDate(item.nextDue)} (in ${item.dueIn} days)`;
}

function Row({ item, busy, onToggle }: { item: RecurringPayment; busy: boolean; onToggle: () => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium" title={item.label}>{item.label}</p>
        <p className="text-sm text-muted">
          {EVERY[item.cadence]} · {item.category} · seen {item.occurrences} times
        </p>
        <p className={`text-sm ${item.status === 'overdue' ? 'font-medium text-danger' : item.status === 'lapsed' ? 'text-muted' : ''}`}>{when(item)}</p>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-right text-sm font-medium tabular-nums">
          {item.varies && <span className="font-normal text-muted">about </span>}
          {formatAmount(item.amount)}
        </p>
        <button className="button-quiet" disabled={busy} onClick={onToggle}>{item.hidden ? 'Show again' : 'Hide'}</button>
      </div>
    </li>
  );
}

export function BillsPage() {
  const client = useQueryClient();
  const data = useQuery({ queryKey: ['recurring'], queryFn: api.recurring });
  const [showHidden, setShowHidden] = useState(false);
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['recurring'] }), client.invalidateQueries({ queryKey: ['insights'] })]);
  const toggle = useMutation({
    mutationFn: ({ key, hidden }: { key: string; hidden: boolean }) => (hidden ? api.showRecurring(key) : api.hideRecurring(key)),
    onSuccess: refresh,
  });

  const items = data.data?.items ?? [];
  const visible = items.filter((i) => !i.hidden);
  const hidden = items.filter((i) => i.hidden);
  const coming = visible.filter((i) => i.status !== 'lapsed');
  const lapsed = visible.filter((i) => i.status === 'lapsed');

  const list = (rows: RecurringPayment[]) => (
    <ul className="card divide-y divide-line">
      {rows.map((item) => (
        <Row key={item.key} item={item} busy={toggle.isPending} onToggle={() => toggle.mutate({ key: item.key, hidden: item.hidden })} />
      ))}
    </ul>
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Bills</h1>
      <p className="text-sm text-muted">
        Payments that come back on a rhythm, found from your own transactions: the same payee at about the same interval, at least three times. Hide anything that is not really a bill.
      </p>

      {data.data && coming.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="card p-4">
            <p className="text-xs text-muted">Committed each month</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatAmount(data.data.monthly)}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-muted">Due in the next {data.data.dueSoon.days} days</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatAmount(data.data.dueSoon.amount)}</p>
            <p className="text-xs text-muted">{data.data.dueSoon.count} {data.data.dueSoon.count === 1 ? 'payment' : 'payments'}</p>
          </div>
        </div>
      )}

      {toggle.error && <p className="text-sm text-danger">{toggle.error.message}</p>}

      {data.isSuccess && visible.length === 0 && (
        <p className="card p-6 text-sm text-muted">
          No recurring payments found yet. They appear once a payee has been paid three times at a steady interval, so import a few months of statements.
        </p>
      )}

      {coming.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">Coming up</h2>
          {list(coming)}
        </section>
      )}

      {lapsed.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">Not seen lately</h2>
          <p className="text-sm text-muted">These stopped arriving on schedule. If you cancelled them, good. If not, check why.</p>
          {list(lapsed)}
        </section>
      )}

      {hidden.length > 0 && (
        <section className="flex flex-col gap-3">
          <button className="button-quiet self-start" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? 'Hide' : 'Show'} {hidden.length} hidden
          </button>
          {showHidden && list(hidden)}
        </section>
      )}
    </div>
  );
}
