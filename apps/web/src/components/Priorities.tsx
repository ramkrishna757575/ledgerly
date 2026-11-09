import { Link } from '@tanstack/react-router';
import type { AnalysisRun } from '../api.ts';

const PAGE_NAMES: Record<string, string> = {
  transactions: 'Transactions', rules: 'Rules', import: 'Import', accounts: 'Accounts', investments: 'Investments', assets: 'Other assets',
  bills: 'Bills', budgets: 'Budgets', goals: 'Goals', loans: 'Loans and insurance', tax: 'Tax', forecast: 'Forecast', settings: 'Settings',
};

// What to do first, each with a button to the page where it can be done.
export function Priorities({ items, limit }: { items: NonNullable<AnalysisRun['result']>['priorities']; limit?: number }) {
  return (
    <ol className="flex flex-col gap-2">
      {items.slice(0, limit).map((p, i) => (
        <li key={i} className="flex flex-col gap-1 rounded-md border border-line p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <p className="font-medium">{i + 1}. {p.title}</p>
            {p.why && <p className="mt-1 text-muted">{p.why}</p>}
            {p.steps.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-5">{p.steps.slice(0, limit ? 3 : undefined).map((step, j) => <li key={j}>{step}</li>)}</ul>}
          </div>
          {p.open && PAGE_NAMES[p.open] && (
            <Link to={`/${p.open}` as never} className="button-quiet mt-1 shrink-0 whitespace-nowrap sm:mt-0">Open {PAGE_NAMES[p.open]}</Link>
          )}
        </li>
      ))}
    </ol>
  );
}
