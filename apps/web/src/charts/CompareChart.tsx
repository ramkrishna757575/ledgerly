import { formatAmount } from '@ledgerly/core/money';
import { useState, type PointerEvent } from 'react';
import { formatCompact, niceTicks } from '../format.ts';
import { Tooltip } from './Tooltip.tsx';
import { useWidth } from './useWidth.ts';

export type CompareSeries = { label: string; color: string; values: (number | null)[] };

const MARGIN = { top: 16, right: 16, bottom: 30, left: 48 };

// Two lines over the same months, such as this year against last. A month with
// no value yet (the rest of this year) is simply not drawn.
export function CompareChart({ labels, series, label, height = 260 }: { labels: string[]; series: CompareSeries[]; label: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);
  const count = labels.length;
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(0, Math.max(0, ...all));
  const high = ticks.at(-1) ?? 100;
  const px = (i: number) => MARGIN.left + (count < 2 ? innerW / 2 : (i / (count - 1)) * innerW);
  const py = (v: number) => MARGIN.top + innerH - (v / high) * innerH;

  function move(event: PointerEvent<SVGRectElement>) {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const fraction = (event.clientX - box.left - MARGIN.left) / Math.max(innerW, 1);
    setHover({ index: Math.min(count - 1, Math.max(0, Math.round(fraction * (count - 1)))), y: event.clientY - box.top });
  }

  const path = (values: (number | null)[]) =>
    values.reduce<string>((d, v, i) => (v === null ? d : `${d}${d === '' || values[i - 1] === null || values[i - 1] === undefined ? 'M' : 'L'}${px(i)},${py(v)}`), '');

  return (
    <div ref={ref} className="relative" style={{ minHeight: height }}>
      {width > 0 && count > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={py(tick)} y2={py(tick)} style={{ stroke: tick === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)' }} strokeWidth={1} />
              <text x={MARGIN.left - 8} y={py(tick)} textAnchor="end" dominantBaseline="middle" className="fill-muted text-[11px]">{formatCompact(tick)}</text>
            </g>
          ))}
          {labels.map((l, i) => (
            <text key={l} x={px(i)} y={height - 10} textAnchor="middle" className="fill-muted text-[11px]">{l}</text>
          ))}
          {series.map((s) => (
            <path key={s.label} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover && (
            <>
              <line x1={px(hover.index)} x2={px(hover.index)} y1={MARGIN.top} y2={MARGIN.top + innerH} style={{ stroke: 'var(--viz-axis)' }} strokeWidth={1} />
              {series.map((s) => {
                const v = s.values[hover.index];
                return v === null || v === undefined ? null : <circle key={s.label} cx={px(hover.index)} cy={py(v)} r={5} fill={s.color} style={{ stroke: 'var(--color-surface)' }} strokeWidth={2} />;
              })}
            </>
          )}
          <rect x={MARGIN.left} y={MARGIN.top} width={innerW} height={innerH} fill="transparent" onPointerMove={move} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hover && (
        <Tooltip
          x={px(hover.index)}
          y={hover.y}
          containerWidth={width}
          title={labels[hover.index]!}
          rows={series.map((s) => ({ color: s.color, label: s.label, value: s.values[hover.index] === null || s.values[hover.index] === undefined ? '–' : formatAmount(s.values[hover.index]!) }))}
        />
      )}
    </div>
  );
}
