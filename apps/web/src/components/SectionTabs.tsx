import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api.ts';

type Tab = { to: string; label: string; admin?: boolean; ownerOnly?: boolean };

export const SECTIONS = {
  organise: [
    { to: '/categories', label: 'Categories' },
    { to: '/rules', label: 'Rules' },
  ],
  automation: [
    { to: '/alerts', label: 'Alerts', ownerOnly: true },
    { to: '/agents', label: 'Agents', ownerOnly: true },
    { to: '/activity', label: 'Change log' },
  ],
  settings: [
    { to: '/settings', label: 'Settings', ownerOnly: true },
    { to: '/backups', label: 'Backups and export', ownerOnly: true },
    { to: '/users', label: 'People and password' },
    { to: '/admin', label: 'Site overview', admin: true },
  ],
} satisfies Record<string, Tab[]>;

// Pages that belong together share one row of tabs in place of a page heading.
export function SectionTabs({ section }: { section: keyof typeof SECTIONS }) {
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const tabs: Tab[] = SECTIONS[section].filter((t: Tab) => (!t.admin || (auth.data?.multiUser && auth.data.isAdmin)) && !(t.ownerOnly && auth.data?.viewing));
  return (
    <nav aria-label="Section" className="flex flex-wrap gap-1 border-b border-line pb-2">
      {tabs.map((t) => (
        <Link key={t.to} to={t.to as never} className="rounded-md px-3 py-1.5 text-2xl font-semibold text-muted hover:text-ink" activeProps={{ className: 'text-ink!' }}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
