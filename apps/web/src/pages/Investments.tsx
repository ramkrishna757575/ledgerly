import { Hint } from '../components/Hint.tsx';
import { formatAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { needsPassword, sendWithPassword } from '../pdfPassword.ts';
import { api, fmtDate, type Holding, type InvestmentImport, type Portfolio } from '../api.ts';
import { ChartCard, Legend } from '../charts/ChartCard.tsx';

const CLASS_LABEL: Record<string, string> = { equity: 'Equity', debt: 'Debt', hybrid: 'Hybrid', gold: 'Gold', other: 'Other' };
const CLASS_COLOR: Record<string, string> = {
  equity: 'var(--viz-1)',
  debt: 'var(--viz-2)',
  hybrid: 'var(--viz-3)',
  gold: 'var(--viz-4)',
  other: 'var(--viz-other)',
};

const units = (micro: number) => (micro / 1_000_000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const price = (micro: number) => (micro / 1_000_000).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const signed = (paise: number) => `${paise > 0 ? '+' : ''}${formatAmount(paise)}`;
const percent = (ratio: number) => `${ratio > 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

function Allocation({ portfolio }: { portfolio: Portfolio }) {
  const parts = portfolio.allocation;
  return (
    <ChartCard
      title="How it is split"
      subtitle="By type of fund"
      table={{
        headers: ['Type', 'Funds', 'Value', 'Share'],
        rows: parts.map((p) => [CLASS_LABEL[p.assetClass] ?? p.assetClass, p.funds, formatAmount(p.value), `${(p.share * 100).toFixed(1)}%`]),
      }}
    >
      <Legend items={parts.map((p) => ({ label: `${CLASS_LABEL[p.assetClass]} ${(p.share * 100).toFixed(0)}%`, color: CLASS_COLOR[p.assetClass]! }))} />
      <div className="flex h-6 gap-0.5 overflow-hidden rounded-md" role="img" aria-label={parts.map((p) => `${CLASS_LABEL[p.assetClass]} ${(p.share * 100).toFixed(0)} percent`).join(', ')}>
        {parts.map((p) => (
          <div
            key={p.assetClass}
            style={{ width: `${p.share * 100}%`, background: CLASS_COLOR[p.assetClass] }}
            title={`${CLASS_LABEL[p.assetClass]}: ${formatAmount(p.value)}`}
          />
        ))}
      </div>
    </ChartCard>
  );
}

function AutoPrices() {
  const client = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const state = useQuery({ queryKey: ['auto-prices'], queryFn: api.autoPrices });
  const set = useMutation({ mutationFn: api.setAutoPrices, onSuccess: () => client.invalidateQueries({ queryKey: ['auto-prices'] }) });
  if (!state.data || auth.data?.demo) return null;
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-muted">
      <input type="checkbox" checked={state.data.on} disabled={set.isPending} onChange={(e) => set.mutate(e.target.checked)} />
      Update prices from AMFI once a day{state.data.last ? ` (last ${fmtDate(state.data.last)})` : ''}
    </label>
  );
}

function Sips() {
  const sips = useQuery({ queryKey: ['sips'], queryFn: api.sips });
  const plans = sips.data?.plans ?? [];
  if (plans.length === 0) return null;
  return (
    <section className="card flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Monthly SIPs</h2>
        <p className="text-sm text-muted">{formatAmount(sips.data!.monthlyTotal)} a month in total</p>
      </header>
      <ul className="divide-y divide-line text-sm">
        {plans.map((p) => (
          <li key={p.positionId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
            <span className="min-w-0">
              <span className="block truncate font-medium" title={p.fund}>{p.fund}</span>
              <span className="text-muted">
                {formatAmount(p.amount)} · {p.instalments} instalments seen · {p.active ? `next about ${fmtDate(p.nextDue!)}` : `no instalment since ${fmtDate(p.lastDate)}, so it looks stopped`}
              </span>
            </span>
            <span className="text-xs text-muted">{p.inBankStatement} of {p.instalments} found in your bank</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Active SIPs are counted in the cash-flow forecast.</p>
    </section>
  );
}

function HoldingsTable({ holdings }: { holdings: Holding[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[56rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="px-4 py-3 font-normal">Fund</th>
            <th className="px-4 py-3 text-right font-normal">Value</th>
            <th className="px-4 py-3 text-right font-normal">Invested</th>
            <th className="px-4 py-3 text-right font-normal">Gain</th>
            <th className="px-4 py-3 text-right font-normal">Return a year</th>
            <th className="px-4 py-3 text-right font-normal">Units · price</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.id} className="border-b border-line last:border-0">
              <td className="max-w-80 px-4 py-3">
                <p className="truncate font-medium" title={h.name}>
                  {h.name}
                </p>
                <p className="truncate text-xs text-muted">
                  {CLASS_LABEL[h.assetClass]}
                  {h.folio && ` · folio ${h.folio}`}
                  {` · ${fmtDate(h.asOf)}`}
                  {h.source === 'amfi' && ' · price update'}
                </p>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{formatAmount(h.value)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{h.invested === null ? '—' : formatAmount(h.invested)}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {h.gain === null ? (
                  '—'
                ) : (
                  <>
                    {signed(h.gain)}
                    {h.gainRatio !== null && <span className="block text-xs text-muted">{percent(h.gainRatio)}</span>}
                  </>
                )}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {h.xirrBps === null ? (
                  '—'
                ) : (
                  <>
                    {(h.xirrBps / 100).toFixed(1)}%
                    <span className="block text-xs text-muted">{h.xirrSource === 'calculated' ? 'calculated' : 'as reported'}</span>
                  </>
                )}
              </td>
              <td className="px-4 py-3 text-right text-muted tabular-nums">
                {units(h.units)}
                <span className="block text-xs">₹{price(h.nav)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Review({ id, onClose }: { id: number; onClose: () => void }) {
  const client = useQueryClient();
  const [accountId, setAccountId] = useState('');
  const detail = useQuery({ queryKey: ['investment-import', id], queryFn: () => api.investmentImport(id) });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });

  const done = () => client.invalidateQueries();
  const commit = useMutation({ mutationFn: () => api.commitInvestment(id, accountId ? Number(accountId) : undefined), onSuccess: done });
  const undo = useMutation({ mutationFn: () => api.undoInvestment(id), onSuccess: done });
  const discard = useMutation({
    mutationFn: () => api.discardInvestment(id),
    onSuccess: () => {
      done();
      onClose();
    },
  });

  const error = [commit, undo, discard].find((m) => m.isError)?.error?.message;
  if (detail.isError) return <p className="text-sm text-danger">{detail.error.message}</p>;
  if (!detail.data) return <p className="text-sm text-muted">Loading…</p>;

  const data: InvestmentImport = detail.data;
  const staged = data.status === 'staged';
  const fresh = data.holdings.filter((h) => h.isNew).length;
  const matches = data.statedTotal === null || Math.abs(data.total - data.statedTotal) <= Math.max(5000, data.statedTotal * 0.001);
  const assets = (accounts.data ?? []).filter((a) => a.type === 'asset' && !a.isArchived);

  return (
    <section className="card flex flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{data.filename}</h2>
          <p className="text-sm text-muted">
            {data.label} · as on {fmtDate(data.asOf)}
          </p>
        </div>
        <button className="button-quiet" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="flex flex-col gap-3 border-b border-line p-4 text-sm">
        <p>
          {plural(data.holdings.length, 'fund')} worth <strong className="font-medium">{formatAmount(data.total)}</strong>
          {fresh > 0 && `, ${fresh} of them new to Ledgerly`}
          {data.transactions > 0 && `, and ${plural(data.transactions, 'transaction')} in the period`}.
        </p>
        {data.statedTotal !== null && (
          <p className={matches ? 'text-accent' : 'text-danger'}>
            {matches ? "The funds add up to the statement's own total." : `The funds add up to ${formatAmount(data.total)}, but the statement says ${formatAmount(data.statedTotal)}.`}
          </p>
        )}
        {data.warnings.map((warning) => (
          <p key={warning} className="text-danger">
            {warning}
          </p>
        ))}
        {staged && (
          <>
            <label className="label max-w-sm">
              Value them in this account
              <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Choose for me</option>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="max-w-2xl text-muted">
              That account is revalued to what these funds are worth, so your net worth is right. The change is not counted as income or
              spending, and you can undo it.
            </p>
          </>
        )}
      </div>

      <ul className="divide-y divide-line">
        {data.holdings.map((h) => (
          <li key={`${h.folio}-${h.name}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1 truncate" title={h.name}>
              {h.name}
              {h.isNew && <span className="ml-2 text-xs text-muted">New</span>}
            </span>
            <span className="text-muted">{CLASS_LABEL[h.assetClass]}</span>
            <span className="tabular-nums">{formatAmount(h.value)}</span>
          </li>
        ))}
      </ul>

      <footer className="flex flex-col gap-3 border-t border-line p-4">
        {error && <p className="text-sm text-danger">{error}</p>}
        {commit.isSuccess && <p className="text-sm text-muted">Imported. Your investments are now valued from this statement.</p>}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {staged && (
            <>
              <button className="button-quiet" disabled={discard.isPending} onClick={() => discard.mutate()}>
                Discard
              </button>
              <button className="button" disabled={commit.isPending} onClick={() => (matches || window.confirm('The funds do not add up to the statement\'s own total, so something may be misread. Import anyway?')) && commit.mutate()}>
                Import {plural(data.holdings.length, 'fund')}
              </button>
            </>
          )}
          {data.status === 'committed' && (
            <button
              className="button-quiet"
              disabled={undo.isPending}
              onClick={() => window.confirm('Remove these holdings and their effect on your net worth?') && undo.mutate()}
            >
              Undo import
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

function Upload({ onStaged }: { onStaged: (id: number) => void }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  // Stays up while the next attempt is being read, or the box would vanish as you submit.
  const [locked, setLocked] = useState(false);
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const demo = auth.data?.demo ?? false;
  const samples = useQuery({ queryKey: ['investment-samples'], queryFn: api.investmentSamples, enabled: demo });

  const done = (staged: InvestmentImport) => {
    client.invalidateQueries({ queryKey: ['investment-imports'] });
    setFile(null);
    setPassword('');
    setLocked(false);
    if (input.current) input.current.value = '';
    onStaged(staged.id);
  };
  const upload = useMutation({ mutationFn: (selected: File) => sendWithPassword((pw) => api.uploadInvestment(selected, pw), password), onSuccess: done,
    onError: (error) => needsPassword(error) && setLocked(true),
  });
  const sample = useMutation({ mutationFn: api.stageInvestmentSample, onSuccess: done });
  const error = (upload.error ?? sample.error)?.message;

  return (
    <section className="card flex flex-col gap-4 p-4">
      {demo ? (
        <>
          <div>
            <h2 className="font-medium">Try an import</h2>
            <p className="mt-1 text-sm text-muted">Uploads are off in demo mode. These made-up statements show how it works.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {samples.data?.map((s) => (
              <button key={s.id} className="button" disabled={sample.isPending} onClick={() => sample.mutate(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (file) upload.mutate(file);
          }}
        >
          <div>
            <h2 className="font-medium">Add a statement</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              A consolidated account statement (CAS) from CDSL, or a Scripbox portfolio report, as a PDF, or a CSV holdings export from a broker or app (names, units and value; stocks work too). It is read on this machine. A
              newer statement replaces the values from an older one, and importing both gives you the cost and return from Scripbox
              with the units from the CAS.
            </p>
          </div>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf,.csv,.tsv,.xlsx,text/csv"
            aria-label="Investment statement PDF"
            className="text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-ink"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPassword(''); setLocked(false); upload.reset(); }}
          />
          {locked && (
            <label className="label max-w-xs">
              PDF password
              <input
                className="field"
                type="password"
                autoComplete="off"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="text-xs">Banks often use your date of birth or customer ID. It is used once to read the file and is not saved.</span>
            </label>
          )}
          <div>
            <button className="button" disabled={!file || upload.isPending}>
              {upload.isPending ? 'Reading…' : 'Read statement'}
            </button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}

export function InvestmentsPage() {
  const client = useQueryClient();
  const [openId, setOpenId] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const portfolio = useQuery({ queryKey: ['investments'], queryFn: api.investments });
  const imports = useQuery({ queryKey: ['investment-imports'], queryFn: api.investmentImports });

  const prices = useMutation({
    mutationFn: api.updatePrices,
    onSuccess: ({ updated, skipped, asOf }) => {
      setNotice(
        updated > 0
          ? `Updated ${plural(updated, 'fund')} to prices from ${fmtDate(asOf!)}.`
          : skipped > 0
            ? 'Prices are already up to date.'
            : 'None of your funds were in the price list.',
      );
      client.invalidateQueries();
    },
  });

  const data = portfolio.data;
  const empty = data !== undefined && data.holdings.length === 0;
  const gain = data?.summary.gain ?? null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Investments</h1>
          {data?.summary.asOf && <p className="mt-1 text-sm text-muted">Mutual funds, as on {fmtDate(data.summary.asOf)}</p>}
        </div>
        {!empty && !auth.data?.demo && (
          <div className="flex flex-col items-end gap-1">
            <button className="button-quiet" disabled={prices.isPending} onClick={() => prices.mutate()}>
              {prices.isPending ? 'Fetching prices…' : 'Update prices'}
            </button>
            <p className="max-w-xs text-right text-xs text-muted">
              Fetches today's prices from AMFI, which publishes them. Units come from your last statement.
            </p>
          </div>
        )}
      </header>

      {!empty && (
        <Hint title="What do these numbers mean?">
          <p><strong>Invested</strong> is the money you have put in, including each monthly SIP. <strong>Worth today</strong> is your units times today's price (NAV). <strong>Gain</strong> is the difference.</p>
          <p>The gain is not yours until you sell: it moves up and down with the market. A SIP buys more units when the price is low and fewer when it is high, so judge it over years, not weeks.</p>
        </Hint>
      )}

      {notice && <p className="text-sm text-muted" aria-live="polite">{notice}</p>}
      {prices.isError && <p className="text-sm text-danger">{prices.error.message}</p>}
      {portfolio.isError && <p className="text-sm text-danger">{portfolio.error.message}</p>}

      {data && !empty && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Worth today" value={formatAmount(data.summary.value)} />
            <Tile label="Invested" value={data.summary.invested === null ? '—' : formatAmount(data.summary.invested)} note={data.summary.complete ? undefined : 'Cost is missing for some funds'} />
            <Tile label="Gain" value={gain === null ? '—' : signed(gain)} note={data.summary.gainRatio === null ? undefined : `${percent(data.summary.gainRatio)} overall`} />
            <Tile label="Funds" value={String(data.holdings.length)} note={`${data.allocation.length} ${data.allocation.length === 1 ? 'type' : 'types'}`} />
          </div>
          <Allocation portfolio={data} />
          <HoldingsTable holdings={data.holdings} />
          <Sips />
          <AutoPrices />
        </>
      )}

      {empty && (
        <p className="card p-6 text-sm text-muted">
          Nothing here yet. Add a CDSL consolidated account statement or a Scripbox portfolio report below, and your holdings, what you
          invested and how they have done will show up here and in your net worth.
        </p>
      )}

      <Upload onStaged={setOpenId} />
      {openId !== null && <Review key={openId} id={openId} onClose={() => setOpenId(null)} />}

      {(imports.data ?? []).length > 0 && (
        <section>
          <h2 className="mb-3 font-medium">Imports</h2>
          <ul className="card divide-y divide-line">
            {imports.data?.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.filename}</p>
                  <p className="truncate text-sm text-muted">
                    As on {fmtDate(item.asOf)} · {plural(item.funds, 'fund')} · {formatAmount(item.total)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted capitalize">{item.status === 'staged' ? 'To review' : item.status}</span>
                  {item.source !== 'amfi' && (
                    <button className="button-quiet" onClick={() => setOpenId(item.id)}>
                      {item.status === 'staged' ? 'Review' : 'View'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
