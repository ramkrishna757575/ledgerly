import { formatAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate } from '../api.ts';

const pct = (rate: number) => `${Number((rate * 100).toFixed(1))}%`;
const rupees = (paise: number) => formatAmount(paise).replace(/\.00$/, '');
const SECTION_NAMES: Record<string, string> = { '80C': '80C', '80CCD1B': '80CCD(1B)', '80D': '80D', '80G': '80G', '24b': '24(b)' };

function fyOptions() {
  const now = new Date();
  const current = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return [current, current - 1, current - 2, current - 3].map((y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`);
}

export function TaxPage() {
  const client = useQueryClient();
  const [fy, setFy] = useState(fyOptions()[0]!);
  const data = useQuery({ queryKey: ['tax', fy], queryFn: () => api.tax(fy) });
  const [showSales, setShowSales] = useState(false);
  const save = useMutation({ mutationFn: api.setTaxSections, onSuccess: () => client.invalidateQueries({ queryKey: ['tax'] }) });
  const t = data.data;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Tax</h1>
        <label className="flex items-center gap-2 text-sm text-muted">
          Financial year
          <select className="field" value={fy} onChange={(e) => setFy(e.target.value)}>
            {fyOptions().map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </header>
      <div>
        <a className="button" href={`/api/export/tax-pack.xlsx?fy=${fy}`} download>Download the tax pack for {fy} (Excel)</a>
        <p className="mt-1 text-xs text-muted">One workbook for your accountant: a summary, mutual fund sales, deposit interest, interest received, deductions and tax paid, with the lines behind each total.</p>
      </div>
      <p className="text-sm text-muted">
        An estimate to plan with, worked out from your own records using today's rules, which change. It is not a tax return and not advice: check it with a chartered accountant before you file.
      </p>

      {t && (
        <>
          <section className="card flex flex-col gap-4 p-4">
            <h2 className="font-medium">Mutual fund gains sold in {t.fy}</h2>
            {t.gains.sales.length === 0 && t.gains.unmatchedProceeds === 0 ? (
              <p className="text-sm text-muted">No sales found in your imported statements for this year.</p>
            ) : (
              <>
                <dl className="divide-y divide-line text-sm">
                  {[
                    ['Equity funds, held up to 12 months', rupees(t.gains.equity.shortTermGain), `taxed at ${pct(t.gains.equity.shortTermRate)}`],
                    ['Equity funds, held over 12 months', rupees(t.gains.equity.longTermGain), `${rupees(t.gains.equity.longTermExempt)} of it is under the ${rupees(t.gains.equity.exemption)} yearly exemption, the rest is taxed at ${pct(t.gains.equity.longTermRate)}`],
                    ['Other funds (debt, gold, hybrid)', rupees(t.gains.other.gain), 'taxed in ways that depend on when bought and what the fund holds, often at your slab rate'],
                  ].map(([label, value, note]) => (
                    <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
                      <dt><span className="font-medium">{label}</span><span className="block text-xs text-muted">{note}</span></dt>
                      <dd className="tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-sm">Estimated tax on the equity part: <span className="font-medium">{rupees(t.gains.equity.estimatedTax)}</span> <span className="text-muted">(before cess and surcharge)</span></p>
                {t.gains.equity.lossToCarryForward > 0 && <p className="text-sm text-muted">A loss of {rupees(t.gains.equity.lossToCarryForward)} can be carried forward for 8 years if you file on time.</p>}
              </>
            )}
            {!t.gains.complete && (
              <p className="rounded-md border border-line p-3 text-sm">
                <span className="font-medium">Some of this is missing.</span> {rupees(t.gains.unmatchedProceeds)} of sales are of units bought before your earliest imported statement, so their cost is unknown and they are left out. Import older statements to complete it.
              </p>
            )}
            {t.gains.sales.length > 0 && (
              <div>
                <a className="button-quiet mr-2" href={`/api/export/capital-gains.csv?fy=${t.fy}`} download>Download for filing (CSV)</a>
                <button className="button-quiet" aria-expanded={showSales} onClick={() => setShowSales(!showSales)}>{showSales ? 'Hide' : 'Show'} {t.gains.sales.length} sales</button>
                {showSales && (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-muted"><th className="py-1 pr-3 font-normal">Sold</th><th className="py-1 pr-3 font-normal">Fund</th><th className="py-1 pr-3 text-right font-normal">Held</th><th className="py-1 pr-3 text-right font-normal">Cost</th><th className="py-1 pr-3 text-right font-normal">Sold for</th><th className="py-1 text-right font-normal">Gain</th></tr></thead>
                      <tbody className="divide-y divide-line">
                        {t.gains.sales.map((s, i) => (
                          <tr key={i}>
                            <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(s.date)}</td>
                            <td className="max-w-56 truncate py-2 pr-3" title={s.fund}>{s.fund}</td>
                            <td className="py-2 pr-3 text-right whitespace-nowrap">{s.heldDays} days ({s.term})</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{rupees(s.cost)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{rupees(s.proceeds)}</td>
                            <td className={`py-2 text-right tabular-nums ${s.gain < 0 ? 'text-danger' : ''}`}>{rupees(s.gain)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>

          {t.fdInterest.items.length > 0 && (
            <section className="card flex flex-col gap-3 p-4">
              <h2 className="font-medium">Fixed deposit interest, {t.fy}</h2>
              <ul className="divide-y divide-line text-sm">
                {t.fdInterest.items.map((i) => (
                  <li key={i.name} className="flex flex-wrap justify-between gap-2 py-2">
                    <span><span className="font-medium">{i.name}</span> <span className="text-muted">{(i.rateBps / 100).toFixed(2)}% on {rupees(i.principal)}, {fmtDate(i.from)} to {fmtDate(i.to)}</span></span>
                    <span className="tabular-nums">{rupees(i.interest)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-sm">Total <span className="font-medium">{rupees(t.fdInterest.total)}</span>{t.fdInterest.upToToday && ' so far this year'}</p>
              <p className="text-xs text-muted">
                Interest is taxed as income at your slab rate, whether or not it has been paid out. Banks deduct TDS once a year's interest passes {rupees(t.fdInterest.tdsLimit)} at one bank
                {t.fdInterest.overTdsLimit ? '; this total is over that, so expect TDS and check it against Form 26AS' : ''}. TDS is not tracked here.
              </p>
            </section>
          )}

          <section className="card flex flex-col gap-4 p-4">
            <h2 className="font-medium">Deductions used, {t.fy}</h2>
            <p className="text-sm text-muted">Only the old tax regime allows these. Tell Ledgerly which of your spending categories belong to which section, below.</p>
            <ul className="flex flex-col gap-3">
              {t.deductions.map((d) => (
                <li key={d.section} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{d.label}</span>
                    <span className="text-muted">{rupees(d.total)}{d.limit !== null && ` of ${rupees(d.limit)}`}{d.room !== null && d.room > 0 && ` · ${rupees(d.room)} room left`}</span>
                  </div>
                  {d.limit !== null && (
                    <div className="h-2 rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round((d.total / d.limit) * 100))} aria-label={`${d.section} used`}>
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, (d.total / d.limit) * 100)}%`, background: 'var(--color-accent)' }} />
                    </div>
                  )}
                  {d.parts.length > 0 && <p className="text-xs text-muted">{d.parts.map((p) => `${p.source} ${rupees(p.amount)}`).join(' · ')}</p>}
                </li>
              ))}
            </ul>
          </section>

          <section className="card flex flex-col gap-3 p-4">
            <h2 className="font-medium">Which category counts toward which section</h2>
            <ul className="grid gap-x-8 gap-y-2 lg:grid-cols-2">
              {t.categories.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm">
                  <span className="min-w-0 flex-1">{c.name}</span>
                  <select
                    className="field w-40 shrink-0"
                    aria-label={`Section for ${c.name}`}
                    value={t.map[String(c.id)] ?? ''}
                    disabled={save.isPending}
                    onChange={(e) => save.mutate({ ...t.map, [String(c.id)]: e.target.value || null })}
                  >
                    <option value="">Not counted</option>
                    {Object.entries(SECTION_NAMES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">Spending on a category in a financial year is counted in full, so assign only categories that are entirely deductible. Purchases of tax-saving (ELSS) funds count toward 80C automatically.</p>
          </section>
        </>
      )}
      {data.error && <p className="text-sm text-danger">{data.error.message}</p>}
    </div>
  );
}
