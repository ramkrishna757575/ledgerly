import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtDate } from '../api.ts';

// Shown beside a statement Ledgerly cannot read yet. A model works out the layout from this
// one file; Ledgerly keeps it and reads every later statement from that bank by itself.
export function LearnFormat({ file, password, onLearned }: { file: File; password?: string; onLearned: () => void }) {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ['ai-parsers'], queryFn: api.aiParsers });
  const toggle = useMutation({ mutationFn: api.setAiParsers, onSuccess: () => client.invalidateQueries({ queryKey: ['ai-parsers'] }) });
  const learn = useMutation({
    mutationFn: () => api.learnStatement(file, password),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['ai-parsers'] });
      onLearned();
    },
  });
  const data = state.data;
  if (!data?.configured) return <span className="text-xs text-muted">Add an AI provider in Settings and Ledgerly can learn this format.</span>;
  const where = data.destination?.local ? `stays on this machine (${data.destination.host})` : `goes to ${data.destination?.host}`;

  return (
    <div className="flex w-full flex-col gap-2 rounded-md border border-line p-3 text-xs text-muted">
      <p>
        Ledgerly can learn this layout from this one file. The top of the statement as text, with account numbers and long reference numbers blanked but dates, amounts and descriptions left in, {where}. The model replies with a reading recipe (not code), Ledgerly tests it on the whole statement and checks it against the running balance, and keeps it only if it matches. Later statements from the same bank are then read here, with no model.
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={data.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
        I have read what is sent, and want this on
      </label>
      <div>
        <button className="button" disabled={!data.enabled || learn.isPending} onClick={() => learn.mutate()}>{learn.isPending ? 'Learning…' : 'Learn this format'}</button>
      </div>
      {learn.error && <p className="text-danger">{learn.error.message}</p>}
    </div>
  );
}

// The layouts Ledgerly has been taught, each with a way to forget it.
export function LearnedFormats() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ['ai-parsers'], queryFn: api.aiParsers });
  const forget = useMutation({ mutationFn: api.forgetParser, onSuccess: () => client.invalidateQueries({ queryKey: ['ai-parsers'] }) });
  const learned = state.data?.learned ?? [];
  if (learned.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium">Formats Ledgerly has learned</h2>
      <ul className="card divide-y divide-line">
        {learned.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 p-3 text-sm">
            <span>{l.bank} {l.kind === 'credit_card' ? 'card' : 'account'} statements <span className="text-muted">· learned {fmtDate(l.learnedAt.slice(0, 10))}</span></span>
            <button className="button-quiet" disabled={forget.isPending} onClick={() => forget.mutate(l.id)}>Forget</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
