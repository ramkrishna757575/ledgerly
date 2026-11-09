import { formatAmount } from '@ledgerly/core/money';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate } from '../api.ts';
import { LineChart } from '../charts/LineChart.tsx';

const rupees = (paise: number) => formatAmount(paise).replace(/\.00$/, '');

export function ForecastPage() {
  const [days, setDays] = useState(60);
  const data = useQuery({ queryKey: ['forecast', days], queryFn: () => api.forecast(days) });
  const f = data.data;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Forecast</h1>
        <label className="flex items-center gap-2 text-sm text-muted">
          Look ahead
          <select className="field" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[30, 60, 90, 180].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
      </header>
      <p className="text-sm text-muted">
        Where your bank balance is heading if the next weeks look like the past: income and bills on the days they usually arrive, and the rest of your usual spending spread evenly. A credit card bill counts on the due date of its latest statement; spending on the card since then is not included. It is an estimate, not a promise.
      </p>

      {f && (
        <>
          <div className="grid grid-cols-3 gap-3">
            {[
              ['Today', rupees(f.start), ''],
              [`In ${f.days} days`, rupees(f.end), ''],
              ['Lowest point', rupees(f.lowest.balance), fmtDate(f.lowest.date)],
            ].map(([label, value, note]) => (
              <div key={label} className="card p-4">
                <p className="text-xs text-muted">{label}</p>
                <p className={`mt-1 text-lg font-semibold tabular-nums ${value!.startsWith('-') || value!.startsWith('−') ? 'text-danger' : ''}`}>{value}</p>
                {note && <p className="text-xs text-muted">{note}</p>}
              </div>
            ))}
          </div>

          {f.firstBelowZero && (
            <p className="card border-danger p-4 text-sm">
              <span className="font-medium">The balance goes below zero around {fmtDate(f.firstBelowZero)}.</span> Move money in before then, or check what is due.
            </p>
          )}
          {!f.includesEverydaySpending && <p className="text-sm text-muted">There is not enough history to estimate everyday spending yet, so this only counts recurring bills and income and may be too optimistic.</p>}

          <section className="card p-4">
            <LineChart label="Projected bank balance" points={f.points.map((p) => ({ label: fmtDate(p.date), value: p.balance }))} />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-medium">What is expected</h2>
            {f.events.length === 0 ? (
              <p className="text-sm text-muted">No recurring bills or income found yet. They appear once a payment has repeated three times.</p>
            ) : (
              <ul className="card divide-y divide-line text-sm">
                {f.events.map((e, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 p-3">
                    <span className="min-w-0 truncate"><span className="text-muted">{fmtDate(e.date)} · </span>{e.label}</span>
                    <span className={`tabular-nums ${e.amount > 0 ? 'text-accent' : ''}`}>{e.amount > 0 ? '+' : '−'}{rupees(Math.abs(e.amount))}</span>
                  </li>
                ))}
              </ul>
            )}
            {f.everydaySpendingPerMonth > 0 && <p className="text-xs text-muted">Plus about {rupees(f.everydaySpendingPerMonth)} a month of everyday spending, spread evenly.</p>}
          </section>
        </>
      )}
      {data.error && <p className="text-sm text-danger">{data.error.message}</p>}
    </div>
  );
}
