import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Hint } from '../components/Hint.tsx';
import { plainKind } from '../plain.ts';
import { useState, type FormEvent } from 'react';
import { api, fmtDate, isMoneyAccount, today, type Account, type Transaction } from '../api.ts';
import { SplitEditor } from '../components/SplitEditor.tsx';
import { Receipts } from '../components/Receipts.tsx';
import { CategorySelect } from '../components/CategorySelect.tsx';
import type { TransactionsSearch } from '../search.ts';

const PAGE_SIZE = 50;
type Kind = 'expense' | 'income' | 'transfer';

function TransactionForm({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const client = useQueryClient();
  const active = accounts.filter((a) => !a.isArchived);
  const moneyAccounts = active.filter(isMoneyAccount);

  const [kind, setKind] = useState<Kind>('expense');
  const [accountId, setAccountId] = useState(moneyAccounts[0]?.id ?? 0);
  const [counterId, setCounterId] = useState(0);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState('');

  const counters =
    kind === 'transfer'
      ? moneyAccounts.filter((a) => a.id !== accountId)
      : active.filter((a) => a.type === kind);

  const create = useMutation({
    mutationFn: api.createSimpleTransaction,
    onSuccess: () => {
      client.invalidateQueries();
      onDone();
    },
    onError: (error) => setFormError(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    let minor;
    try {
      minor = parseAmount(amount);
    } catch {
      setFormError('Enter the amount as a number, like 1,250.50');
      return;
    }
    if (!counterId) {
      setFormError(kind === 'transfer' ? 'Choose where the money went' : 'Choose a category');
      return;
    }
    create.mutate({
      kind,
      accountId,
      counterAccountId: counterId,
      amount: minor,
      date,
      description,
    });
  }

  return (
    <form onSubmit={submit} className="card grid gap-4 p-4 sm:grid-cols-2">
      <label className="label">
        Type
        <select
          className="field"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as Kind);
            setCounterId(0);
          }}
        >
          <option value="expense">Expense</option>
          <option value="income">Income</option>
          <option value="transfer">Transfer</option>
        </select>
      </label>
      <label className="label">
        {kind === 'transfer' ? 'From' : 'Account'}
        <select
          className="field"
          value={accountId}
          onChange={(e) => {
            setAccountId(Number(e.target.value));
            setCounterId(0);
          }}
        >
          {moneyAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="label">
        {kind === 'transfer' ? 'To' : 'Category'}
        <select
          className="field"
          value={counterId}
          onChange={(e) => setCounterId(Number(e.target.value))}
        >
          <option value={0}>Choose…</option>
          {counters.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="label">
        Amount
        <input
          className="field"
          inputMode="decimal"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="label">
        Date
        <input
          className="field"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <label className="label">
        Description
        <input
          className="field"
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {formError && <p className="text-sm text-danger sm:col-span-2">{formError}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <button className="button" disabled={create.isPending}>
          Add transaction
        </button>
        <button type="button" className="button-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function summarize(transaction: Transaction, filterAccountId: number) {
  const money = transaction.postings.filter((p) => isMoneyAccount({ type: p.accountType }));
  const others = transaction.postings.filter((p) => !isMoneyAccount({ type: p.accountType }));
  const isTransfer = others.length === 0;

  const focus = money.find((p) => p.accountId === filterAccountId);
  const amount = focus ? focus.amount : money.reduce((sum, p) => sum + p.amount, 0);
  const shown = isTransfer && !focus ? Math.abs(money[0]?.amount ?? 0) : amount;

  const route = isTransfer
    ? [...money]
        .sort((a, b) => a.amount - b.amount)
        .map((p) => p.accountName)
        .join(' → ')
    : `${money.map((p) => p.accountName).join(', ')} · ${others.map((p) => p.accountName).join(', ')}`;

  return { shown, route };
}

export function TransactionsPage() {
  const [receiptsFor, setReceiptsFor] = useState<number | null>(null);
  const [splitFor, setSplitFor] = useState<number | null>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const { from, to, account } = useSearch({ strict: false }) as TransactionsSearch;
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [accountId, setAccountId] = useState(account ?? 0);
  const [page, setPage] = useState(0);
  const [autoNotice, setAutoNotice] = useState('');
  const [offer, setOffer] = useState<{ id: number; categoryId: number; name: string; payee: string; count: number } | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const accountsById = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  const params: Record<string, string> = {
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
    ...(search.trim() && { search: search.trim() }),
    ...(accountId && { accountId: String(accountId) }),
    ...(from && { from }),
    ...(to && { to }),
  };
  const list = useQuery({
    queryKey: ['transactions', params],
    queryFn: () => api.transactions(params),
  });

  const remove = useMutation({
    mutationFn: api.deleteTransaction,
    onSuccess: () => client.invalidateQueries(),
  });

  const recategorize = useMutation({
    mutationFn: ({ id, categoryId }: { id: number; categoryId: number }) => api.setCategory(id, categoryId),
    onSuccess: (result, { id, categoryId }) => {
      client.invalidateQueries();
      const made = result.autoRules?.created ?? 0;
      setAutoNotice(made > 0 ? `Ledgerly created ${made === 1 ? 'a rule' : `${made} rules`} automatically from your choices. See Rules.` : '');
      setOffer(
        result.similar > 0
          ? {
              id,
              categoryId,
              name: accounts.data?.find((a) => a.id === categoryId)?.name ?? 'this category',
              payee: result.transaction.payee ?? result.transaction.description,
              count: result.similar,
            }
          : null,
      );
    },
  });
  const applySimilar = useMutation({
    mutationFn: (choice: { id: number; categoryId: number }) => api.applySimilar(choice.id, choice.categoryId),
    onSuccess: () => {
      setOffer(null);
      client.invalidateQueries();
    },
  });

  const moneyAccounts = accounts.data?.filter(isMoneyAccount) ?? [];
  const categories = accounts.data?.filter((a) => a.type === 'expense' || a.type === 'income') ?? [];
  const canAdd = moneyAccounts.some((a) => !a.isArchived);
  const total = list.data?.total ?? 0;
  const pageCount = Math.ceil(total / PAGE_SIZE);

  function confirmDelete(transaction: Transaction) {
    if (window.confirm(`Delete "${transaction.description}"? This can't be undone.`)) {
      remove.mutate(transaction.id);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Transactions</h1>
        {!adding && canAdd && (
          <button className="button" onClick={() => setAdding(true)}>
            Add transaction
          </button>
        )}
      </header>

      <Hint title="Why are card payments and SIPs not counted as spending?">
        <p>Spending is counted once, when you buy something. Using your credit card for a ₹2,000 order is spending of ₹2,000: you now owe the card that much.</p>
        <p>Paying the card bill later is only moving money from your bank to the card, so you owe less. It is labelled <strong>Card bill payment</strong> and is not spending again. A monthly SIP is the same: money moves from your bank into something you own, labelled <strong>Investment</strong>.</p>
        <p>Salary shows as <strong>Money in</strong>.</p>
      </Hint>

      {adding && accounts.data && (
        <TransactionForm accounts={accounts.data} onDone={() => setAdding(false)} />
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="field"
          type="search"
          aria-label="Search transactions"
          placeholder="Search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          className="field sm:max-w-56"
          aria-label="Filter by account"
          value={accountId}
          onChange={(e) => {
            setAccountId(Number(e.target.value));
            setPage(0);
          }}
        >
          <option value={0}>All accounts and categories</option>
          <optgroup label="Accounts">
            {moneyAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Categories">
            {categories.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {(from || to) && (
        <p className="text-sm text-muted">
          Showing {from ? fmtDate(from) : 'the start'} to {to ? fmtDate(to) : 'today'} ·{' '}
          <button
            className="underline"
            onClick={() => navigate({ to: '/transactions', search: { account: accountId || undefined }, replace: true })}
          >
            Show all dates
          </button>
        </p>
      )}

      {autoNotice && <p className="text-sm text-muted" aria-live="polite">{autoNotice}</p>}

      {offer && (
        <div className="card flex flex-wrap items-center gap-3 p-4 text-sm">
          <span>
            Also put {offer.count} other unsorted {offer.count === 1 ? 'transaction' : 'transactions'} from {offer.payee}{' '}
            under {offer.name}?
          </span>
          <button className="button" disabled={applySimilar.isPending} onClick={() => applySimilar.mutate(offer)}>
            Yes, change {offer.count === 1 ? 'it' : 'them'}
          </button>
          <button className="button-quiet" onClick={() => setOffer(null)}>
            No
          </button>
        </div>
      )}
      {(recategorize.isError || applySimilar.isError) && (
        <p className="text-sm text-danger">{(recategorize.error ?? applySimilar.error)?.message}</p>
      )}

      {list.isError && <p className="text-sm text-danger">{list.error.message}</p>}
      {remove.isError && <p className="text-sm text-danger">{remove.error.message}</p>}

      {list.isSuccess && total === 0 ? (
        <p className="card p-6 text-sm text-muted">
          {canAdd ? 'No transactions found.' : 'Add an account first, then record transactions.'}
        </p>
      ) : (
        <ul className="card divide-y divide-line">
          {list.data?.items.map((transaction) => {
            const { shown, route } = summarize(transaction, accountId);
            const kind = plainKind(transaction.postings, accountsById);
            const isCategory = (p: { accountType: string }) => p.accountType === 'income' || p.accountType === 'expense';
            const categoryPosting = transaction.postings.find(isCategory);
            // One money side and one category: the category can be changed here.
            const editable = transaction.postings.length === 2 && transaction.postings.filter(isCategory).length === 1;
            const moneyPosting = transaction.postings.find((p) => p !== categoryPosting);
            // One account and one or more categories, which is the shape that can be split.
            const splittable =
              transaction.postings.filter((p) => p.accountType === 'asset' || p.accountType === 'liability').length === 1 &&
              transaction.postings.some(isCategory) &&
              transaction.postings.every((p) => isCategory(p) || p.accountType === 'asset' || p.accountType === 'liability');
            return (
              <li key={transaction.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{transaction.description}</p>
                  <p className="truncate text-sm text-muted">
                    {fmtDate(transaction.date)} · {editable && moneyPosting ? moneyPosting.accountName : route}
                  </p>
                  <p className="text-xs text-muted" title={kind.note}>
                    <span className="rounded-full border border-line px-2 py-0.5">{kind.label}</span>
                    {kind.note && <span className="ml-2 hidden sm:inline">{kind.note}</span>}
                  </p>
                </div>
                {editable && categoryPosting && moneyPosting && accounts.data && (
                  <div className="sm:w-52">
                    <CategorySelect
                      value={categoryPosting.accountId}
                      accounts={accounts.data}
                      ownAccountId={moneyPosting.accountId}
                      disabled={recategorize.isPending}
                      allowEmpty={false}
                      onChange={(categoryId) => categoryId && recategorize.mutate({ id: transaction.id, categoryId })}
                    />
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm whitespace-nowrap">{formatAmount(shown)}</span>
                  {splittable && (
                    <button className="button-quiet" aria-expanded={splitFor === transaction.id} onClick={() => setSplitFor(splitFor === transaction.id ? null : transaction.id)}>
                      Split
                    </button>
                  )}
                  <button
                    className="button-quiet"
                    aria-expanded={receiptsFor === transaction.id}
                    onClick={() => setReceiptsFor(receiptsFor === transaction.id ? null : transaction.id)}
                  >
                    Receipts{transaction.attachments > 0 ? ` (${transaction.attachments})` : ''}
                  </button>
                  <button
                    className="button-quiet"
                    aria-label={`Delete ${transaction.description}`}
                    disabled={remove.isPending}
                    onClick={() => confirmDelete(transaction)}
                  >
                    Delete
                  </button>
                </div>
                {splitFor === transaction.id && accounts.data && (
                  <div className="sm:basis-full">
                    <SplitEditor transaction={transaction} accounts={accounts.data} onDone={() => setSplitFor(null)} />
                  </div>
                )}
                {receiptsFor === transaction.id && (
                  <div className="sm:basis-full">
                    <Receipts transactionId={transaction.id} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pageCount > 1 && (
        <nav className="flex items-center justify-between text-sm text-muted">
          <button className="button-quiet" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {page + 1} of {pageCount}
          </span>
          <button
            className="button-quiet"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
