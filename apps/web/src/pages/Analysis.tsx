import { formatAmount } from '@ledgerly/core/money';
import { CoachTabs } from '../components/CoachTabs.tsx';
import { Priorities } from '../components/Priorities.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, fmtDate, fmtDateTime, type AnalysisRun, type AnalysisState } from '../api.ts';

const CLASSES = ['equity', 'debt', 'hybrid', 'gold', 'other'] as const;
const LABEL: Record<string, string> = { equity: 'Equity', debt: 'Debt', hybrid: 'Hybrid', gold: 'Gold', other: 'Other' };
const pct = (ratio: number | null, digits = 0) => (ratio === null ? '–' : `${(ratio * 100).toFixed(digits)}%`);
const signed = (ratio: number | null) => (ratio === null ? '–' : `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`);
const rupees = (paise: number) => formatAmount(paise).replace(/\.00$/, '');

function BalanceCheck({ state }: { state: AnalysisState }) {
  const client = useQueryClient();
  const match = useMutation({ mutationFn: (id: number) => api.matchBalance(id), onSuccess: () => client.invalidateQueries() });
  if (state.balanceChecks.length === 0) return null;
  return (
    <section className="card flex flex-col gap-3 border-danger p-4">
      <h2 className="font-medium">Your books disagree with the bank</h2>
      <p className="text-sm text-muted">
        Everything below depends on the balances. These accounts do not match their latest statement, usually because they held money before your first imported statement.
      </p>
      <ul className="divide-y divide-line text-sm">
        {state.balanceChecks.map((c) => (
          <li key={c.accountId} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span>
              <span className="font-medium">{c.accountName}</span>
              <span className="text-muted"> · books {rupees(c.ledger)}, statement of {fmtDate(c.asOf)} says {rupees(c.statement)}</span>
            </span>
            <button className="button" disabled={match.isPending} onClick={() => match.mutate(c.accountId)}>Match the statement</button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">This adds the difference as an opening balance before the first transaction. Your history, income and spending do not change.</p>
      {match.error && <p className="text-sm text-danger">{match.error.message}</p>}
    </section>
  );
}

function Surplus({ state }: { state: AnalysisState }) {
  const client = useQueryClient();
  const { surplus } = state;
  const save = useMutation({ mutationFn: (months: number) => api.analysisSettings({ bufferMonths: months }), onSuccess: () => client.invalidateQueries({ queryKey: ['analysis'] }) });

  const rows: [string, string, boolean?][] = [
    ['In bank accounts and cash', rupees(surplus.liquid)],
    ['Credit cards owed', `− ${rupees(surplus.cardsOwed)}`],
    ['Bills expected in the next 30 days', `− ${rupees(surplus.billsDue)}`],
  ];
  if (surplus.buffer !== null) rows.push([`Emergency buffer, ${surplus.bufferMonths} months of spending`, `− ${rupees(surplus.buffer)}`]);

  return (
    <section className="card flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Idle cash</h2>
        <label className="flex items-center gap-2 text-sm text-muted">
          Keep
          <select className="field" aria-label="Months of spending to keep" value={state.bufferMonths} disabled={save.isPending} onChange={(e) => save.mutate(Number(e.target.value))}>
            {[3, 6, 9, 12, 18].map((m) => (
              <option key={m} value={m}>{m} months</option>
            ))}
          </select>
          of spending in reserve
        </label>
      </header>

      {surplus.status === 'unknown' ? (
        <p className="text-sm text-muted">
          Not enough history yet. This needs at least one full past month of transactions to know what a normal month costs. Import a statement that covers one.
        </p>
      ) : (
        <>
          <div>
            <p className="text-sm text-muted">{surplus.status === 'surplus' ? 'Above your buffer' : 'Short of your buffer'}</p>
            <p className="text-3xl font-semibold tabular-nums">{rupees(Math.abs(surplus.surplus!))}</p>
            {surplus.monthsCovered !== null && <p className="text-sm text-muted">Free cash covers about {surplus.monthsCovered} months of spending.</p>}
          </div>
          <dl className="divide-y divide-line text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 py-2">
                <dt className="text-muted">{label}</dt>
                <dd className="tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted">
            A normal month is {rupees(surplus.pattern.spending!)} of spending
            {surplus.pattern.income !== null && ` against ${rupees(surplus.pattern.income)} of income`}, from the last {surplus.pattern.monthsOfData} full {surplus.pattern.monthsOfData === 1 ? 'month' : 'months'}
            {surplus.pattern.monthsOfData < 3 && ', so treat this as a rough guide'}.
          </p>
        </>
      )}
    </section>
  );
}

function Portfolio({ state }: { state: AnalysisState }) {
  const client = useQueryClient();
  const { review, target } = state;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (value: Record<string, number> | null) => api.analysisSettings({ target: value }),
    onSuccess: () => { setEditing(false); client.invalidateQueries({ queryKey: ['analysis'] }); },
  });

  if (!review.hasPortfolio) {
    return (
      <section className="card p-4">
        <h2 className="font-medium">Portfolio</h2>
        <p className="mt-2 text-sm text-muted">No investments yet. Import a statement on the Investments page, or add deposits and other holdings on Other assets, to review your allocation here.</p>
      </section>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const entries = Object.entries(draft).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)] as const);
    save.mutate(Object.fromEntries(entries));
  }

  const rows = (review.drift ?? review.allocation.map((a) => ({ assetClass: a.assetClass, actual: a.share, target: null as number | null, difference: null as number | null, amount: 0 })));

  return (
    <section className="card flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Investments, {rupees(review.totalValue)}</h2>
        {!editing && (
          <button className="button-quiet" onClick={() => { setDraft(Object.fromEntries(Object.entries(target ?? {}).map(([k, v]) => [k, String(v)]))); setEditing(true); }}>
            {target ? 'Change target' : 'Set a target'}
          </button>
        )}
      </header>

      {editing && (
        <form className="flex flex-col gap-3 rounded-md border border-line p-3" onSubmit={submit}>
          <p className="text-sm text-muted">Your own target mix, in percent. It must add up to 100.</p>
          <div className="flex flex-wrap gap-3">
            {CLASSES.map((c) => (
              <label key={c} className="label">
                {LABEL[c]} %
                <input className="field w-20" inputMode="decimal" value={draft[c] ?? ''} onChange={(e) => setDraft({ ...draft, [c]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button className="button" disabled={save.isPending}>Save</button>
            <button type="button" className="button-quiet" onClick={() => setEditing(false)}>Cancel</button>
            {target && <button type="button" className="button-quiet" disabled={save.isPending} onClick={() => save.mutate(null)}>Clear target</button>}
          </div>
          {save.error && <p className="text-sm text-danger">{save.error.message}</p>}
        </form>
      )}

      {review.otherAssetsValue > 0 && (
        <p className="text-sm text-muted">Includes {rupees(review.otherAssetsValue)} of deposits, PPF, EPF, NPS, stocks and gold from Other assets. Property is left out.</p>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.assetClass} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{LABEL[row.assetClass]}</span>
              <span className="text-muted">
                {pct(row.actual)}
                {row.target !== null && ` of ${pct(row.target)} target`}
                {row.difference !== null && Math.abs(row.difference) >= 0.005 && ` · ${row.difference > 0 ? 'over' : 'under'} by ${rupees(Math.abs(row.amount))}`}
              </span>
            </div>
            <div className="relative h-2 rounded-full bg-line" role="img" aria-label={`${LABEL[row.assetClass]} ${pct(row.actual)}${row.target !== null ? `, target ${pct(row.target)}` : ''}`}>
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, row.actual * 100)}%`, background: 'var(--color-accent)' }} />
              {row.target !== null && <div className="absolute -top-1 h-4 w-0.5 bg-ink" style={{ left: `${Math.min(100, row.target * 100)}%` }} title="Target" />}
            </div>
          </li>
        ))}
      </ul>

      {review.observations.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {review.observations.map((o) => (
            <li key={o.key} className={o.level === 'attention' ? 'font-medium' : ''}>{o.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Market({ state }: { state: AnalysisState }) {
  const client = useQueryClient();
  const fetchIt = useMutation({ mutationFn: api.fetchMarket, onSuccess: () => client.invalidateQueries({ queryKey: ['analysis'] }) });
  const { market } = state;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Market context</h2>
        <button className="button" disabled={fetchIt.isPending} onClick={() => fetchIt.mutate()}>{fetchIt.isPending ? 'Fetching…' : market ? 'Refresh' : 'Fetch market data'}</button>
      </header>
      <p className="text-sm text-muted">
        Public price history for your funds and for the broad market, from AMFI and mfapi.in. Only the public scheme codes of your funds are sent, nothing about you or your amounts.
      </p>
      {fetchIt.error && <p className="text-sm text-danger">{fetchIt.error.message}</p>}
      {market && (
        <>
          <p className="text-xs text-muted">Fetched {fmtDateTime(market.fetchedAt)}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-3 font-normal">&nbsp;</th>
                  <th className="py-1 pr-3 text-right font-normal">1 year</th>
                  <th className="py-1 pr-3 text-right font-normal">3 years, per year</th>
                  <th className="py-1 text-right font-normal">From 1-year high</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {market.benchmark && (
                  <tr>
                    <td className="py-2 pr-3 font-medium">{market.benchmark.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{signed(market.benchmark.return1y)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{signed(market.benchmark.cagr3y)}</td>
                    <td className="py-2 text-right tabular-nums">{signed(market.benchmark.fromHigh1y)}</td>
                  </tr>
                )}
                {market.funds.map((f) => (
                  <tr key={f.name}>
                    <td className="max-w-64 truncate py-2 pr-3" title={f.name}>{f.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{signed(f.return1y)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{signed(f.cagr3y)}</td>
                    <td className="py-2 text-right tabular-nums">{signed(f.fromHigh1y)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {market.unmatched > 0 && <p className="text-xs text-muted">{market.unmatched} of your funds could not be matched to public history. Past returns say nothing certain about future ones.</p>}
        </>
      )}
    </section>
  );
}

function Result({ run }: { run: AnalysisRun }) {
  const { result } = run;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">
        {fmtDateTime(run.createdAt)} · {run.model} via {run.provider}, sent to {run.destination}
      </p>
      {!result ? (
        <div>
          <p className="text-sm text-muted">The answer was not in the expected format, so it is shown as it came.</p>
          <p className="mt-2 whitespace-pre-wrap text-sm">{run.raw}</p>
        </div>
      ) : (
        <>
          {result.headline && <p className="text-lg font-medium">{result.headline}</p>}
          <p>{result.summary}</p>
          {result.priorities.length > 0 && (
            <div>
              <h3 className="font-medium">What to do first</h3>
              <div className="mt-2"><Priorities items={result.priorities} /></div>
            </div>
          )}
          {result.changes.length > 0 && (
            <div>
              <h3 className="font-medium">What changed</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">{result.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
          {result.surplus.assessment && (
            <div>
              <h3 className="font-medium">Idle cash</h3>
              <p className="text-sm">{result.surplus.assessment}</p>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {result.surplus.options.map((option, i) => (
                  <li key={i} className="rounded-md border border-line p-3 text-sm">
                    <p className="font-medium">{option.title}</p>
                    <p className="mt-1"><span className="text-muted">Fits when: </span>{option.whenItFits}</p>
                    <p className="mt-1"><span className="text-muted">Trade-offs: </span>{option.tradeOffs}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(result.portfolio.observations.length > 0 || result.portfolio.questionsToConsider.length > 0) && (
            <div>
              <h3 className="font-medium">Portfolio</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {result.portfolio.observations.map((o, i) => <li key={i}>{o}</li>)}
              </ul>
              {result.portfolio.questionsToConsider.length > 0 && (
                <>
                  <p className="mt-2 text-sm text-muted">Questions to consider</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {result.portfolio.questionsToConsider.map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
          {result.caveats.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
              {result.caveats.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function AiReview({ state }: { state: AnalysisState }) {
  const client = useQueryClient();
  const [includeMarket, setIncludeMarket] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const { ai, history } = state;
  const withMarket = includeMarket && state.market !== null;

  const preview = useQuery({ queryKey: ['analysis', 'preview', withMarket], queryFn: () => api.analysisPreview(withMarket), enabled: showSent });
  const run = useMutation({
    mutationFn: () => api.runAnalysis(withMarket),
    onSuccess: (result) => { setOpenId(null); client.setQueryData(['analysis', 'run', result.id], result); setOpenId(result.id); client.invalidateQueries({ queryKey: ['analysis'], exact: true }); },
  });
  const open = useQuery({ queryKey: ['analysis', 'run', openId], queryFn: () => api.analysisRun(openId!), enabled: openId !== null });

  return (
    <section className="card flex flex-col gap-4 p-4">
      <h2 className="font-medium">AI review</h2>

      {!ai.configured ? (
        <div className="text-sm text-muted">
          <p>No AI provider is set up. {ai.problem && <span className="text-danger">{ai.problem}. </span>}Everything above works without one. Add one under Settings, or set these in <code>.env</code> and restart:</p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-line p-3 text-xs">{`# Anthropic
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=...

# Amazon Bedrock (API key)
AI_PROVIDER=bedrock
AI_MODEL=<model id>
AWS_BEARER_TOKEN_BEDROCK=...
AWS_REGION=ap-south-1

# Ollama, llama.cpp or any OpenAI-compatible server, on your machine
AI_PROVIDER=openai
AI_MODEL=<model name>
AI_BASE_URL=http://localhost:11434/v1`}</pre>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted">
            {ai.destination?.local
              ? `Uses ${ai.model} on this machine (${ai.destination.host}). Nothing leaves it.`
              : `Uses ${ai.model} through ${ai.provider}. A short summary of your finances is sent to ${ai.destination?.host}.`}
            {' '}It never includes account names or numbers, payee names or individual transactions. Read exactly what is sent before you run it.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button className="button-quiet" aria-expanded={showSent} onClick={() => setShowSent(!showSent)}>{showSent ? 'Hide' : 'Show'} what will be sent</button>
            <label className={`flex items-center gap-2 text-sm ${state.market ? '' : 'text-muted'}`}>
              <input type="checkbox" disabled={!state.market} checked={withMarket} onChange={(e) => setIncludeMarket(e.target.checked)} />
              Include market data{!state.market && ' (fetch it first)'}
            </label>
            <button className="button" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Thinking…' : 'Run review'}</button>
          </div>
          {showSent && (
            <pre className="max-h-96 overflow-auto rounded-md border border-line p-3 text-xs">{preview.data ? JSON.stringify(preview.data.snapshot, null, 2) : 'Loading…'}</pre>
          )}
          {run.error && <p className="text-sm text-danger">{run.error.message}</p>}
        </>
      )}

      {open.data && <Result run={open.data} />}

      {history.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Earlier reviews</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {history.map((item) => (
              <li key={item.id}>
                <button className="flex w-full flex-col gap-0.5 py-2 text-left hover:text-ink" aria-pressed={openId === item.id} onClick={() => setOpenId(openId === item.id ? null : item.id)}>
                  <span className="text-xs text-muted">{fmtDateTime(item.createdAt)} · {item.model}</span>
                  <span className="truncate">{item.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function AnalysisPage() {
  const state = useQuery({ queryKey: ['analysis'], queryFn: api.analysis });
  return (
    <div className="flex flex-col gap-6">
      <CoachTabs />
      <p className="text-sm text-muted">
        Where your money sits and what it could do. The figures are worked out here, by plain calculation. This is decision support, not licensed investment advice, and Ledgerly never moves money or places orders.
      </p>
      {state.data && (
        <>
          <BalanceCheck state={state.data} />
          <Surplus state={state.data} />
          <Portfolio state={state.data} />
          <Market state={state.data} />
          <AiReview state={state.data} />
        </>
      )}
      {state.error && <p className="text-sm text-danger">{state.error.message}</p>}
    </div>
  );
}
