import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type AskResult } from '../api.ts';
import { CoachTabs } from '../components/CoachTabs.tsx';

type Turn = { question: string; result: AskResult };

const TOOL_NAMES: Record<string, string> = {
  get_accounts: 'Accounts', list_categories: 'Categories', search_transactions: 'Transactions', get_overview: 'Overview', spending_by_category: 'Spending by category',
  spending_over_time: 'Spending over time', category_trend: 'Category trends', top_payees: 'Top payees', net_worth_history: 'Net worth history', get_investments: 'Investments',
  get_insights: 'What needs attention', get_budgets: 'Budgets', get_recurring_payments: 'Bills', get_financial_review: 'Idle cash and portfolio', get_other_assets: 'Other assets',
  get_forecast: 'Forecast', get_tax_summary: 'Tax', get_goals: 'Goals', get_loans_and_insurance: 'Loans and insurance', get_anomalies: 'Odd spending', list_rules: 'Rules',
};

const EXAMPLES = ['Where did most of my money go last month?', 'Why was last month more expensive than usual?', 'What is sitting in Uncategorized?', 'Which bills and subscriptions repeat every month?', 'Am I saving enough?', 'What looks odd in my spending lately?', 'Which of my bills went up?'];

export function AskPage() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ['ask-state'], queryFn: api.askState });
  const toggle = useMutation({ mutationFn: api.setAsk, onSuccess: () => client.invalidateQueries({ queryKey: ['ask-state'] }) });
  const [question, setQuestion] = useState(() => new URLSearchParams(window.location.search).get('q')?.slice(0, 500) ?? '');
  const [turns, setTurns] = useState<Turn[]>([]);
  const send = useMutation({
    mutationFn: (q: string) => api.ask(q, turns.map((t) => ({ question: t.question, answer: t.result.answer }))),
    onSuccess: (result, q) => {
      setTurns((all) => [...all, { question: q, result }]);
      setQuestion('');
    },
  });
  const data = state.data;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (question.trim()) send.mutate(question.trim());
  }

  if (!data) return null;
  if (!data.configured) {
    return (
      <div className="flex flex-col gap-4">
        <CoachTabs />
        <p className="card p-6 text-sm text-muted">Asking questions needs an AI provider. Add one under Settings, then come back.</p>
      </div>
    );
  }
  const where = data.destination?.local ? `stays on this machine (${data.destination.host})` : `goes to ${data.destination?.host}`;

  return (
    <div className="flex flex-col gap-6">
      <CoachTabs />
      <p className="text-sm text-muted">
        Ask about your money in plain words. The model looks things up with the same read-only tools an agent gets, one at a time, and answers from what they return. It cannot change anything.
      </p>

      <section className="card flex flex-col gap-2 p-4">
        <label className="flex items-start gap-2 text-sm">
          <input className="mt-1" type="checkbox" checked={data.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>
            I understand that what the lookups return (account names, payees, amounts, balances) is sent to the model, which {where}, and I want this on.
          </span>
        </label>
        <p className="text-xs text-muted">Each lookup is recorded on the Agents page under “Ask Ledgerly”. A model can be wrong: check anything important against the page it came from. This is not financial advice.</p>
      </section>

      {data.enabled && (
        <>
          <ul className="flex flex-col gap-4">
            {turns.map((t, i) => (
              <li key={i} className="card flex flex-col gap-2 p-4">
                <p className="text-sm font-medium">{t.question}</p>
                <p className="whitespace-pre-wrap text-sm">{t.result.answer}</p>
                {t.result.steps.length > 0 && (
                  <p className="text-xs text-muted">
                    Looked at: {[...new Set(t.result.steps.map((s) => TOOL_NAMES[s.tool] ?? s.tool))].join(', ')}
                    {t.result.stoppedEarly && ' · stopped looking early, so the answer may be incomplete'}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <textarea className="field min-h-20" aria-label="Your question" maxLength={500} placeholder="Ask a question…" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <div className="flex flex-wrap items-center gap-2">
              <button className="button" disabled={send.isPending || !question.trim()}>{send.isPending ? 'Looking…' : 'Ask'}</button>
              {turns.length === 0 && EXAMPLES.map((e) => <button key={e} type="button" className="button-quiet text-left" onClick={() => setQuestion(e)}>{e}</button>)}
              {turns.length > 0 && <button type="button" className="button-quiet" onClick={() => setTurns([])}>Start over</button>}
            </div>
            {send.error && <p className="text-sm text-danger">{send.error.message}</p>}
          </form>
        </>
      )}
    </div>
  );
}
