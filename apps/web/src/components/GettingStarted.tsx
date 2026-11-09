import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api.ts';

// The first things to do in a new account, ticked off from what is already there.
export function GettingStarted() {
  const client = useQueryClient();
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.setup });
  const hide = useMutation({ mutationFn: api.hideSetup, onSuccess: () => client.invalidateQueries({ queryKey: ['setup'] }) });
  if (!setup.data || setup.data.hidden) return null;
  const { steps } = setup.data;
  const done = steps.filter((step) => step.done).length;
  return (
    <section className="card flex flex-col gap-3 p-4" aria-labelledby="start-heading">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="start-heading" className="font-medium">Getting started</h2>
        <p className="text-sm text-muted">{done} of {steps.length} done · <Link to="/guide" className="underline">How it works</Link></p>
      </header>
      <ol className="flex flex-col gap-3">
        {steps.map((step) => (
          <li key={step.key} className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs ${step.done ? 'border-accent bg-accent text-accent-ink' : 'border-line text-muted'}`}
              >
                {step.done ? '✓' : ''}
              </span>
              <div className="min-w-0">
                <p className={`text-sm font-medium ${step.done ? 'text-muted line-through' : ''}`}>{step.title}</p>
                {!step.done && <p className="mt-0.5 text-sm text-muted">{step.detail}</p>}
              </div>
            </div>
            {!step.done && (
              <Link to={step.to} className="button-quiet">
                {step.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
      <div>
        <button className="text-xs text-muted underline" disabled={hide.isPending} onClick={() => hide.mutate()}>
          Hide this
        </button>
      </div>
    </section>
  );
}
