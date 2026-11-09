import { formatAmount } from '@ledgerly/core/money';
import { useState, type PointerEvent } from 'react';
import { formatCompact, niceTicks } from '../format.ts';
import { Tooltip } from './Tooltip.tsx';
import { useWidth } from './useWidth.ts';

export type ColumnSeries = { key: string; label: string; color: string; values: number[] };

const MARGIN = { top: 12, right: 8, bottom: 30, left: 48 };
const shortLabel = (label: string) => label.replace(/ 20(\d\d)$/, " '$1");

// Square at the baseline, a 4px round at the end that carries the value.
function columnPath(x: number, top: number, width: number, bottom: number, roundTop: boolean) {
  const r = roundTop ? Math.min(4, width / 2, bottom - top) : 0;
  const right = x + width;
  if (r <= 0) return `M${x},${bottom}L${x},${top}L${right},${top}L${right},${bottom}Z`;
  return `M${x},${bottom}L${x},${top + r}Q${x},${top} ${x + r},${top}L${right - r},${top}Q${right},${top} ${right},${top + r}L${right},${bottom}Z`;
}

export function ColumnChart({
  periods,
  series,
  mode,
  label,
  height = 260,
}: {
  periods: { key: string; label: string }[];
  series: ColumnSeries[];
  mode: 'grouped' | 'stacked';
  label: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const count = periods.length;
  const band = count ? innerW / count : 0;
  const baseline = MARGIN.top + innerH;

  const at = (s: ColumnSeries, i: number) => s.values[i] ?? 0;
  const totals = periods.map((_, i) =>
    mode === 'stacked' ? series.reduce((sum, s) => sum + at(s, i), 0) : Math.max(0, ...series.map((s) => at(s, i))),
  );
  const ticks = niceTicks(0, Math.max(0, ...totals));
  const top = ticks.at(-1) ?? 100;
  const scale = (value: number) => (value / top) * innerH;
  const labelStep = Math.max(1, Math.ceil((count * 56) / Math.max(innerW, 1)));

  function move(event: PointerEvent, index: number) {
    const box = ref.current?.getBoundingClientRect();
    if (box) setHover({ index, x: event.clientX - box.left, y: event.clientY - box.top });
  }

  const bars = periods.flatMap((period, i) => {
    const opacity = hover !== null && hover.index !== i ? 0.45 : 1;
    const bandX = MARGIN.left + i * band;

    if (mode === 'grouped') {
      const k = series.length;
      const barWidth = Math.min(24, Math.max(4, (band * 0.7 - 2 * (k - 1)) / k));
      const startX = bandX + (band - (k * barWidth + 2 * (k - 1))) / 2;
      return series.map((s, j) => {
        const h = scale(at(s, i));
        return h > 0 ? (
          <path key={`${period.key}-${s.key}`} d={columnPath(startX + j * (barWidth + 2), baseline - h, barWidth, baseline, true)} fill={s.color} opacity={opacity} />
        ) : null;
      });
    }

    const barWidth = Math.min(24, Math.max(6, band * 0.6));
    const x = bandX + (band - barWidth) / 2;
    const present = series.filter((s) => at(s, i) > 0);
    let cursor = baseline;
    return present.map((s, j) => {
      const h = scale(at(s, i));
      // A 2px gap of the card colour separates segments, with no outline.
      const bottom = cursor - (j > 0 ? 2 : 0);
      cursor -= h;
      return bottom - cursor < 1 ? null : (
        <path key={`${period.key}-${s.key}`} d={columnPath(x, cursor, barWidth, bottom, j === present.length - 1)} fill={s.color} opacity={opacity} />
      );
    });
  });

  const hovered = hover ? periods[hover.index] : undefined;

  return (
    <div ref={ref} className="relative" style={{ minHeight: height }}>
      {width > 0 && (
        <svg width={width} height={height} role="group" aria-label={label}>
          {ticks.map((tick) => {
            const y = baseline - scale(tick);
            return (
              <g key={tick}>
                <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y} y2={y} style={{ stroke: tick === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)' }} strokeWidth={1} />
                <text x={MARGIN.left - 8} y={y} textAnchor="end" dominantBaseline="middle" className="fill-muted text-[11px]">
                  {formatCompact(tick)}
                </text>
              </g>
            );
          })}
          {bars}
          {periods.map((period, i) =>
            i % labelStep === 0 ? (
              <text key={period.key} x={MARGIN.left + (i + 0.5) * band} y={height - 10} textAnchor="middle" className="fill-muted text-[11px]">
                {shortLabel(period.label)}
              </text>
            ) : null,
          )}
          {periods.map((period, i) => (
            <g
              key={period.key}
              tabIndex={0}
              role="img"
              aria-label={`${period.label}: ${series.map((s) => `${s.label} ${formatAmount(at(s, i))}`).join(', ')}`}
              className="outline-none"
              onFocus={() => setHover({ index: i, x: MARGIN.left + (i + 0.5) * band, y: MARGIN.top + 24 })}
              onBlur={() => setHover(null)}
            >
              <rect x={MARGIN.left + i * band} y={MARGIN.top} width={band} height={innerH} fill="transparent" onPointerMove={(event) => move(event, i)} onPointerLeave={() => setHover(null)} />
            </g>
          ))}
        </svg>
      )}
      {hover && hovered && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          containerWidth={width}
          title={hovered.label}
          rows={[
            ...series.map((s) => ({ color: s.color, label: s.label, value: formatAmount(at(s, hover.index)) })),
            ...(mode === 'stacked' ? [{ label: 'Total', value: formatAmount(totals[hover.index] ?? 0) }] : []),
          ]}
        />
      )}
    </div>
  );
}
