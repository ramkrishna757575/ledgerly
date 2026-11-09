import { formatAmount } from '@ledgerly/core/money';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type CategoryRow } from '../api.ts';

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

function details(c: CategoryRow) {
  const parts = [plural(c.transactions, 'transaction')];
  if (c.transactions > 0) parts.push(formatAmount(c.total));
  if (c.rules > 0) parts.push(plural(c.rules, 'rule'));
  if (c.budget !== null) parts.push(`budget ${formatAmount(c.budget).replace(/\.00$/, '')}`);
  return parts.join(' · ');
}

function Row({ category, others, busy, onRename, onMerge, onArchive, onDelete }: {
  category: CategoryRow;
  others: CategoryRow[];
  busy: boolean;
  onRename: (name: string) => void;
  onMerge: (intoId: number) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<'none' | 'rename' | 'merge'>('none');
  const [name, setName] = useState(category.name);
  const [target, setTarget] = useState('');
  const into = others.find((o) => o.id === Number(target));

  function rename(event: FormEvent) {
    event.preventDefault();
    if (name.trim() && name.trim() !== category.name) onRename(name.trim());
    setMode('none');
  }

  return (
    <li className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={`truncate text-sm font-medium ${category.isArchived ? 'text-muted' : ''}`}>
            {category.name}
            {category.isArchived && <span className="ml-2 text-xs font-normal">Archived</span>}
          </p>
          <p className="text-sm text-muted">{details(category)}</p>
        </div>
        {mode === 'none' &&
          (category.isProtected ? (
            <p className="text-xs text-muted">Where unsorted spending goes</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button className="button-quiet" onClick={() => { setName(category.name); setMode('rename'); }}>Rename</button>
              {others.length > 0 && <button className="button-quiet" onClick={() => setMode('merge')}>Merge into…</button>}
              <button className="button-quiet" disabled={busy} onClick={onArchive}>{category.isArchived ? 'Restore' : 'Archive'}</button>
              {category.transactions === 0 && (
                <button className="button-quiet" disabled={busy} onClick={() => window.confirm(`Delete ${category.name}?`) && onDelete()}>Delete</button>
              )}
            </div>
          ))}
      </div>

      {mode === 'rename' && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={rename}>
          <input className="field" aria-label="New name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <button className="button" disabled={busy}>Save</button>
          <button type="button" className="button-quiet" onClick={() => setMode('none')}>Cancel</button>
        </form>
      )}

      {mode === 'merge' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select className="field" aria-label="Merge into" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Merge into…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            <button
              className="button"
              disabled={busy || !into}
              onClick={() => { onMerge(into!.id); setMode('none'); }}
            >
              Merge
            </button>
            <button className="button-quiet" onClick={() => setMode('none')}>Cancel</button>
          </div>
          {into && (
            <p className="text-sm text-muted">
              {plural(category.transactions, 'transaction')}
              {category.rules > 0 && ` and ${plural(category.rules, 'rule')}`} will move to {into.name}, and {category.name} will be removed.
              {category.budget !== null && (into.budget === null ? ' Its budget moves too.' : ` ${into.name} keeps its own budget.`)} This cannot be undone.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function AddCategory({ onAdd, busy }: { onAdd: (name: string, type: 'income' | 'expense') => void; busy: boolean }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'income' | 'expense'>('expense');
  return (
    <form
      className="card flex flex-wrap items-end gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onAdd(name.trim(), type);
        setName('');
      }}
    >
      <label className="label">
        New category
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="label">
        Kind
        <select className="field" value={type} onChange={(e) => setType(e.target.value as 'income' | 'expense')}>
          <option value="expense">Spending</option>
          <option value="income">Income</option>
        </select>
      </label>
      <button className="button" disabled={busy || !name.trim()}>Add</button>
    </form>
  );
}

export function CategoriesPage() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const [notice, setNotice] = useState('');
  // Names and amounts show up all over the app, so everything is refetched.
  const done = () => client.invalidateQueries();

  const rename = useMutation({ mutationFn: ({ id, name }: { id: number; name: string }) => api.updateAccount(id, { name }), onSuccess: done });
  const archive = useMutation({ mutationFn: (c: CategoryRow) => (c.isArchived ? api.unarchiveAccount(c.id) : api.archiveAccount(c.id)), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteAccount(id), onSuccess: done });
  const create = useMutation({ mutationFn: ({ name, type }: { name: string; type: 'income' | 'expense' }) => api.createCategory(name, type), onSuccess: done });
  const merge = useMutation({
    mutationFn: ({ id, intoId }: { id: number; intoId: number }) => api.mergeCategory(id, intoId),
    onSuccess: (result) => {
      setNotice(`Merged into ${result.into}: ${plural(result.transactions, 'transaction')} moved.`);
      done();
    },
  });

  const busy = [rename, archive, remove, create, merge].some((m) => m.isPending);
  const error = [rename, archive, remove, create, merge].find((m) => m.error)?.error?.message;
  const rows = list.data ?? [];

  const section = (type: 'expense' | 'income', title: string) => {
    const group = rows.filter((c) => c.type === type);
    return (
      <section className="flex flex-col gap-3">
        <h2 className="font-medium">{title}</h2>
        <ul className="card divide-y divide-line">
          {group.map((category) => (
            <Row
              key={category.id}
              category={category}
              others={group.filter((o) => o.id !== category.id && !o.isArchived)}
              busy={busy}
              onRename={(name) => rename.mutate({ id: category.id, name })}
              onMerge={(intoId) => merge.mutate({ id: category.id, intoId })}
              onArchive={() => archive.mutate(category)}
              onDelete={() => remove.mutate(category.id)}
            />
          ))}
        </ul>
      </section>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionTabs section="organise" />
      <p className="text-sm text-muted">
        Rename a category and it changes everywhere. Merge two into one to tidy up: transactions, rules and budgets move across. Archive one you no longer use, so it stops appearing in lists but its history stays.
      </p>
      {notice && <p className="text-sm text-muted" aria-live="polite">{notice}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      <AddCategory busy={busy} onAdd={(name, type) => create.mutate({ name, type })} />
      {section('expense', 'Spending')}
      {section('income', 'Income')}
    </div>
  );
}
