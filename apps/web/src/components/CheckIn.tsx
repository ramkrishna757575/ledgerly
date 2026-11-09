import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, fmtDate } from '../api.ts';
import { Priorities } from './Priorities.tsx';

// The newest AI review in short: the one thing to know and what to do first.
// Shown only once an AI provider is set up, and it sends nothing until asked.
export function CheckIn() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ['analysis'], queryFn: api.analysis });
  const latestId = state.data?.history[0]?.id;
  const latest = useQuery({ queryKey: ['analysis', 'run', latestId], queryFn: () => api.analysisRun(latestId!), enabled: latestId !== undefined });
  const run = useMutation({
    mutationFn: () => api.runAnalysis(false),
    onSuccess: (result) => {
      client.setQueryData(['analysis', 'run', result.id], result);
      client.invalidateQueries({ queryKey: ['analysis'], exact: true });
    },
  });

  const monthly = useQuery({ queryKey: ['ai-monthly'], queryFn: api.aiMonthly });
  const setMonthly = useMutation({ mutationFn: api.setAiMonthly, onSuccess: () => client.invalidateQueries({ queryKey: ['ai-monthly'] }) });
  const ai = state.data?.ai;
  if (!ai?.configured) return null;
  const result = latest.data?.result;
  const where = ai.destination?.local ? `stays on this machine (${ai.destination.host})` : `goes to ${ai.destination?.host}`;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Your money check-in</h2>
        <div className="flex items-center gap-2">
          <Link to="/analysis" className="button-quiet">Full review</Link>
          <button className="button" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Thinking…' : latest.data ? 'Refresh' : 'Get my check-in'}</button>
        </div>
      </header>

      {result ? (
        <>
          {result.headline && <p className="font-medium">{result.headline}</p>}
          {result.summary && <p className="text-sm text-muted">{result.summary}</p>}
          {result.priorities.length > 0 && (
            <Priorities items={result.priorities} limit={3} />
          )}
          <p className="text-xs text-muted">Made {fmtDate(latest.data!.createdAt.slice(0, 10))} by {latest.data!.model}. A model can be wrong, and this is not financial advice.</p>
        </>
      ) : latest.data ? (
        <p className="text-sm text-muted">The last review could not be read. Refresh to try again, or open the full review to see what came back.</p>
      ) : (
        <p className="text-sm text-muted">
          A short read on where you stand and what to do first, written by {ai.model}. A summary of your totals (no account names or numbers, no payee names, no individual transactions) {where}. Nothing is sent until you press the button.
        </p>
      )}
      <label className="flex items-start gap-2 text-xs text-muted">
        <input className="mt-0.5" type="checkbox" checked={monthly.data?.enabled ?? false} disabled={setMonthly.isPending} onChange={(e) => setMonthly.mutate(e.target.checked)} />
        <span>Write a new check-in for me each month, after the 5th. It sends the same totals-only summary {where}, so I know it will happen without me pressing the button.</span>
      </label>
      {run.error && <p className="text-sm text-danger">{run.error.message}</p>}
    </section>
  );
}
