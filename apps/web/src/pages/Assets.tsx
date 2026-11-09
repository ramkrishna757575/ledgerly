import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, fmtDate, today, type Asset } from '../api.ts';

const KINDS = [
  ['fd', 'Fixed deposit'],
  ['rd', 'Recurring deposit'],
  ['ppf', 'PPF'],
  ['epf', 'EPF'],
  ['nps', 'NPS'],
  ['stocks', 'Stocks'],
  ['gold', 'Gold'],
  ['property', 'Property'],
  ['other', 'Other'],
] as const;
const LABEL = Object.fromEntries(KINDS);
const rupees = (paise: number) => formatAmount(paise).replace(/\.00$/, '');

function Row({ asset, busy, onValue, onDelete }: { asset: Asset; busy: boolean; onValue: (value: number) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  function save(event: FormEvent) {
    event.preventDefault();
    try {
      onValue(parseAmount(value));
      setEditing(false);
      setError('');
    } catch {
      setError('Enter an amount like 250000');
    }
  }

  return (
    <li className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{asset.name}</p>
          <p className="text-sm text-muted">
            {LABEL[asset.kind]}
            {asset.rateBps !== null && ` · ${(asset.rateBps / 100).toFixed(2)}% a year`}
            {asset.maturityDate && ` · matures ${fmtDate(asset.maturityDate)}${asset.daysToMaturity !== null && asset.daysToMaturity >= 0 ? ` (${asset.daysToMaturity} days)` : ' (matured)'}`}
          </p>
        </div>
        <div className="text-right">
          <p className="font-medium tabular-nums">{rupees(asset.value)}</p>
          {asset.gain !== null && (
            <p className={`text-sm tabular-nums ${asset.gain < 0 ? 'text-danger' : 'text-muted'}`}>
              {asset.gain >= 0 ? '+' : '−'}{rupees(Math.abs(asset.gain))} on {rupees(asset.invested!)}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {editing ? (
          <form className="flex items-center gap-2" onSubmit={save}>
            <input className="field w-36" inputMode="decimal" aria-label="Current value" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
            <button className="button" disabled={busy}>Save</button>
            <button type="button" className="button-quiet" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : (
          <>
            {asset.grows ? (
              <span className="text-xs text-muted">Grows from its rate, updated daily.</span>
            ) : (
              <button className="button-quiet" onClick={() => { setValue(String(asset.value / 100)); setEditing(true); }}>Update value</button>
            )}
            <button className="button-quiet" disabled={busy} onClick={() => window.confirm(`Delete ${asset.name}?`) && onDelete()}>Delete</button>
          </>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </li>
  );
}

function AddAsset({ onAdd, busy, error }: { onAdd: (input: unknown) => void; busy: boolean; error?: string }) {
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>('fd');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [invested, setInvested] = useState('');
  const [rate, setRate] = useState('');
  const [start, setStart] = useState('');
  const [maturity, setMaturity] = useState('');
  const [problem, setProblem] = useState('');
  const deposit = kind === 'fd';

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const grows = deposit && rate.trim() !== '';
      const input: Record<string, unknown> = { name, kind, asOf: today() };
      if (grows) {
        input.value = 0;
        input.invested = parseAmount(invested);
        input.rateBps = Math.round(Number(rate) * 100);
        if (!Number.isFinite(input.rateBps as number)) throw new Error('rate');
        if (!start) throw new Error('start');
        input.startDate = start;
      } else {
        input.value = parseAmount(value);
        if (invested.trim()) input.invested = parseAmount(invested);
        if (start) input.startDate = start;
      }
      if (maturity) input.maturityDate = maturity;
      setProblem('');
      onAdd(input);
    } catch (e) {
      setProblem(e instanceof Error && e.message === 'start' ? 'A deposit that grows by itself needs a start date' : 'Check the amounts and the rate');
    }
  }

  return (
    <form className="card flex flex-col gap-3 p-4" onSubmit={submit}>
      <h2 className="font-medium">Add an asset</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">
          Kind
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="label">
          Name
          <input className="field" value={name} placeholder={deposit ? 'SBI FD 2026' : ''} onChange={(e) => setName(e.target.value)} />
        </label>
        {!deposit || rate.trim() === '' ? (
          <label className="label">
            Worth today (₹)
            <input className="field w-36" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        ) : null}
        <label className="label">
          Put in (₹, optional{deposit && rate ? ' — required' : ''})
          <input className="field w-36" inputMode="decimal" value={invested} onChange={(e) => setInvested(e.target.value)} />
        </label>
        {deposit && (
          <label className="label">
            Interest % a year
            <input className="field w-24" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </label>
        )}
        <label className="label">
          Start date
          <input className="field" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="label">
          Matures
          <input className="field" type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} />
        </label>
        <button className="button" disabled={busy || !name.trim()}>Add</button>
      </div>
      {deposit && <p className="text-xs text-muted">Give a fixed deposit its interest rate and it grows by itself, compounded quarterly, until it matures. Leave the rate empty to enter its value by hand.</p>}
      {(problem || error) && <p className="text-sm text-danger">{problem || error}</p>}
    </form>
  );
}

export function AssetsPage() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['assets'], queryFn: api.assets });
  const refresh = () => client.invalidateQueries();
  const create = useMutation({ mutationFn: api.createAsset, onSuccess: refresh });
  const value = useMutation({ mutationFn: ({ id, v }: { id: number; v: number }) => api.updateAssetValue(id, v, today()), onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteAsset, onSuccess: refresh });
  const busy = create.isPending || value.isPending || remove.isPending;
  const error = (value.error ?? remove.error)?.message;
  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">Other assets</h1>
        {items.length > 0 && <p className="text-sm text-muted">Total <span className="font-medium text-ink">{rupees(list.data!.total)}</span></p>}
      </header>
      <p className="text-sm text-muted">
        Fixed deposits, PPF, EPF, NPS, stocks, gold, property and anything else you own that is not in a bank account or a mutual fund statement. They count in your net worth. A rise in value is never counted as income.
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {list.isSuccess && items.length === 0 ? (
        <p className="card p-6 text-sm text-muted">Nothing here yet. Add what you own below.</p>
      ) : (
        <ul className="card divide-y divide-line">
          {items.map((asset) => (
            <Row key={asset.accountId} asset={asset} busy={busy} onValue={(v) => value.mutate({ id: asset.accountId, v })} onDelete={() => remove.mutate(asset.accountId)} />
          ))}
        </ul>
      )}
      <AddAsset busy={busy} error={create.error?.message} onAdd={(input) => create.mutate(input)} />
    </div>
  );
}
