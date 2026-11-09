import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, isMoneyAccount, today, type Account } from '../api.ts';
import type { AddAccountSearch } from '../search.ts';
import { owedLabel } from '../plain.ts';

const KINDS = [
  { value: 'bank', label: 'Bank account', type: 'asset' },
  { value: 'cash', label: 'Cash', type: 'asset' },
  { value: 'wallet', label: 'Wallet', type: 'asset' },
  { value: 'investment', label: 'Investment', type: 'asset' },
  { value: 'credit_card', label: 'Credit card', type: 'liability' },
  { value: 'loan', label: 'Loan', type: 'liability' },
] as const;

function AccountForm({
  initial,
  onDone,
}: {
  initial: AddAccountSearch;
  onDone: (created: boolean) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(initial.name ?? '');
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>(initial.add ?? 'bank');
  const [institution, setInstitution] = useState(initial.institution ?? '');
  const [last4, setLast4] = useState(initial.last4 ?? '');
  const [opening, setOpening] = useState('');
  const [openingDate, setOpeningDate] = useState(today());
  const [formError, setFormError] = useState('');

  const selected = KINDS.find((k) => k.value === kind)!;
  const create = useMutation({
    mutationFn: api.createAccount,
    onSuccess: () => {
      client.invalidateQueries();
      onDone(true);
    },
    onError: (error) => setFormError(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    let openingBalance;
    try {
      openingBalance = opening ? parseAmount(opening) : undefined;
    } catch {
      setFormError('Enter the opening balance as a number, like 1,25,000.50');
      return;
    }
    create.mutate({
      name,
      type: selected.type,
      subtype: kind,
      institution: institution || undefined,
      numberLast4: last4 || undefined,
      openingBalance,
      openingDate: openingBalance ? openingDate : undefined,
    });
  }

  return (
    <form onSubmit={submit} className="card grid gap-4 p-4 sm:grid-cols-2">
      <label className="label">
        Name
        <input className="field" required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="label">
        Type
        <select
          className="field"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="label">
        Bank or provider (optional)
        <input
          className="field"
          value={institution}
          onChange={(e) => setInstitution(e.target.value)}
        />
      </label>
      <label className="label">
        Last 4 digits (optional)
        <input
          className="field"
          inputMode="numeric"
          maxLength={4}
          pattern="\d{4}"
          value={last4}
          onChange={(e) => setLast4(e.target.value)}
        />
      </label>
      <label className="label">
        {selected.type === 'liability' ? 'Amount owed' : 'Opening balance'} (optional)
        <input
          className="field"
          inputMode="decimal"
          value={opening}
          onChange={(e) => setOpening(e.target.value)}
        />
      </label>
      <label className="label">
        As of
        <input
          className="field"
          type="date"
          value={openingDate}
          onChange={(e) => setOpeningDate(e.target.value)}
        />
      </label>
      {formError && <p className="text-sm text-danger sm:col-span-2">{formError}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <button className="button" disabled={create.isPending}>
          Add
        </button>
        <button type="button" className="button-quiet" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AccountRow({ account }: { account: Account }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [institution, setInstitution] = useState(account.institution ?? '');
  const [last4, setLast4] = useState(account.numberLast4 ?? '');
  const [error, setError] = useState('');

  const succeeded = () => {
    setError('');
    client.invalidateQueries();
  };
  const failed = (e: Error) => setError(e.message);
  const save = useMutation({
    mutationFn: () =>
      api.updateAccount(account.id, {
        name,
        institution: institution.trim() || null,
        numberLast4: last4.trim() || null,
      }),
    onSuccess: () => {
      setEditing(false);
      succeeded();
    },
    onError: failed,
  });
  const archive = useMutation({ mutationFn: () => api.archiveAccount(account.id), onSuccess: succeeded, onError: failed });
  const restore = useMutation({ mutationFn: () => api.unarchiveAccount(account.id), onSuccess: succeeded, onError: failed });
  const remove = useMutation({ mutationFn: () => api.deleteAccount(account.id), onSuccess: succeeded, onError: failed });
  const busy = save.isPending || archive.isPending || restore.isPending || remove.isPending;

  function cancel() {
    setEditing(false);
    setError('');
    setName(account.name);
    setInstitution(account.institution ?? '');
    setLast4(account.numberLast4 ?? '');
  }

  if (editing) {
    return (
      <li className="p-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            save.mutate();
          }}
          className="grid gap-3 sm:grid-cols-3"
        >
          <label className="label">
            Name
            <input className="field" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="label">
            Bank or provider
            <input className="field" value={institution} onChange={(e) => setInstitution(e.target.value)} />
          </label>
          <label className="label">
            Last 4 digits
            <input
              className="field"
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
              value={last4}
              onChange={(e) => setLast4(e.target.value)}
            />
          </label>
          {error && <p className="text-sm text-danger sm:col-span-3">{error}</p>}
          <div className="flex gap-2 sm:col-span-3">
            <button className="button" disabled={busy}>
              Save
            </button>
            <button type="button" className="button-quiet" onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{account.name}</p>
        <p className="truncate text-sm text-muted">
          {[account.institution, account.numberLast4 && `•••• ${account.numberLast4}`].filter(Boolean).join(' ')}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-2 text-sm">
          {formatAmount(owedLabel(account.type, account.balance)?.amount ?? account.balance, account.currency)}
          {owedLabel(account.type, account.balance) && <span className="ml-1 text-xs text-muted">{owedLabel(account.type, account.balance)!.word}</span>}
        </span>
        <button className="button-quiet" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        {account.isArchived ? (
          <button className="button-quiet" disabled={busy} onClick={() => restore.mutate()}>
            Restore
          </button>
        ) : (
          <button
            className="button-quiet"
            disabled={busy || account.balance !== 0}
            title={account.balance !== 0 ? 'Settle the balance to zero before archiving' : 'Hide this account'}
            onClick={() => archive.mutate()}
          >
            Archive
          </button>
        )}
        <button
          className="button-quiet"
          disabled={busy}
          onClick={() => window.confirm(`Delete "${account.name}"? This can't be undone.`) && remove.mutate()}
        >
          Delete
        </button>
      </div>
      {error && <p className="text-sm text-danger sm:basis-full">{error}</p>}
    </li>
  );
}

function Group({ title, items }: { title: string; items: Account[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 font-medium">{title}</h2>
      <ul className="card divide-y divide-line">
        {items.map((account) => (
          <AccountRow key={account.id} account={account} />
        ))}
      </ul>
    </section>
  );
}

export function AccountsPage() {
  const search = useSearch({ strict: false }) as AddAccountSearch;
  const navigate = useNavigate();
  const [adding, setAdding] = useState(Boolean(search.add));
  const [showArchived, setShowArchived] = useState(false);
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const money = accounts.data?.filter(isMoneyAccount) ?? [];
  const visible = money.filter((a) => !a.isArchived);
  const archived = money.filter((a) => a.isArchived);

  // Opened from an import: go back to it once the account exists.
  function finish(created: boolean) {
    setAdding(false);
    if (created && search.back) navigate({ to: '/import', search: { open: search.back } });
    else if (search.add) navigate({ to: '/accounts', search: {}, replace: true });
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Accounts and cards</h1>
        {!adding && (
          <button className="button" onClick={() => setAdding(true)}>
            Add account or card
          </button>
        )}
      </header>
      {adding && <AccountForm initial={search} onDone={finish} />}
      {accounts.isError && <p className="text-sm text-danger">{accounts.error.message}</p>}
      {accounts.isSuccess && visible.length === 0 && !adding && (
        <p className="card p-6 text-sm text-muted">
          Add your bank accounts, cards and loans to see them here.
        </p>
      )}
      <Group title="What you have" items={visible.filter((a) => a.type === 'asset')} />
      <Group title="What you owe" items={visible.filter((a) => a.type === 'liability')} />
      {archived.length > 0 && (
        <div className="flex flex-col gap-3">
          <button
            className="button-quiet self-start"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </button>
          {showArchived && <Group title="Archived" items={archived} />}
        </div>
      )}
    </div>
  );
}
