export const SLOTS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)'];
export const OTHER = 'var(--viz-other)';

// A category keeps its colour whatever dates are chosen: the colour comes from
// its rank over all time, and only a category outside that top few takes a spare slot.
export function assignSlots(shown: number[], allTimeOrder: number[]) {
  const colors = new Map<number, string>();
  const taken = new Set<number>();
  for (const id of shown) {
    const rank = allTimeOrder.indexOf(id);
    if (rank >= 0 && rank < SLOTS.length) {
      colors.set(id, SLOTS[rank]!);
      taken.add(rank);
    }
  }
  let next = 0;
  for (const id of shown) {
    if (colors.has(id)) continue;
    while (taken.has(next)) next += 1;
    colors.set(id, SLOTS[next % SLOTS.length]!);
    taken.add(next);
  }
  return colors;
}
