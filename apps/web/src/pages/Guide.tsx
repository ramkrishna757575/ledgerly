import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

function Scenario({ title, children, result }: { title: string; children: ReactNode; result: string[] }) {
  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">{title}</h2>
      <div className="flex flex-col gap-2 text-sm text-muted">{children}</div>
      <ul className="flex flex-col gap-1 border-t border-line pt-3 text-sm">
        {result.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="text-accent">›</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const TERMS: [string, string][] = [
  ['Asset', 'Something you own that has value: money in the bank, cash, mutual funds, gold, a deposit.'],
  ['Liability', 'Something you owe: a credit card balance, a loan. It is shown as "owed".'],
  ['Net worth', 'What you own minus what you owe. It moves when you earn, spend, repay, or when your investments change in value.'],
  ['Spending', 'Money that left for something you used up: food, travel, bills. Moving money between your own accounts is not spending.'],
  ['Category', 'The label that groups spending or income, like Groceries or Salary. Reports are built from these.'],
  ['SIP', 'A standing instruction that buys a fixed amount of a mutual fund every month.'],
  ['Units and NAV', 'A fund is divided into units. NAV is the price of one unit today. Your value is units times NAV.'],
  ['Invested and Gain', 'Invested is what you put in. Gain is what it is worth now minus that. A gain you have not sold is "unrealised": it can go up or down.'],
  ['XIRR', 'Your yearly return, adjusted for when each SIP instalment went in. Better than a plain percentage when you add money every month.'],
  ['Opening balance', 'What an account held when you started using Ledgerly, so today\'s balance matches your bank.'],
];

export function GuidePage() {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">How your money shows up here</h1>
        <p className="text-sm text-muted">
          What Ledgerly shows for the everyday things you do, and why. The amounts are examples.
        </p>
      </header>

      <Scenario
        title="You buy something with your credit card"
        result={[
          'Spending goes up by ₹2,000, under the category (Food, Shopping, and so on).',
          'The card shows ₹2,000 more owed.',
          'Your bank balance does not change yet.',
          'Net worth goes down by ₹2,000, because you owe more.',
        ]}
      >
        <p>You order dinner for ₹2,000 on your card. The money has not left your bank, but you have used it, and now you owe the card company.</p>
      </Scenario>

      <Scenario
        title="You pay the credit card bill"
        result={[
          'Your bank balance goes down by ₹10,000, and the card owes ₹10,000 less.',
          'Spending does not change. It is labelled "Card bill payment".',
          'Net worth does not change: you gave up ₹10,000 of money and owe ₹10,000 less.',
        ]}
      >
        <p>This is the one that confuses most people. The spending was already counted when you used the card, so paying the bill only settles it. If it were counted as spending too, every purchase would be counted twice.</p>
        <p>When you import both your bank and card statements, Ledgerly recognises the payment on both sides and records it once.</p>
      </Scenario>

      <Scenario
        title="You get your salary"
        result={[
          'Your bank balance goes up.',
          'Income goes up, under Salary.',
          'Net worth goes up by the same amount.',
          'Saved this month is income minus spending, so it rises too.',
        ]}
      >
        <p>Your employer takes tax and provident fund before paying you, so only the rest reaches your bank. To see the full picture, add your payslip on the Import page: the full pay is counted as income, the tax is shown as tax paid, and the provident fund counts as money you are saving. The bank statement that shows the credit later takes that entry over, so it is not counted twice.</p>
      </Scenario>

      <Scenario
        title="Your Scripbox SIP goes out each month"
        result={[
          'Your bank balance goes down by the SIP amount (say ₹5,000).',
          'Mutual funds, an asset, goes up by ₹5,000. It is labelled "Investment", not spending.',
          'Net worth does not change when the money goes in.',
          'It changes later, as the fund price moves.',
        ]}
      >
        <p>A SIP is saving, not spending. The money has moved from the bank into something you own.</p>
        <p>On the Investments page, <strong>Invested</strong> is everything you put in, <strong>Worth today</strong> is units times today's price, and <strong>Gain</strong> is the difference. When prices change, Worth today and net worth change with no transaction at all. Update prices fetches today's from AMFI, or import your latest Scripbox or CDSL statement.</p>
      </Scenario>

      <Scenario
        title="Interest, charges and refunds"
        result={[
          'Bank interest is income. Bank charges are spending.',
          'A refund brings money back in under the same category as the purchase, so spending for that category goes down.',
        ]}
      >
        <p>These come in with your statements. If one is under the wrong category, change it on the Transactions page and Ledgerly offers to fix others from the same shop.</p>
      </Scenario>

      <section className="card flex flex-col gap-3 p-4">
        <h2 className="font-medium">A good way to start</h2>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted">
          <li>Add your accounts and credit cards on <Link to="/accounts" className="text-accent underline">Accounts and cards</Link>, with today's balance (or the amount owed).</li>
          <li>Import your last few statements on <Link to="/import" className="text-accent underline">Import</Link>. You review them before anything is added, and you can undo an import.</li>
          <li>Check the categories on <Link to="/transactions" className="text-accent underline">Transactions</Link>. After a few changes Ledgerly starts suggesting rules.</li>
          <li>Set a monthly limit for the categories you care about on <Link to="/budgets" className="text-accent underline">Budgets</Link>.</li>
        </ol>
      </section>

      <section className="card flex flex-col gap-3 p-4">
        <h2 className="font-medium">Words you will see</h2>
        <dl className="flex flex-col gap-3 text-sm">
          {TERMS.map(([term, meaning]) => (
            <div key={term}>
              <dt className="font-medium">{term}</dt>
              <dd className="text-muted">{meaning}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="text-xs text-muted">Ledgerly records and explains your money. It does not give investment advice or move money for you.</p>
    </div>
  );
}
