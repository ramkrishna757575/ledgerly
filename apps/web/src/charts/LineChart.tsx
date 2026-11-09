import { formatAmount } from '@ledgerly/core/money';
import { useState, type PointerEvent } from 'react';
import { formatCompact, niceTicks } from '../format.ts';
import { Tooltip, type TipRow } from './Tooltip.tsx';
import { useWidth } from './useWidth.ts';

export type LinePoint = { label: string; value: number; rows?: TipRow[] };

const MARGIN = { top: 28, right: 16, bottom: 30, left: 48 };

export function LineChart({
  points,
  label,
  height = 260,
  color = 'var(--viz-1)',
}: {
  points: LinePoint[];
  label: string;
  height?: number;
  color?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const count = points.length;
  const values = points.map((point) => point.value);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const low = ticks[0] ?? 0;
  const high = ticks.at(-1) ?? 100;

  const px = (index: number) => MARGIN.left + (count < 2 ? innerW / 2 : (index / (count - 1)) * innerW);
  const py = (value: number) => MARGIN.top + innerH - ((value - low) / (high - low)) * innerH;
  const labelStep = Math.max(1, Math.ceil((count * 64) / Math.max(innerW, 1)));

  const line = points.map((point, i) => `${i === 0 ? 'M' : 'L'}${px(i)},${py(point.value)}`).join('');
  const area = count > 1 ? `${line}L${px(count - 1)},${py(0)}L${px(0)},${py(0)}Z` : '';

  function move(event: PointerEvent<SVGRectElement>) {
    const box = ref.current?.getBoundingClientRect();
    if (!box || count === 0) return;
    const fraction = (event.clientX - box.left - MARGIN.left) / Math.max(innerW, 1);
    const index = Math.min(count - 1, Math.max(0, Math.round(fraction * (count - 1))));
    setHover({ index, y: event.clientY - box.top });
  }

  const last = points.at(-1);
  const active = hover ? points[hover.index] : undefined;

  return (
    <div ref={ref} className="relative" style={{ minHeight: height }}>
      {width > 0 && count > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={py(tick)} y2={py(tick)} style={{ stroke: tick === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)' }} strokeWidth={1} />
              <text x={MARGIN.left - 8} y={py(tick)} textAnchor="end" dominantBaseline="middle" className="fill-muted text-[11px]">
                {formatCompact(tick)}
              </text>
            </g>
          ))}
          {points.map((point, i) =>
            (i % labelStep === 0 && count - 1 - i >= labelStep) || i === count - 1 ? (
              <text key={point.label} x={px(i)} y={height - 10} textAnchor={i === count - 1 ? 'end' : 'middle'} className="fill-muted text-[11px]">
                {point.label.replace(/ 20(\d\d)$/, " '$1")}
              </text>
            ) : null,
          )}
          {area && <path d={area} fill={color} opacity={0.1} />}
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover && (
            <line x1={px(hover.index)} x2={px(hover.index)} y1={MARGIN.top} y2={MARGIN.top + innerH} style={{ stroke: 'var(--viz-axis)' }} strokeWidth={1} />
          )}
          {/* The ring in the card colour keeps the dot legible where it meets the line. */}
          {last && (
            <>
              <circle cx={px(count - 1)} cy={py(last.value)} r={5} fill={color} style={{ stroke: 'var(--color-surface)' }} strokeWidth={2} />
              <text x={px(count - 1) - 8} y={py(last.value) - 12} textAnchor="end" className="fill-ink text-xs font-medium">
                {formatAmount(last.value)}
              </text>
            </>
          )}
          {active && hover && hover.index !== count - 1 && (
            <circle cx={px(hover.index)} cy={py(active.value)} r={5} fill={color} style={{ stroke: 'var(--color-surface)' }} strokeWidth={2} />
          )}
          <rect x={MARGIN.left} y={MARGIN.top} width={innerW} height={innerH} fill="transparent" onPointerMove={move} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hover && active && (
        <Tooltip
          x={px(hover.index)}
          y={hover.y}
          containerWidth={width}
          title={active.label}
          rows={active.rows ?? [{ color, label: 'Value', value: formatAmount(active.value) }]}
        />
      )}
    </div>
  );
}
