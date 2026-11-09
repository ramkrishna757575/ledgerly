export type Range = { id: string; label: string; from: string; to: string };

const pad = (value: number) => String(value).padStart(2, '0');
const iso = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
const lastDay = (year: number, month: number) => new Date(year, month, 0).getDate();

// Date ranges people actually ask for, with the Indian financial year (April to
// March). Ranges still running end today, so there are no empty future months.
export function presets(now = new Date()): Range[] {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = iso(year, month, now.getDate());
  const monthsAgo = (count: number) => {
    const date = new Date(year, month - 1 - count, 1);
    return { year: date.getFullYear(), month: date.getMonth() + 1 };
  };
  const previous = monthsAgo(1);
  const threeBack = monthsAgo(2);
  const twelveBack = monthsAgo(11);
  const fy = month >= 4 ? year : year - 1;

  return [
    { id: 'this-month', label: 'This month', from: iso(year, month, 1), to: today },
    { id: 'last-month', label: 'Last month', from: iso(previous.year, previous.month, 1), to: iso(previous.year, previous.month, lastDay(previous.year, previous.month)) },
    { id: 'last-3-months', label: 'Last 3 months', from: iso(threeBack.year, threeBack.month, 1), to: today },
    { id: 'last-12-months', label: 'Last 12 months', from: iso(twelveBack.year, twelveBack.month, 1), to: today },
    { id: 'this-fy', label: 'This financial year', from: iso(fy, 4, 1), to: today },
    { id: 'last-fy', label: 'Last financial year', from: iso(fy - 1, 4, 1), to: iso(fy, 3, 31) },
    { id: 'this-year', label: 'This year', from: iso(year, 1, 1), to: today },
    { id: 'last-year', label: 'Last year', from: iso(year - 1, 1, 1), to: iso(year - 1, 12, 31) },
  ];
}

export const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
