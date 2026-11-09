import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const label = (month: string) => `${SHORT[Number(month.slice(5, 7)) - 1]} ${month.slice(2, 4)}`;

const LOOK = {
  covered: { cell: 'bg-accent text-accent-ink', text: 'imported' },
  partial: { cell: 'border border-accent text-ink', text: 'partly covered' },
  gap: { cell: 'border border-dashed border-danger text-danger', text: 'no statement' },
} as const;

// Which months each account has statements for, so a missing one is easy to spot.
export function Coverage() {
  const coverage = useQuery({ queryKey: ['coverage'], queryFn: api.coverage });
  if (!coverage.data || coverage.data.length === 0) return null;
  return (
    <section className="card flex flex-col gap-3 p-4">
      <header>
        <h2 className="font-medium">Statements imported, by month</h2>
        <p className="mt-1 text-sm text-muted">
          A filled month is fully covered by statements you have imported. A dashed red one has none: import it, or your balances and reports for that month will be incomplete.
        </p>
      </header>
      <div className="flex flex-col gap-4">
        {coverage.data.map((account) => (
          <div key={account.accountId} className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              {account.accountName}
              {account.missing.length > 0 && <span className="ml-2 text-xs font-normal text-danger">{account.missing.length} {account.missing.length === 1 ? 'month' : 'months'} missing</span>}
            </p>
            <ul className="flex flex-wrap gap-1" aria-label={`${account.accountName} statements by month`}>
              {account.months.map((month) => (
                <li
                  key={month.month}
                  title={`${label(month.month)}: ${LOOK[month.state].text}`}
                  className={`rounded px-2 py-1 text-xs ${LOOK[month.state].cell}`}
                >
                  <span className="sr-only">{LOOK[month.state].text}: </span>
                  {label(month.month)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
