import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, isMoneyAccount, today } from '../api.ts';

const KEY = 'ledgerly-quick-account';
const remembered = () => {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
};

// For logging a purchase in a few seconds, such as cash spent, from a phone.
export function QuickAddPage() {
  const client = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [categoryId, setCategoryId] = useState(0);
  const [accountId, setAccountId] = useState(remembered());
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');

  const money = (accounts.data ?? []).filter((a) => isMoneyAccount(a) && !a.isArchived);
  const categories = (accounts.data ?? []).filter((a) => a.type === kind && !a.isArchived);
  const account = money.find((a) => a.id === accountId) ?? money.find((a) => a.subtype === 'cash') ?? money[0];
  const category = categories.find((c) => c.id === categoryId) ?? categories.find((c) => c.name === 'Uncategorized' || c.name === 'Other Income') ?? categories[0];

  const save = useMutation({
    mutationFn: api.createSimpleTransaction,
    onSuccess: () => {
      client.invalidateQueries();
      setMessage(`Saved ${formatAmount(parseAmount(amount))} ${kind === 'expense' ? 'to' : 'as'} ${category?.name}`);
      setAmount('');
      setNote('');
    },
    onError: (error) => setProblem(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    setProblem('');
    let minor: number;
    try {
      minor = parseAmount(amount);
      if (minor <= 0) throw new Error();
    } catch {
      return setProblem('Enter an amount like 250');
    }
    if (!account || !category) return setProblem('Add an account first');
    try {
      localStorage.setItem(KEY, String(account.id));
    } catch {
      // Not remembering the account is fine.
    }
    save.mutate({ kind, date: today(), description: note.trim() || category.name, accountId: account.id, counterAccountId: category.id, amount: minor });
  }

  return (
    <form className="mx-auto flex w-full max-w-sm flex-col gap-4" onSubmit={submit}>
      <h1 className="text-2xl font-semibold">Quick add</h1>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Kind">
        {(['expense', 'income'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'button' : 'button-quiet'} onClick={() => { setKind(k); setCategoryId(0); }}>
            {k === 'expense' ? 'Spent' : 'Received'}
          </button>
        ))}
      </div>
      <input
        className="field text-center text-3xl font-semibold"
        inputMode="decimal"
        aria-label="Amount"
        placeholder="₹ 0"
        autoFocus
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label className="label">
        {kind === 'expense' ? 'On' : 'From'}
        <select className="field" value={category?.id ?? 0} onChange={(e) => setCategoryId(Number(e.target.value))}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="label">
        {kind === 'expense' ? 'Paid from' : 'Into'}
        <select className="field" value={account?.id ?? 0} onChange={(e) => setAccountId(Number(e.target.value))}>
          {money.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label className="label">
        Note (optional)
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button className="button py-3 text-base" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      {message && <p className="text-center text-sm" aria-live="polite">{message}</p>}
      {problem && <p className="text-center text-sm text-danger">{problem}</p>}
    </form>
  );
}
