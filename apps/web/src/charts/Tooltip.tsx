export type TipRow = { color?: string; label: string; value: string };

// Values lead and names follow, and each row is keyed with a short stroke of its
// series colour. Text uses the ordinary ink colours, never the series colour.
export function Tooltip({
  x,
  y,
  containerWidth,
  title,
  rows,
}: {
  x: number;
  y: number;
  containerWidth: number;
  title: string;
  rows: TipRow[];
}) {
  const flip = x > containerWidth / 2;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 min-w-40 rounded-md border border-line bg-surface px-3 py-2 text-sm shadow-lg"
      style={{ left: x, top: y, transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -50%)` }}
    >
      <p className="mb-1 text-muted">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-2">
          {row.color && <span className="inline-block h-[3px] w-3 shrink-0 rounded" style={{ background: row.color }} />}
          <strong className="font-semibold">{row.value}</strong>
          <span className="text-muted">{row.label}</span>
        </p>
      ))}
    </div>
  );
}
