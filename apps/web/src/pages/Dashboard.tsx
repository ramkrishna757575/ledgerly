import { formatAmount } from '@ledgerly/core/money';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, isMoneyAccount } from '../api.ts';
import { GettingStarted } from '../components/GettingStarted.tsx';
import { Hint } from '../components/Hint.tsx';
import { Attention } from '../components/Attention.tsx';
import { CheckIn } from '../components/CheckIn.tsx';
import { owedLabel } from '../plain.ts';

function monthRange(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay)}`,
    label: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
  };
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        {value === undefined ? '…' : formatAmount(value)}
      </p>
    </div>
  );
}

export function DashboardPage() {
  const { from, to, label } = monthRange();
  const netWorth = useQuery({ queryKey: ['net-worth'], queryFn: api.netWorth });
  const cashFlow = useQuery({
    queryKey: ['cash-flow', from, to],
    queryFn: () => api.cashFlow(from, to),
  });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const moneyAccounts = accounts.data?.filter(isMoneyAccount) ?? [];

  if (netWorth.isError) return <p className="text-sm text-danger">{netWorth.error.message}</p>;

  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className="text-sm text-muted">Net worth</p>
        <p className="mt-1 text-4xl font-semibold tracking-tight">
          {netWorth.data ? formatAmount(netWorth.data.netWorth) : '…'}
        </p>
        <p className="mt-2 text-sm text-muted">
          {netWorth.data &&
            `${formatAmount(netWorth.data.assets)} in assets, ${formatAmount(netWorth.data.liabilities)} owed`}
        </p>
        <div className="mt-2">
          <Hint title="What is net worth?">
            <p>Everything you own (bank balances, cash, mutual funds, deposits) minus everything you owe (credit card balances, loans).</p>
            <p>Spending on a credit card lowers it straight away, because you owe more. Paying the card bill does not change it. A market rise in your funds raises it without any transaction.</p>
          </Hint>
        </div>
      </section>

      <nav aria-label="Common tasks" className="flex flex-wrap gap-2">
        <Link to="/add" className="button">Add a transaction</Link>
        <Link to="/import" className="button-quiet">Import statements</Link>
        <Link to="/ask" search={{ q: 'What looks odd in my spending lately?' } as never} className="button-quiet">What looks odd?</Link>
        <Link to="/ask" search={{ q: 'Which of my bills went up?' } as never} className="button-quiet">Which bills went up?</Link>
        <Link to="/ask" className="button-quiet">Ask the coach</Link>
        <Link to="/budgets" className="button-quiet">Budgets</Link>
      </nav>

      <GettingStarted />

      <Attention />

      <CheckIn />

      <section>
        <h2 className="mb-3 font-medium">{label}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Income" value={cashFlow.data?.income} />
          <Stat label="Spending" value={cashFlow.data?.expenses} />
          <Stat label="Saved" value={cashFlow.data?.net} />
        </div>
        <div className="mt-2">
          <Hint title="How are these worked out?">
            <p><strong>Income</strong> is salary, interest and other money coming in. <strong>Spending</strong> is what you used up, including card purchases. <strong>Saved</strong> is income minus spending, so money you put into a SIP counts as saved.</p>
            <p>Paying a card bill, repaying a loan and moving money between your own accounts are not spending.</p>
          </Hint>
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-medium">Accounts and cards</h2>
        {accounts.isSuccess && moneyAccounts.length === 0 ? (
          <div className="card p-6 text-sm text-muted">
            No accounts yet.{' '}
            <Link to="/accounts" className="text-accent underline">
              Add your first account or card
            </Link>{' '}
            to start tracking.
          </div>
        ) : (
          <ul className="card divide-y divide-line">
            {moneyAccounts.map((account) => (
              <li key={account.id} className="flex justify-between gap-4 p-4 text-sm">
                <span className="min-w-0 truncate">{account.name}</span>
                <span>
                  {formatAmount(owedLabel(account.type, account.balance)?.amount ?? account.balance, account.currency)}
                  {owedLabel(account.type, account.balance) && <span className="ml-1 text-xs text-muted">{owedLabel(account.type, account.balance)!.word}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
