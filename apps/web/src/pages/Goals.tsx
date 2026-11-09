import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, fmtDate, type Goal } from '../api.ts';

const rupees = (paise: number) => formatAmount(paise).replace(/\.00$/, '');
const monthName = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

function GoalForm({ initial, onSave, onCancel, busy, error }: { initial?: Goal; onSave: (input: unknown) => void; onCancel?: () => void; busy: boolean; error?: string }) {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [name, setName] = useState(initial?.name ?? '');
  const [target, setTarget] = useState(initial ? String(initial.targetAmount / 100) : '');
  const [date, setDate] = useState(initial?.targetDate ?? '');
  const [hand, setHand] = useState(initial ? String(initial.savedByHand / 100) : '');
  const [linked, setLinked] = useState<number[]>(initial?.accountIds ?? []);
  const [problem, setProblem] = useState('');
  const choices = (accounts.data ?? []).filter((a) => a.type === 'asset' && !a.isArchived);

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      onSave({ name, targetAmount: parseAmount(target), targetDate: date || null, accountIds: linked, savedByHand: hand.trim() ? parseAmount(hand) : 0 });
      setProblem('');
    } catch {
      setProblem('Check the amounts');
    }
  }

  return (
    <form className="card flex flex-col gap-3 p-4" onSubmit={submit}>
      <h2 className="font-medium">{initial ? 'Edit goal' : 'Add a goal'}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">Goal<input className="field" value={name} placeholder="Holiday, car, emergency fund" onChange={(e) => setName(e.target.value)} /></label>
        <label className="label">Target (₹)<input className="field w-36" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
        <label className="label">By (optional)<input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="label">Saved by hand (₹)<input className="field w-36" inputMode="decimal" value={hand} onChange={(e) => setHand(e.target.value)} /></label>
      </div>
      {choices.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm text-muted">Count the balance of these accounts toward it</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {choices.map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={linked.includes(a.id)} onChange={(e) => setLinked(e.target.checked ? [...linked, a.id] : linked.filter((x) => x !== a.id))} />
                {a.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex gap-2">
        <button className="button" disabled={busy || !name.trim()}>{initial ? 'Save' : 'Add'}</button>
        {onCancel && <button type="button" className="button-quiet" onClick={onCancel}>Cancel</button>}
      </div>
      {(problem || error) && <p className="text-sm text-danger">{problem || error}</p>}
    </form>
  );
}

export function GoalsPage() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['goals'], queryFn: api.goals });
  const [editing, setEditing] = useState<number | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['goals'] });
  const create = useMutation({ mutationFn: api.createGoal, onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, input }: { id: number; input: unknown }) => api.updateGoal(id, input), onSuccess: () => { setEditing(null); return refresh(); } });
  const remove = useMutation({ mutationFn: api.deleteGoal, onSuccess: refresh });
  const goals = list.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Goals</h1>
      <p className="text-sm text-muted">Things you are saving for. Point a goal at the accounts you keep its money in, or add what you have put aside by hand. Ledgerly shows what to set aside each month and, from what you usually save, when you would get there.</p>
      {remove.error && <p className="text-sm text-danger">{remove.error.message}</p>}
      {list.isSuccess && goals.length === 0 && <p className="card p-6 text-sm text-muted">No goals yet.</p>}
      <ul className="flex flex-col gap-3">
        {goals.map((g) =>
          editing === g.id ? (
            <li key={g.id}><GoalForm initial={g} busy={update.isPending} error={update.error?.message} onCancel={() => setEditing(null)} onSave={(input) => update.mutate({ id: g.id, input })} /></li>
          ) : (
            <li key={g.id} className="card flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{g.name}{g.done && <span className="ml-2 text-sm font-normal text-muted">Reached</span>}</p>
                <p className="text-sm"><span className="font-medium tabular-nums">{rupees(g.current)}</span> <span className="text-muted">of {rupees(g.targetAmount)}{g.targetDate && ` by ${fmtDate(g.targetDate)}`}</span></p>
              </div>
              <div className="h-2 rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(g.share * 100)} aria-label={`${g.name} progress`}>
                <div className="h-full rounded-full" style={{ width: `${g.share * 100}%`, background: 'var(--color-accent)' }} />
              </div>
              <p className="text-sm text-muted">
                {g.done ? 'You have what you need.' : (
                  <>
                    {rupees(g.remaining)} to go
                    {g.neededPerMonth !== null && ` · put aside ${rupees(g.neededPerMonth)} a month to meet the date`}
                    {g.reachedBy && ` · at your usual saving of ${rupees(g.usualSaving!)} a month, around ${monthName(g.reachedBy)}`}
                  </>
                )}
              </p>
              <div className="flex gap-2">
                <button className="button-quiet" onClick={() => setEditing(g.id)}>Edit</button>
                <button className="button-quiet" disabled={remove.isPending} onClick={() => window.confirm(`Delete ${g.name}?`) && remove.mutate(g.id)}>Delete</button>
              </div>
            </li>
          ),
        )}
      </ul>
      <GoalForm busy={create.isPending} error={create.error?.message} onSave={(input) => create.mutate(input)} />
    </div>
  );
}
