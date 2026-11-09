import { useQuery } from '@tanstack/react-query';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { api, fmtDateTime } from '../api.ts';

const WHO: Record<string, string> = { owner: 'You', viewer: 'Read-only login', local: 'You', anonymous: 'Not signed in' };

export function ActivityPage() {
  const rows = useQuery({ queryKey: ['activity'], queryFn: api.activity });
  return (
    <div className="flex flex-col gap-6">
      <SectionTabs section="automation" />
      <p className="text-sm text-muted">Everything that changed something, and who did it. It records the action and which item, never what was typed. Blocked attempts and wrong passwords show here too. Agents have their own log on the Agents page.</p>
      {rows.isSuccess && rows.data.length === 0 && <p className="card p-6 text-sm text-muted">Nothing yet.</p>}
      <ul className="card divide-y divide-line text-sm">
        {rows.data?.map((r) => {
          const who = WHO[r.actor.replace('user:', '')] ?? r.actor;
          return (
            <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-3">
              <span className="min-w-0">
                <span className="font-medium">{who}</span> <code className="text-xs">{r.tool}</code>
                {r.detail && <span className="block text-xs text-muted">{r.detail}</span>}
              </span>
              <span className="text-xs text-muted">
                {fmtDateTime(r.at)} · <span className={r.outcome === 'ok' ? '' : 'text-danger'}>{r.outcome === 'ok' ? 'done' : r.outcome === 'denied' ? 'blocked' : 'failed'}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
