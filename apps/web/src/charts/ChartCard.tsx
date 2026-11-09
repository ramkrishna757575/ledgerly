import { useState, type ReactNode } from 'react';

export type TableData = { headers: string[]; rows: (string | number)[][] };

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ headers, rows }: TableData) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            {headers.map((header, index) => (
              <th key={header} className={`py-2 pr-4 font-normal ${index > 0 ? 'text-right' : ''}`}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line last:border-0">
              {row.map((cell, index) => (
                <td key={index} className={`py-2 pr-4 ${index > 0 ? 'text-right tabular-nums' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Every chart has a table twin, so no value depends on colour or on hovering.
export function ChartCard({
  title,
  subtitle,
  table,
  busy,
  children,
}: {
  title: string;
  subtitle?: string;
  table: TableData;
  busy?: boolean;
  children: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section className={`card p-4 transition-opacity ${busy ? 'opacity-60' : ''}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">{title}</h2>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        <div role="group" aria-label={`${title} view`} className="flex overflow-hidden rounded-md border border-line text-sm">
          {(['chart', 'table'] as const).map((option) => (
            <button
              key={option}
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={`px-3 py-1 capitalize ${view === option ? 'bg-page text-ink' : 'text-muted hover:text-ink'}`}
            >
              {option}
            </button>
          ))}
        </div>
      </header>
      {view === 'chart' ? children : <DataTable {...table} />}
    </section>
  );
}
