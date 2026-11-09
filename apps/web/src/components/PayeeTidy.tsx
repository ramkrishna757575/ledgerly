import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type PayeeSuggestion } from '../api.ts';

// Bank text names one shop many ways and cuts long names off. Rename a payee here and it
// changes on every past transaction and on every later import. The bank's own text on each
// transaction is left as it was.
export function PayeeTidy() {
  const client = useQueryClient();
  const tidy = useQuery({ queryKey: ['payee-tidy'], queryFn: api.payeeTidy });
  const [more, setMore] = useState<PayeeSuggestion[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [off, setOff] = useState<string[]>([]);
  const [showSent, setShowSent] = useState(false);
  const [done, setDone] = useState('');

  const ask = useMutation({ mutationFn: api.payeeTidyAi, onSuccess: (r) => setMore(r.suggestions) });
  const apply = useMutation({
    mutationFn: (pairs: { from: string; to: string }[]) => api.applyPayeeAliases(pairs),
    onSuccess: (r) => {
      setDone(`Renamed ${r.renamed} transaction${r.renamed === 1 ? '' : 's'}. Later imports will use the new names too.`);
      setMore([]);
      setOff([]);
      setNames({});
      client.invalidateQueries();
    },
  });

  const data = tidy.data;
  if (!data) return null;
  const known = new Set(data.suggestions.map((s) => s.from));
  const all = [...data.suggestions, ...more.filter((s) => !known.has(s.from))];
  const chosen = all.filter((s) => !off.includes(s.from)).map((s) => ({ from: s.from, to: (names[s.from] ?? s.to).trim() })).filter((p) => p.to);
  const where = data.ai.destination?.local ? `stays on this machine (${data.ai.destination.host})` : `goes to ${data.ai.destination?.host}`;

  if (all.length === 0 && !data.ai.configured && !done) return null;
  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Tidy payee names</h2>
      <p className="text-sm text-muted">
        The same shop shows up as "Amazon India", "AMAZON INDIA" and "Amazon In", and long names are cut off. Joining them makes your reports, rules and category memory work on one name. Only the payee label changes: the bank's own text on each transaction stays.
      </p>
      {done && <p className="text-sm" role="status">{done}</p>}

      {all.length > 0 ? (
        <ul className="divide-y divide-line text-sm">
          {all.map((s) => (
            <li key={s.from} className="flex flex-wrap items-center gap-2 py-2">
              <input type="checkbox" aria-label={`Rename ${s.from}`} checked={!off.includes(s.from)} onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== s.from) : [...off, s.from])} />
              <span className="min-w-0 truncate" title={s.from}>{s.from}</span>
              <span className="text-muted">({s.times}) to</span>
              <input className="field w-56 py-1" aria-label={`New name for ${s.from}`} value={names[s.from] ?? s.to} maxLength={80} onChange={(e) => setNames({ ...names, [s.from]: e.target.value })} />
              <span className="text-xs text-muted">{s.source === 'ai' ? 'AI: ' : ''}{s.why}</span>
            </li>
          ))}
        </ul>
      ) : (
        !done && <p className="text-sm text-muted">Nothing obvious to join. {data.ai.configured ? 'A model can find harder cases, such as a fragment like "com India" that is really "Amazon".' : ''}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button className="button" disabled={apply.isPending || chosen.length === 0} onClick={() => apply.mutate(chosen)}>Rename {chosen.length}</button>
        {data.ai.configured && (
          <button className="button-quiet" disabled={!data.ai.enabled || ask.isPending} onClick={() => ask.mutate()}>{ask.isPending ? 'Asking…' : 'Ask AI for more'}</button>
        )}
        {data.ai.configured && <button className="button-quiet" aria-expanded={showSent} onClick={() => setShowSent(!showSent)}>{showSent ? 'Hide' : 'Show'} what would be sent</button>}
      </div>
      {data.ai.configured && !data.ai.enabled && <p className="text-xs text-muted">Asking AI uses the same switch as "Suggest categories with AI" above: tick it there first.</p>}
      {showSent && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted">Each payee name, how often it appears, and one example of the bank's own line for it, with long numbers blanked. No dates, amounts or accounts. It {where}.</p>
          <pre className="max-h-80 overflow-auto rounded-md border border-line p-3 text-xs">{JSON.stringify(data.ai.send, null, 1)}</pre>
        </div>
      )}
      {(ask.error || apply.error) && <p className="text-sm text-danger">{(ask.error ?? apply.error)?.message}</p>}
    </section>
  );
}
