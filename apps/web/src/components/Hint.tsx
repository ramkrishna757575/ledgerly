import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

// A short explanation that stays out of the way until it is asked for.
export function Hint({ title = 'What does this mean?', children }: { title?: string; children: ReactNode }) {
  return (
    <details className="group text-sm">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-flex size-4 items-center justify-center rounded-full border border-line text-[10px] leading-none">?</span>
        {title}
      </summary>
      <div className="mt-2 flex max-w-2xl flex-col gap-2 rounded-md border border-line p-3 text-muted">
        {children}
        <p>
          More examples in the <Link to="/guide" className="text-accent underline">guide</Link>.
        </p>
      </div>
    </details>
  );
}
