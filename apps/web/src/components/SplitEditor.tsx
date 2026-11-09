import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Account, type Transaction } from '../api.ts';

type Part = { categoryId: string; amount: string };

// Spreads a purchase or receipt across several categories.
export function SplitEditor({ transaction, accounts, onDone }: { transaction: Transaction; accounts: Account[]; onDone: () => void }) {
  const client = useQueryClient();
  const money = transaction.postings.find((p) => p.accountType === 'asset' || p.accountType === 'liability')!;
  const total = Math.abs(money.amount);
  const kind = money.amount < 0 ? 'expense' : 'income';
  const categories = accounts.filter((a) => a.type === kind && !a.isArchived);
  const current = transaction.postings.filter((p) => p.accountType === kind);

  const [parts, setParts] = useState<Part[]>(
    current.length > 1 ? current.map((p) => ({ categoryId: String(p.accountId), amount: String(Math.abs(p.amount) / 100) })) : [{ categoryId: current[0] ? String(current[0].accountId) : '', amount: String(total / 100) }, { categoryId: '', amount: '' }],
  );
  const [problem, setProblem] = useState('');

  const parsed = parts.map((p) => {
    try {
      return p.amount.trim() ? parseAmount(p.amount) : 0;
    } catch {
      return NaN;
    }
  });
  const used = parsed.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  const left = total - used;

  const save = useMutation({
    mutationFn: () => {
      const clean = parts.flatMap((p, i) => (parsed[i] ? [{ categoryId: Number(p.categoryId), amount: parsed[i]! }] : []));
      return api.split(transaction.id, clean);
    },
    onSuccess: () => {
      client.invalidateQueries();
      onDone();
    },
  });

  function submit() {
    if (parsed.some((v) => Number.isNaN(v))) return setProblem('Check the amounts');
    if (parts.some((p, i) => parsed[i] && !p.categoryId)) return setProblem('Choose a category for each amount');
    if (left !== 0) return setProblem(`The parts must add up to ${formatAmount(total)}`);
    setProblem('');
    save.mutate();
  }

  const set = (i: number, change: Partial<Part>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...change } : p)));

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3 text-sm">
      <p className="text-muted">Split {formatAmount(total)} across categories. The account balance does not change.</p>
      <ul className="flex flex-col gap-2">
        {parts.map((part, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <select className="field" aria-label={`Category ${i + 1}`} value={part.categoryId} onChange={(e) => set(i, { categoryId: e.target.value })}>
              <option value="">Choose…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input className="field w-32" inputMode="decimal" aria-label={`Amount ${i + 1}`} value={part.amount} onChange={(e) => set(i, { amount: e.target.value })} />
            {parts.length > 2 && <button className="button-quiet" onClick={() => setParts(parts.filter((_, j) => j !== i))}>Remove</button>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button className="button-quiet" onClick={() => setParts([...parts, { categoryId: '', amount: left > 0 ? String(left / 100) : '' }])}>Add a part</button>
        <span className={left === 0 ? 'text-muted' : 'text-danger'}>{left === 0 ? 'Adds up.' : left > 0 ? `${formatAmount(left)} left to place` : `${formatAmount(-left)} too much`}</span>
      </div>
      <div className="flex gap-2">
        <button className="button" disabled={save.isPending} onClick={submit}>Save split</button>
        <button className="button-quiet" onClick={onDone}>Cancel</button>
      </div>
      {(problem || save.error) && <p className="text-danger">{problem || save.error?.message}</p>}
    </div>
  );
}
