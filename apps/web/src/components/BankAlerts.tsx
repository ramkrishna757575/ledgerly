import { formatAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate, isMoneyAccount } from '../api.ts';

// What the bank announced by email, before the statement is out.
export function BankAlerts() {
  const client = useQueryClient();
  const alerts = useQuery({ queryKey: ['bank-alerts'], queryFn: api.bankAlerts, refetchInterval: 60_000 });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const mail = useQuery({ queryKey: ['mail'], queryFn: api.mail });
  const [chosen, setChosen] = useState<Record<number, number>>({});
  const refresh = () => client.invalidateQueries();
  const add = useMutation({ mutationFn: ({ id, accountId }: { id: number; accountId?: number }) => api.addBankAlert(id, accountId), onSuccess: refresh });
  const dismiss = useMutation({ mutationFn: api.dismissBankAlert, onSuccess: refresh });
  const auto = useMutation({ mutationFn: api.setBankAlertAuto, onSuccess: refresh });
  const items = (alerts.data?.items ?? []).filter((a) => a.status === 'new');
  if (!alerts.data || (items.length === 0 && !alerts.data.auto && !mail.data?.enabled)) return null;
  const money = (accounts.data ?? []).filter(isMoneyAccount);
  return (
    <section className="card flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">Alerts from your bank</h2>
          <p className="mt-1 text-sm text-muted">
            "You spent..." and "was debited" emails, read as they arrive. Add one to your books now, and the statement later takes it over instead of adding it a second time. These are read from the email's wording, so check them.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={alerts.data.auto} disabled={auto.isPending} onChange={(e) => auto.mutate(e.target.checked)} />
          Add them automatically
        </label>
      </header>
      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing waiting.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{a.description}</p>
                <p className="text-xs text-muted">{fmtDate(a.date)} · {a.accountName ?? `ending ${a.last4}, account not matched`} · {formatAmount(Math.abs(a.amount))} {a.amount < 0 ? 'out' : 'in'}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {a.accountId === null && (
                  <select className="field py-1" aria-label="Account" value={chosen[a.id] ?? ''} onChange={(e) => setChosen({ ...chosen, [a.id]: Number(e.target.value) })}>
                    <option value="">Choose account</option>
                    {money.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                )}
                <button className="button" disabled={add.isPending || (a.accountId === null && !chosen[a.id])} onClick={() => add.mutate({ id: a.id, accountId: a.accountId === null ? chosen[a.id] : undefined })}>Add</button>
                <button className="button-quiet" disabled={dismiss.isPending} onClick={() => dismiss.mutate(a.id)}>Dismiss</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(add.error || dismiss.error) && <p className="text-sm text-danger">{(add.error ?? dismiss.error)!.message}</p>}
    </section>
  );
}
