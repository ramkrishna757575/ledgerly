import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type Insight } from '../api.ts';
import { INSIGHT_HELP } from '../insightHelp.ts';
import { Hint } from './Hint.tsx';

const SHOWN = 4;

// What Ledgerly found wrong or worth a look in your own books. A finding with a
// safe fix has a button for it; the rest point to where it can be sorted out.
export function Attention() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const insights = useQuery({ queryKey: ['insights'], queryFn: api.insights });
  const [notice, setNotice] = useState('');
  const [all, setAll] = useState(false);

  const fix = useMutation({
    mutationFn: (key: string) => api.fixInsight(key),
    onSuccess: ({ message }) => {
      setNotice(message);
      client.invalidateQueries();
    },
  });
  const dismiss = useMutation({
    mutationFn: (key: string) => api.dismissInsight(key),
    onSuccess: () => client.invalidateQueries({ queryKey: ['insights'] }),
  });

  const items = insights.data ?? [];
  const shown = all ? items : items.slice(0, SHOWN);
  if (items.length === 0 && !notice) return null;

  function act(insight: Insight) {
    const { action } = insight;
    if (!action) return;
    if (action.type === 'fix') {
      if (window.confirm(`${action.label}?\n\n${action.note}`)) fix.mutate(insight.key);
    } else {
      navigate({ to: action.to, search: action.search } as never);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="attention-heading">
      <h2 id="attention-heading" className="font-medium">
        Needs attention{items.length > 0 && ` (${items.length})`}
      </h2>
      {notice && (
        <p className="card p-4 text-sm" role="status">
          {notice}
        </p>
      )}
      {(fix.isError || dismiss.isError) && <p className="text-sm text-danger">{(fix.error ?? dismiss.error)?.message}</p>}
      {items.length > 0 && (
        <ul className="card divide-y divide-line">
          {shown.map((insight) => (
            <li key={insight.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className={`text-xs ${insight.severity === 'attention' ? 'font-medium text-danger' : 'text-muted'}`}>
                  {insight.severity === 'attention' ? 'Needs attention' : 'Worth a look'}
                </p>
                <p className="text-sm font-medium">{insight.title}</p>
                <p className="mt-1 text-sm text-muted">{insight.detail}</p>
                {insight.action?.type === 'fix' && <p className="mt-1 text-xs text-muted">{insight.action.note}</p>}
                {INSIGHT_HELP[insight.kind] && (
                  <div className="mt-2">
                    <Hint title="What does this mean?">
                      {INSIGHT_HELP[insight.kind].map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                    </Hint>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {insight.action && (
                  <button
                    className={insight.action.type === 'fix' ? 'button' : 'button-quiet'}
                    disabled={fix.isPending}
                    onClick={() => act(insight)}
                  >
                    {insight.action.label}
                  </button>
                )}
                <button className="button-quiet" title="Not a problem. Hide this." disabled={dismiss.isPending} onClick={() => dismiss.mutate(insight.key)}>
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items.length > SHOWN && (
        <button className="button-quiet self-start" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show ${items.length - SHOWN} more`}
        </button>
      )}
    </section>
  );
}
