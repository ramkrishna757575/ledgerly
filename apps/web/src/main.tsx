import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { activeLedger, api, ApiError, chooseLedger } from './api.ts';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { AccountsPage } from './pages/Accounts.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { AgentsPage } from './pages/Agents.tsx';
import { ImportPage } from './pages/Import.tsx';
import { CategoriesPage } from './pages/Categories.tsx';
import { ForecastPage } from './pages/Forecast.tsx';
import { LoansPage } from './pages/Loans.tsx';
import { GoalsPage } from './pages/Goals.tsx';
import { TaxPage } from './pages/Tax.tsx';
import { AskPage } from './pages/Ask.tsx';
import { QuickAddPage } from './pages/QuickAdd.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { AdminPage, LegalPage } from './pages/Admin.tsx';
import { GuidePage } from './pages/Guide.tsx';
import { UsersPage } from './pages/Users.tsx';
import { ActivityPage } from './pages/Activity.tsx';
import { AlertsPage } from './pages/Alerts.tsx';
import { AssetsPage } from './pages/Assets.tsx';
import { AnalysisPage } from './pages/Analysis.tsx';
import { BillsPage } from './pages/Bills.tsx';
import { BudgetsPage } from './pages/Budgets.tsx';
import { BackupsPage } from './pages/Backups.tsx';
import { InvestmentsPage } from './pages/Investments.tsx';
import { EmailLinkPage, LoginPage } from './pages/Login.tsx';
import { ReportsPage } from './pages/Reports.tsx';
import { RulesPage } from './pages/Rules.tsx';
import { TransactionsPage } from './pages/Transactions.tsx';
import { parseAddAccountSearch, parseImportSearch, parseTransactionsSearch } from './search.ts';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Each icon is the inside of a 24x24 outline drawing.
const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  plus: 'M12 5v14M5 12h14',
  wallet: 'M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm0 0V6a2 2 0 012-2h11M16 14h2',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  upload: 'M12 16V4m0 0L7 9m5-5l5 5M4 20h16',
  tag: 'M3 12V4h8l10 10-8 8L3 12zm5-5h.01',
  wand: 'M15 4l5 5L8 21l-5-5L15 4zm-3 3l5 5',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  pie: 'M12 3v9h9a9 9 0 11-9-9zm4 0a9 9 0 015 5h-5V3z',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zm0-5a4 4 0 100-8 4 4 0 000 8zm0-3h.01',
  flag: 'M5 21V4m0 0h12l-2 4 2 4H5',
  calendar: 'M4 6h16v14H4V6zm0 5h16M8 3v4m8-4v4',
  bank: 'M3 10l9-6 9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18',
  trend: 'M3 17l6-6 4 4 8-8m0 0h-5m5 0v5',
  gem: 'M6 4h12l4 6-10 11L2 10l4-6zM2 10h20',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zm3 5h6m-6 4h6',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z',
  chat: 'M4 5h16v11H9l-5 4V5z',
  bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zm4 4h4',
  robot: 'M5 8h14v11H5V8zm7 0V4m-3 8h.01M15 12h.01M9 16h6',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zm0-14v5l3 2',
  cog: 'M12 15a3 3 0 100-6 3 3 0 000 6zm0-12v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1m0-12.8l-2.1 2.1M7.7 16.3l-2.1 2.1',
  users: 'M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1m9-11a3 3 0 11-6 0 3 3 0 016 0zm9 11v-1a4 4 0 00-3-3.9M16 5.1a3 3 0 010 5.8',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  book: 'M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5zm0 14a2 2 0 012-2h13',
  save: 'M12 4v11m0 0l-4-4m4 4l4-4M4 20h16',
} as const;

type IconName = keyof typeof ICONS;

type NavItem = { to: string; label: string; icon: IconName; admin?: boolean; ownerOnly?: boolean; also?: string[] };

// The first four groups are what you use every day and stay open. Setup holds the
// things you touch once in a while, and opens when you go there.
const NAV_GROUPS: { title: string; pinned?: boolean; items: NavItem[] }[] = [
  {
    title: 'Today',
    pinned: true,
    items: [
      { to: '/', label: 'Dashboard', icon: 'home' },
      { to: '/add', label: 'Quick add', icon: 'plus' },
      { to: '/analysis', label: 'Coach', icon: 'sparkle', ownerOnly: true, also: ['/ask'] },
    ],
  },
  {
    title: 'Money',
    pinned: true,
    items: [
      { to: '/accounts', label: 'Accounts and cards', icon: 'wallet' },
      { to: '/transactions', label: 'Transactions', icon: 'list' },
      { to: '/import', label: 'Import', icon: 'upload' },
    ],
  },
  {
    title: 'Plan',
    pinned: true,
    items: [
      { to: '/budgets', label: 'Budgets', icon: 'pie' },
      { to: '/goals', label: 'Goals', icon: 'target' },
      { to: '/bills', label: 'Bills', icon: 'calendar' },
      { to: '/forecast', label: 'Forecast', icon: 'flag' },
      { to: '/reports', label: 'Reports', icon: 'chart' },
    ],
  },
  {
    title: 'Wealth',
    pinned: true,
    items: [
      { to: '/investments', label: 'Investments', icon: 'trend' },
      { to: '/assets', label: 'Other assets', icon: 'gem' },
      { to: '/loans', label: 'Loans and insurance', icon: 'bank' },
      { to: '/tax', label: 'Tax', icon: 'receipt' },
    ],
  },
  {
    title: 'Setup',
    items: [
      { to: '/categories', label: 'Categories and rules', icon: 'wand', also: ['/rules'] },
      { to: '/alerts', label: 'Alerts and agents', icon: 'bell', ownerOnly: true, also: ['/agents', '/activity'] },
      { to: '/settings', label: 'Settings and backups', icon: 'cog', also: ['/backups', '/users', '/admin'] },
      { to: '/guide', label: 'How it works', icon: 'book' },
    ],
  },
];

function NavIcon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

// How many agent suggestions are waiting, so they are not missed.
function PendingBadge() {
  const summary = useQuery({ queryKey: ['agents', 'summary'], queryFn: api.agentSummary, refetchInterval: 20_000 });
  const pending = summary.data?.pending ?? 0;
  return pending > 0 ? (
    <span className="ml-2 rounded-full bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-ink" aria-label={`${pending} waiting`}>
      {pending}
    </span>
  ) : null;
}

// Only the section you are in stays open. Pointing at another one opens it after a moment,
// and they close again when the pointer leaves the menu. A tap on a title opens or closes it
// too, for screens with no pointer.
function NavGroups() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const [peeking, setPeeking] = useState<string[]>([]);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  const open = (title: string, delay: number) => {
    clearTimeout(wait.current);
    wait.current = setTimeout(() => setPeeking((now) => (now.includes(title) ? now : [...now, title])), delay);
  };
  const leave = () => {
    clearTimeout(wait.current);
    wait.current = setTimeout(() => setPeeking([]), 300);
  };
  const toggle = (title: string) => {
    clearTimeout(wait.current);
    setPeeking((now) => (now.includes(title) ? now.filter((t) => t !== title) : [...now, title]));
  };
  return (
    <div className="contents md:flex md:flex-col" onMouseLeave={leave} onMouseEnter={() => clearTimeout(wait.current)}>
      {NAV_GROUPS.map((raw) => {
        // Items for administrators only are left out for everyone else.
        const group = { ...raw, items: raw.items.filter((item) => (!item.admin || (auth.data?.multiUser && auth.data.isAdmin)) && !(item.ownerOnly && auth.data?.viewing)) };
        const here = group.items.some((item) => item.to === path || item.also?.includes(path));
        const shown = here || group.pinned || peeking.includes(group.title);
        return (
          <div key={group.title} className="contents md:mt-2 md:flex md:flex-col md:gap-0.5" onMouseEnter={() => !shown && open(group.title, 150)} onFocus={() => open(group.title, 0)}>
            <button
              type="button"
              aria-expanded={shown}
              disabled={here || group.pinned}
              onClick={() => toggle(group.title)}
              className="hidden items-center justify-between rounded-md px-3 py-1 text-[11px] font-medium tracking-wider text-muted uppercase hover:text-ink md:flex"
            >
              <span>
                {group.title}
                {!shown && group.title === 'Setup' && <PendingBadge />}
              </span>
              <svg viewBox="0 0 24 24" aria-hidden="true" className={`size-3.5 transition-transform ${shown ? '' : '-rotate-90'} ${here ? 'opacity-30' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {group.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted hover:bg-surface/60 hover:text-ink ${shown ? '' : 'md:hidden'} ${item.also?.includes(path) ? 'bg-surface font-medium text-ink!' : ''}`}
                activeOptions={{ exact: true }}
                activeProps={{ className: 'bg-surface font-medium text-ink!' }}
              >
                <NavIcon name={item.icon} />
                {item.label}
                {item.to === '/alerts' && <PendingBadge />}
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// Choose between your own books and any that someone has let you into.
function LedgerSwitcher({ viewing }: { viewing: { ownerId: number; username: string } | null | undefined }) {
  const shares = useQuery({ queryKey: ['shares'], queryFn: api.shares });
  const received = shares.data?.received ?? [];
  if (received.length === 0 && !viewing) return null;
  return (
    <label className="flex flex-col gap-1 px-3 text-xs text-muted">
      Books
      <select className="field py-1" value={viewing?.ownerId ?? 0} onChange={(e) => chooseLedger(Number(e.target.value) || null)}>
        <option value={0}>My books</option>
        {received.map((r) => (
          <option key={r.ownerId} value={r.ownerId}>{r.username}'s books ({r.role})</option>
        ))}
      </select>
    </label>
  );
}

function Shell() {
  const client = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });

  // A choice of someone's books that no longer lets you in is dropped.
  if (auth.data?.authenticated && activeLedger() && auth.data.viewing === null) chooseLedger(null);
  if (auth.isPending) return null;
  if (auth.isError) {
    return <p className="p-6 text-sm text-danger">The server can't be reached right now.</p>;
  }
  // The pages the links in our emails open, whether or not you are signed in.
  if (window.location.pathname === '/terms') return <LegalPage which="terms" />;
  if (window.location.pathname === '/privacy') return <LegalPage which="privacy" />;
  if (window.location.pathname === '/verify') return <EmailLinkPage kind="verify" />;
  if (window.location.pathname === '/reset') return <EmailLinkPage kind="reset" />;
  if (!auth.data.authenticated) return <LoginPage />;

  async function logout() {
    await api.logout();
    // Drop everything the last person saw, but keep the auth query itself so this view notices.
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
    await client.invalidateQueries({ queryKey: ['auth'] });
  }

  async function resetDemo() {
    await api.resetDemo();
    await client.invalidateQueries();
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* On a wide screen the menu stays in view while the page scrolls, with the theme at its foot. */}
      <aside className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] border-b border-line p-3 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:flex-col md:items-stretch md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:p-4">
        <p className="mr-3 font-semibold md:mr-0 md:mb-2 md:px-3 md:text-base">Ledgerly</p>
        <NavGroups />
        <div className="ml-auto flex shrink-0 items-center gap-2 md:sticky md:bottom-0 md:mt-auto md:ml-0 md:flex-col md:items-stretch md:bg-page md:py-2">
          <LedgerSwitcher viewing={auth.data.viewing} />
          <ThemeToggle />
          {auth.data.username && <p className="px-3 text-xs text-muted">Signed in as {auth.data.username}</p>}
          {auth.data.authRequired && (
            <button onClick={logout} className="px-3 py-2 text-left text-sm text-muted hover:text-ink">
              Log out
            </button>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6">
          {auth.data.viewing && (
            <div className="rounded-md border border-line px-4 py-2 text-sm text-muted">
              You are looking at <strong className="text-ink">{auth.data.viewing.username}'s books</strong> as {auth.data.viewing.role === 'editor' ? 'an editor: you can add and change things, but not their settings, keys or backups' : 'a viewer: you can look at everything but not change it'}.{' '}
              <button className="underline" onClick={() => chooseLedger(null)}>Back to my books</button>
            </div>
          )}
          {auth.data.role === 'viewer' && (
            <div className="rounded-md border border-line px-4 py-2 text-sm text-muted">You are signed in with a read-only login. You can look at everything but not change it.</div>
          )}
          {auth.data.demo && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-accent px-4 py-2 text-sm text-accent-ink">
              <span>Demo mode: everything here is made-up sample data.</span>
              <button onClick={resetDemo} className="underline">
                Reset demo data
              </button>
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Shell });
const page = <Path extends string>(path: Path, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

// These two can be opened with details filled in, so they read the address.
const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: AccountsPage,
  validateSearch: parseAddAccountSearch,
});
const transactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/transactions',
  component: TransactionsPage,
  validateSearch: parseTransactionsSearch,
});
const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/import',
  component: ImportPage,
  validateSearch: parseImportSearch,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    page('/', DashboardPage),
    accountsRoute,
    transactionsRoute,
    page('/add', QuickAddPage),
    page('/guide', GuidePage),
    page('/admin', AdminPage),
    page('/reports', ReportsPage),
    page('/budgets', BudgetsPage),
    page('/goals', GoalsPage),
    page('/loans', LoansPage),
    page('/bills', BillsPage),
    page('/forecast', ForecastPage),
    page('/investments', InvestmentsPage),
    page('/assets', AssetsPage),
    page('/analysis', AnalysisPage),
    page('/ask', AskPage),
    page('/tax', TaxPage),
    page('/backups', BackupsPage),
    importRoute,
    page('/categories', CategoriesPage),
    page('/rules', RulesPage),
    page('/alerts', AlertsPage),
    page('/activity', ActivityPage),
    page('/agents', AgentsPage),
    page('/settings', SettingsPage),
    page('/users', UsersPage),
  ]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

// Lets the app be installed and opened like any other. The worker never stores
// API responses, and it is skipped while developing.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
