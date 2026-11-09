import { formatAmount } from '@ledgerly/core/money';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { api, fmtDate, type GroupBy } from '../api.ts';
import { ChartCard, Legend } from '../charts/ChartCard.tsx';
import { CompareChart } from '../charts/CompareChart.tsx';
import { assignSlots, OTHER } from '../charts/colors.ts';
import { ColumnChart, type ColumnSeries } from '../charts/ColumnChart.tsx';
import { HBarChart, type HBarItem } from '../charts/HBarChart.tsx';
import { LineChart } from '../charts/LineChart.tsx';
import { monthsBetween, presets } from '../ranges.ts';

const GROUPS: { id: GroupBy; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'fy', label: 'Financial year' },
];

const percent = (share: number) => (share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);

function Stat({ label, value }: { label: string; value?: string }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value ?? '…'}</p>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex overflow-hidden rounded-md border border-line text-sm">
      {options.map((option) => (
        <button
          key={option.id}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`px-3 py-1.5 whitespace-nowrap ${value === option.id ? 'bg-surface font-medium text-ink' : 'text-muted hover:text-ink'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Spending each month of this year beside the same months of last year.
function YearOnYear() {
  const year = new Date().getFullYear();
  const data = useQuery({ queryKey: ['year-on-year', year], queryFn: () => api.periods(`${year - 1}-01-01`, `${year}-12-31`, 'month') });
  if (!data.data || data.data.every((p) => p.expenses === 0)) return null;
  const byKey = new Map(data.data.map((p) => [p.key, p.expenses]));
  const monthNow = new Date().getMonth();
  const series = [
    { label: String(year - 1), color: 'var(--viz-other)', values: MONTH_NAMES.map((_, i) => byKey.get(`${year - 1}-${String(i + 1).padStart(2, '0')}`) ?? 0) },
    { label: String(year), color: 'var(--viz-1)', values: MONTH_NAMES.map((_, i) => (i <= monthNow ? (byKey.get(`${year}-${String(i + 1).padStart(2, '0')}`) ?? 0) : null)) },
  ];
  const sofar = series[1]!.values.reduce<number>((s, v) => s + (v ?? 0), 0);
  const before = series[0]!.values.slice(0, monthNow + 1).reduce<number>((s, v) => s + (v ?? 0), 0);
  return (
    <ChartCard
      title="Spending, this year and last"
      subtitle={before > 0 ? `${formatAmount(sofar)} so far, against ${formatAmount(before)} in the same months of ${year - 1}` : `By month, ${year - 1} and ${year}`}
      table={{ headers: ['Month', String(year - 1), String(year)], rows: MONTH_NAMES.map((m, i) => [m, formatAmount(series[0]!.values[i] ?? 0), series[1]!.values[i] === null ? '–' : formatAmount(series[1]!.values[i] ?? 0)]) }}
    >
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <CompareChart labels={MONTH_NAMES} series={series} label="Spending each month, this year against last year" />
    </ChartCard>
  );
}

export function ReportsPage() {
  const navigate = useNavigate();
  const options = useMemo(() => presets(), []);
  const today = options[0]!.to;
  const [rangeId, setRangeId] = useState('this-fy');
  const [custom, setCustom] = useState({ from: options[0]!.from, to: today });
  const [group, setGroup] = useState<GroupBy>('month');

  const selected = options.find((option) => option.id === rangeId);
  const { from, to } = selected ?? custom;
  const valid = from <= to;
  const keep = { placeholderData: keepPreviousData, enabled: valid };

  const overview = useQuery({ queryKey: ['report', 'overview', from, to], queryFn: () => api.overview(from, to), ...keep });
  const categories = useQuery({ queryKey: ['report', 'categories', from, to], queryFn: () => api.spendingByCategory(from, to), ...keep });
  const periods = useQuery({ queryKey: ['report', 'periods', from, to, group], queryFn: () => api.periods(from, to, group), ...keep });
  const trend = useQuery({ queryKey: ['report', 'trend', from, to, group], queryFn: () => api.categoryTrend(from, to, group), ...keep });
  const payees = useQuery({ queryKey: ['report', 'payees', from, to], queryFn: () => api.topPayees(from, to), ...keep });
  const months = Math.min(60, Math.max(2, monthsBetween(from, to)));
  const history = useQuery({ queryKey: ['report', 'net-worth', months, to], queryFn: () => api.netWorthHistory(months, to), ...keep });
  // Over all time, so a category keeps its colour whichever dates are chosen.
  const allTime = useQuery({ queryKey: ['report', 'categories-all-time'], queryFn: () => api.spendingByCategory('2000-01-01', today), staleTime: 5 * 60_000 });

  const queries = [overview, categories, periods, trend, payees, history];
  const busy = queries.some((query) => query.isPlaceholderData && query.isFetching);
  const failed = queries.find((query) => query.isError)?.error?.message;
  const noData = overview.data !== undefined && overview.data.income === 0 && overview.data.expenses === 0;
  const range = `${fmtDate(from)} to ${fmtDate(to)}`;

  const openCategory = (categoryId: number) =>
    navigate({ to: '/transactions', search: { account: categoryId, from, to } });

  const categoryItems = useMemo<HBarItem[]>(() => {
    const rows = categories.data ?? [];
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const items: HBarItem[] = rows.slice(0, 10).map((row) => ({
      key: row.categoryId,
      label: row.name,
      value: row.total,
      detail: percent(row.total / total),
      onClick: () => openCategory(row.categoryId),
    }));
    const rest = rows.slice(10);
    if (rest.length > 0) {
      const value = rest.reduce((sum, row) => sum + row.total, 0);
      items.push({ key: 'other', label: `Other (${rest.length} categories)`, value, detail: percent(value / total) });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.data, from, to]);

  // Months before the first transaction say nothing, so the charts start where the data does.
  const firstActive = useMemo(() => {
    const index = (periods.data ?? []).findIndex((row) => row.income > 0 || row.expenses > 0);
    return index < 0 ? 0 : index;
  }, [periods.data]);
  const visiblePeriods = (periods.data ?? []).slice(firstActive);
  const aligned = trend.data !== undefined && trend.data.periods.length === (periods.data ?? []).length;
  const skip = aligned ? firstActive : 0;
  const trendPeriods = (trend.data?.periods ?? []).slice(skip);

  const historyRows = history.data ?? [];
  const firstWorth = historyRows.findIndex((point) => point.netWorth !== 0 || point.assets !== 0 || point.liabilities !== 0);
  const visibleHistory = historyRows.slice(Math.max(0, firstWorth - 1));

  const trendSeries = useMemo<ColumnSeries[]>(() => {
    if (!trend.data) return [];
    const colors = assignSlots(trend.data.series.map((s) => s.categoryId), (allTime.data ?? []).map((c) => c.categoryId));
    const series: ColumnSeries[] = trend.data.series.map((s) => ({
      key: String(s.categoryId),
      label: s.name,
      color: colors.get(s.categoryId)!,
      values: s.values.slice(skip),
    }));
    if (trend.data.other.some((value) => value > 0)) {
      series.push({ key: 'other', label: 'Other', color: OTHER, values: trend.data.other.slice(skip) });
    }
    return series;
  }, [trend.data, allTime.data, skip]);

  const flowSeries: ColumnSeries[] = [
    { key: 'income', label: 'Income', color: 'var(--viz-1)', values: visiblePeriods.map((row) => row.income) },
    { key: 'expenses', label: 'Spending', color: 'var(--viz-2)', values: visiblePeriods.map((row) => row.expenses) },
  ];

  const uncategorized = overview.data?.uncategorized;
  const rate = overview.data?.savingsRate;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Reports</h1>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {[...options, { id: 'custom', label: 'Custom' }].map((option) => (
              <button
                key={option.id}
                aria-pressed={rangeId === option.id}
                onClick={() => setRangeId(option.id)}
                className={`rounded-md border px-3 py-1.5 text-sm whitespace-nowrap ${
                  rangeId === option.id ? 'border-accent bg-surface font-medium text-ink' : 'border-line text-muted hover:text-ink'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {rangeId === 'custom' && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="label">
              From
              <input className="field" type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label className="label">
              To
              <input className="field" type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </label>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">Group by</span>
          <Segmented label="Group by" options={GROUPS} value={group} onChange={setGroup} />
          <span className="text-sm text-muted">{range}</span>
        </div>
      </div>

      {failed && <p className="text-sm text-danger">{failed}</p>}
      {!valid && <p className="text-sm text-danger">The start date must be before the end date.</p>}

      <div className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-4 transition-opacity ${busy ? 'opacity-60' : ''}`}>
        <Stat label="Income" value={overview.data && formatAmount(overview.data.income)} />
        <Stat label="Spending" value={overview.data && formatAmount(overview.data.expenses)} />
        <Stat label="Saved" value={overview.data && formatAmount(overview.data.net)} />
        <Stat label="Savings rate" value={overview.data && (rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`)} />
      </div>

      {uncategorized && uncategorized.count > 0 && uncategorized.categoryId !== null && (
        <p className="card p-4 text-sm">
          <strong className="font-medium">
            {formatAmount(uncategorized.total)} across {uncategorized.count} transactions
          </strong>{' '}
          <span className="text-muted">are still uncategorised, so they are grouped together in the charts below. </span>
          <Link
            to="/transactions"
            search={{ account: uncategorized.categoryId, from, to }}
            className="text-accent underline"
          >
            Sort them out
          </Link>
        </p>
      )}

      {noData ? (
        <p className="card p-6 text-sm text-muted">There are no transactions in this period. Pick a wider range, or import a statement.</p>
      ) : (
        <>
          <ChartCard
            title="Income and spending"
            subtitle={`By ${GROUPS.find((g) => g.id === group)!.label.toLowerCase()}`}
            busy={busy}
            table={{
              headers: ['Period', 'Income', 'Spending', 'Saved'],
              rows: visiblePeriods.map((row) => [row.label, formatAmount(row.income), formatAmount(row.expenses), formatAmount(row.net)]),
            }}
          >
            <Legend items={flowSeries.map((s) => ({ label: s.label, color: s.color }))} />
            <ColumnChart periods={visiblePeriods} series={flowSeries} mode="grouped" label="Income and spending for each period" />
          </ChartCard>

          <YearOnYear />

          <div className="grid items-start gap-6 xl:grid-cols-2">
            <ChartCard
              title="Spending by category"
              subtitle="Select a category to see its transactions"
              busy={busy}
              table={{
                headers: ['Category', 'Spent', 'Share', 'Transactions'],
                rows: (categories.data ?? []).map((row) => [
                  row.name,
                  formatAmount(row.total),
                  percent(row.total / Math.max(1, (categories.data ?? []).reduce((s, r) => s + r.total, 0))),
                  row.transactions,
                ]),
              }}
            >
              {categoryItems.length === 0 ? <p className="text-sm text-muted">No spending in this period.</p> : <HBarChart items={categoryItems} />}
            </ChartCard>

            <ChartCard
              title="Biggest categories over time"
              subtitle="The top five, with the rest together"
              busy={busy}
              table={{
                headers: ['Period', ...trendSeries.map((s) => s.label)],
                rows: trendPeriods.map((period, i) => [
                  period.label,
                  ...trendSeries.map((s) => formatAmount(s.values[i] ?? 0)),
                ]),
              }}
            >
              <Legend items={trendSeries.map((s) => ({ label: s.label, color: s.color }))} />
              <ColumnChart periods={trendPeriods} series={trendSeries} mode="stacked" label="Spending by category for each period" />
            </ChartCard>
          </div>

          <ChartCard
            title="Net worth"
            subtitle="What you have minus what you owe, at the end of each month"
            busy={busy}
            table={{
              headers: ['Month end', 'Assets', 'Owed', 'Net worth'],
              rows: visibleHistory.map((point) => [point.label, formatAmount(point.assets), formatAmount(point.liabilities), formatAmount(point.netWorth)]),
            }}
          >
            <LineChart
              label="Net worth at the end of each month"
              points={visibleHistory.map((point) => ({
                label: point.label,
                value: point.netWorth,
                rows: [
                  { color: 'var(--viz-1)', label: 'Net worth', value: formatAmount(point.netWorth) },
                  { label: 'Assets', value: formatAmount(point.assets) },
                  { label: 'Owed', value: formatAmount(point.liabilities) },
                ],
              }))}
            />
          </ChartCard>

          <ChartCard
            title="Where the money went"
            subtitle="Your biggest payees"
            busy={busy}
            table={{
              headers: ['Payee', 'Spent', 'Transactions'],
              rows: (payees.data ?? []).map((row) => [row.name, formatAmount(row.total), row.transactions]),
            }}
          >
            {(payees.data ?? []).length === 0 ? (
              <p className="text-sm text-muted">No spending in this period.</p>
            ) : (
              <HBarChart items={(payees.data ?? []).map((row) => ({ key: row.name, label: row.name, value: row.total, detail: `${row.transactions}×` }))} />
            )}
          </ChartCard>
        </>
      )}
    </div>
  );
}
