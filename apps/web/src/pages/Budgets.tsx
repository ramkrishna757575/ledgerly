import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type BudgetItem } from '../api.ts';

const STATE_LABEL = { ok: 'On track', watch: 'Close to the limit', over: 'Over' } as const;
const STATE_COLOR = { ok: 'var(--color-accent)', watch: 'var(--viz-4)', over: 'var(--color-danger)' } as const;

const thisMonth = () => new Date().toISOString().slice(0, 7);
function shift(month: string, by: number) {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const rupeesOnly = (paise: number) => formatAmount(paise).replace(/\.00$/, '');

function Bar({ item }: { item: BudgetItem }) {
  return (
    <div
      className="h-2 overflow-hidden rounded-full bg-line"
      role="progressbar"
      aria-label={`${item.name} budget used`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(item.share * 100)}
    >
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, item.share * 100)}%`, background: STATE_COLOR[item.state] }} />
    </div>
  );
}

function BudgetRow({ item, onSave, onRemove, busy }: { item: BudgetItem; onSave: (amount: number) => void; onRemove: () => void; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  function save(event: FormEvent) {
    event.preventDefault();
    try {
      const amount = parseAmount(value);
      if (amount <= 0) throw new Error();
      onSave(amount);
      setEditing(false);
      setError('');
    } catch {
      setError('Enter an amount like 5000');
    }
  }

  return (
    <li className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{item.name}</p>
        <p className="text-sm">
          <span className="font-medium">{formatAmount(item.spent)}</span> <span className="text-muted">of {rupeesOnly(item.amount)}</span>
        </p>
      </div>
      <Bar item={item} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="text-muted">
          <span className="font-medium text-ink">{STATE_LABEL[item.state]}</span>
          {' · '}
          {item.remaining >= 0 ? `${formatAmount(item.remaining)} left` : `${formatAmount(-item.remaining)} over`}
        </p>
        {editing ? (
          <form className="flex items-center gap-2" onSubmit={save}>
            <input className="field w-28" inputMode="decimal" aria-label="New monthly amount" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
            <button className="button" disabled={busy}>Save</button>
            <button type="button" className="button-quiet" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : (
          <div className="flex gap-2">
            <button className="button-quiet" onClick={() => { setValue(String(item.amount / 100)); setEditing(true); }}>Change</button>
            <button className="button-quiet" disabled={busy} onClick={() => window.confirm(`Remove the ${item.name} budget?`) && onRemove()}>Remove</button>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </li>
  );
}

function AddBudget({ taken, prefill, onAdd, busy }: { taken: Set<number>; prefill: { categoryId: number; amount: number } | null; onAdd: (categoryId: number, amount: number) => void; busy: boolean }) {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [seen, setSeen] = useState(prefill);
  if (prefill !== seen) {
    setSeen(prefill);
    if (prefill) {
      setCategoryId(String(prefill.categoryId));
      setAmount(String(prefill.amount / 100));
    }
  }
  const choices = (accounts.data ?? []).filter((a) => a.type === 'expense' && a.name !== 'Uncategorized' && !a.isArchived && !taken.has(a.id));

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const minor = parseAmount(amount);
      if (!categoryId) return setError('Choose a category');
      if (minor <= 0) throw new Error();
      onAdd(Number(categoryId), minor);
      setCategoryId('');
      setAmount('');
      setError('');
    } catch {
      setError('Enter an amount like 5000');
    }
  }

  return (
    <form className="card flex flex-col gap-3 p-4" onSubmit={submit}>
      <h2 className="font-medium">Add a budget</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">
          Category
          <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <label className="label">
          Per month (₹)
          <input className="field w-32" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button className="button" disabled={busy}>Add</button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}

export function BudgetsPage() {
  const client = useQueryClient();
  const [month, setMonth] = useState(thisMonth());
  const [prefill, setPrefill] = useState<{ categoryId: number; amount: number } | null>(null);
  const status = useQuery({ queryKey: ['budgets', month], queryFn: () => api.budgets(month) });
  const suggestions = useQuery({ queryKey: ['budgets', 'suggestions'], queryFn: api.budgetSuggestions });
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['budgets'] }), client.invalidateQueries({ queryKey: ['insights'] })]);

  const save = useMutation({ mutationFn: ({ id, amount }: { id: number; amount: number }) => api.setBudget(id, amount), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteBudget(id), onSuccess: refresh });
  const useAll = useMutation({
    mutationFn: async () => { for (const s of suggestions.data ?? []) await api.setBudget(s.categoryId, s.amount); },
    onSuccess: refresh,
  });

  const data = status.data;
  const current = month === thisMonth();
  const items = data?.items ?? [];
  const busy = save.isPending || remove.isPending || useAll.isPending;
  const error = (save.error ?? remove.error ?? useAll.error)?.message;
  const left = data ? data.totals.budgeted - data.totals.spent : 0;
  const picks = suggestions.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Budgets</h1>
        <div className="flex items-center gap-2">
          <button className="button-quiet" aria-label="Previous month" onClick={() => setMonth(shift(month, -1))}>←</button>
          <span className="min-w-36 text-center text-sm font-medium">{monthLabel(month)}</span>
          <button className="button-quiet" aria-label="Next month" disabled={current} onClick={() => setMonth(shift(month, 1))}>→</button>
        </div>
      </header>

      {error && <p className="text-sm text-danger">{error}</p>}

      {data && items.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            ['Budgeted', formatAmount(data.totals.budgeted)],
            ['Spent', formatAmount(data.totals.spent)],
            [left >= 0 ? 'Left' : 'Over', formatAmount(Math.abs(left))],
          ].map(([label, value]) => (
            <div key={label} className="card p-4">
              <p className="text-xs text-muted">{label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
      )}

      {data && items.length === 0 ? (
        <p className="card p-6 text-sm text-muted">
          No budgets yet. A budget is a monthly limit for one spending category. Add one below, or start from what you usually spend.
        </p>
      ) : (
        <ul className="card divide-y divide-line">
          {items.map((item) => (
            <BudgetRow key={item.categoryId} item={item} busy={busy} onSave={(amount) => save.mutate({ id: item.categoryId, amount })} onRemove={() => remove.mutate(item.categoryId)} />
          ))}
        </ul>
      )}

      {picks.length > 0 && (
        <section className="flex flex-col gap-3">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">Suggested from your last three months</h2>
            {picks.length > 1 && <button className="button" disabled={busy} onClick={() => useAll.mutate()}>Add all</button>}
          </header>
          <ul className="card divide-y divide-line">
            {picks.map((s) => (
              <li key={s.categoryId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <p className="text-sm"><span className="font-medium">{s.name}</span> <span className="text-muted">averages {rupeesOnly(s.average)} a month</span></p>
                <button className="button-quiet" disabled={busy} onClick={() => save.mutate({ id: s.categoryId, amount: s.amount })}>Budget {rupeesOnly(s.amount)}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && data.unbudgeted.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">Spending without a budget in {monthLabel(month)}</h2>
          <ul className="card divide-y divide-line">
            {data.unbudgeted.map((u) => (
              <li key={u.categoryId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <p className="text-sm"><span className="font-medium">{u.name}</span> <span className="text-muted">{formatAmount(u.spent)}</span></p>
                <button className="button-quiet" onClick={() => setPrefill({ categoryId: u.categoryId, amount: Math.ceil(u.spent / 10_000) * 10_000 })}>Set a budget</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AddBudget taken={new Set(items.map((i) => i.categoryId))} prefill={prefill} busy={busy} onAdd={(id, amount) => save.mutate({ id, amount })} />
    </div>
  );
}
