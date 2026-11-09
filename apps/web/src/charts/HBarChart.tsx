import { formatAmount } from '@ledgerly/core/money';

export type HBarItem = {
  key: string | number;
  label: string;
  value: number;
  // Shown after the value, such as a share or a count.
  detail?: string;
  onClick?: () => void;
};

// Nominal categories get one colour: length already shows the amount, so a
// colour ramp on top would say the same thing twice.
export function HBarChart({ items }: { items: HBarItem[] }) {
  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => {
        const percent = (item.value / max) * 100;
        const row = (
          <>
            <span className="truncate text-left text-sm" title={item.label}>
              {item.label}
            </span>
            {/* The right padding keeps room for the value after the longest bar. */}
            <span className="block h-6 pr-32">
              <span className="relative block h-full">
                <span
                  className="absolute inset-y-1 left-0"
                  style={{ width: `max(${percent}%, 2px)`, background: 'var(--viz-1)', borderRadius: '0 4px 4px 0' }}
                />
                <span className="absolute top-1/2 -translate-y-1/2 text-sm whitespace-nowrap" style={{ left: `calc(${percent}% + 8px)` }}>
                  {formatAmount(item.value)}
                  {item.detail && <span className="text-muted"> · {item.detail}</span>}
                </span>
              </span>
            </span>
          </>
        );
        const layout = 'grid w-full grid-cols-[minmax(0,8.5rem)_1fr] items-center gap-3 rounded-md px-1';
        return (
          <li key={item.key}>
            {item.onClick ? (
              <button className={`${layout} hover:bg-page`} onClick={item.onClick}>
                {row}
              </button>
            ) : (
              <div className={layout}>{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
