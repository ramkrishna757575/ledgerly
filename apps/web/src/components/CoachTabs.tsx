import { Link } from '@tanstack/react-router';

// Review and Ask are two ways of talking to the same coach, so they share one heading.
export function CoachTabs() {
  const tab = 'rounded-md px-3 py-1.5 text-sm text-muted hover:text-ink';
  const on = { className: 'bg-surface font-medium text-ink!' };
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold">Coach</h1>
      <nav aria-label="Coach" className="flex gap-1 border-b border-line pb-2">
        <Link to="/analysis" className={tab} activeProps={on}>Review</Link>
        <Link to="/ask" className={tab} activeProps={on}>Ask a question</Link>
      </nav>
    </div>
  );
}
