import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { PayeeTidy } from '../components/PayeeTidy.tsx';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, isMoneyAccount, type Account, type AutoRuleMode, type Rule, type RuleSuggestion, type UncategorizedPayee } from '../api.ts';
import { CategorySelect } from '../components/CategorySelect.tsx';
import { useDebounced } from '../useDebounced.ts';

const MATCH_LABEL = { contains: 'contains', regex: 'pattern' } as const;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

const MODES: { id: AutoRuleMode; label: string; help: string }[] = [
  { id: 'off', label: 'Off', help: 'Ledgerly only suggests rules. Nothing is created until you add it.' },
  { id: 'create', label: 'Create rules automatically', help: 'New rules apply to future imports. Transactions already in your books are left alone.' },
  {
    id: 'create_and_apply',
    label: 'Create rules and sort what is still uncategorised',
    help: 'As above, and a new rule also files the matching transactions that are still uncategorised. Ones you sorted yourself are never changed.',
  },
];

// Rules made without you being asked are optional, and kept careful.
function AutoRules() {
  const client = useQueryClient();
  const setting = useQuery({ queryKey: ['settings', 'auto-rules'], queryFn: api.autoRules });
  const [notice, setNotice] = useState('');

  const change = useMutation({
    mutationFn: (mode: AutoRuleMode) => api.setAutoRules(mode),
    onSuccess: ({ mode, created, sorted }) => {
      setNotice(
        mode === 'off'
          ? 'Automatic rules are off.'
          : created === 0
            ? 'On. Nothing needed a rule yet, so rules will appear as you import and sort.'
            : `On. ${plural(created, 'rule')} created${sorted ? `, and ${plural(sorted, 'transaction')} sorted` : ''}.`,
      );
      client.invalidateQueries();
    },
  });

  const mode = setting.data?.mode;
  return (
    <fieldset className="card flex flex-col gap-3 p-4" disabled={change.isPending || !mode}>
      <legend className="px-1 font-medium">Automatic rules</legend>
      <div className="flex flex-col gap-2">
        {MODES.map((option) => (
          <label key={option.id} className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="radio" name="auto-rules" className="mt-1" checked={mode === option.id} onChange={() => change.mutate(option.id)} />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-muted">{option.help}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-sm text-muted">
        Safeguards: it only acts on a payee you have put in the same category at least 3 times, nearly always the same way, whose name is at
        least 4 letters, and never when the rule would also catch something you filed elsewhere. Delete or switch off a rule and it does not
        come back.
      </p>
      {notice && <p className="text-sm" aria-live="polite">{notice}</p>}
      {change.isError && <p className="text-sm text-danger">{change.error.message}</p>}
    </fieldset>
  );
}

function AddRule({ accounts }: { accounts: Account[] }) {
  const client = useQueryClient();
  const [pattern, setPattern] = useState('');
  const [matchType, setMatchType] = useState<'contains' | 'regex'>('contains');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [onlyAccount, setOnlyAccount] = useState('');
  const settled = useDebounced(pattern.trim());

  // Blank means no limit. Anything else must be an amount.
  const amountOf = (text: string) => {
    if (!text.trim()) return null;
    try {
      const value = parseAmount(text);
      return value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const minAmount = amountOf(min);
  const maxAmount = amountOf(max);
  const conditions = { minAmount, maxAmount, accountId: onlyAccount ? Number(onlyAccount) : null };
  const conditionsOk = minAmount !== undefined && maxAmount !== undefined;

  const preview = useQuery({
    queryKey: ['rule-preview', settled, matchType, minAmount, maxAmount, onlyAccount],
    queryFn: () => api.previewRule(settled, matchType, conditions),
    enabled: settled.length >= 2 && conditionsOk,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => api.createRule({ pattern: pattern.trim(), matchType, categoryId: categoryId!, ...conditions }),
    onSuccess: () => {
      setPattern('');
      setMin('');
      setMax('');
      setOnlyAccount('');
      setCategoryId(null);
      client.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (categoryId) create.mutate();
  }

  return (
    <form onSubmit={submit} className="card grid gap-4 p-4 sm:grid-cols-2">
      <label className="label">
        When the payee or description
        <div className="flex gap-2">
          <select className="field w-32 shrink-0" aria-label="How to match" value={matchType} onChange={(e) => setMatchType(e.target.value as typeof matchType)}>
            <option value="contains">contains</option>
            <option value="regex">matches pattern</option>
          </select>
          <input className="field" required minLength={2} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={matchType === 'contains' ? 'swiggy' : 'swiggy|zomato'} />
        </div>
      </label>
      <label className="label">
        Put it in
        <CategorySelect value={categoryId} accounts={accounts} ownAccountId={null} disabled={false} onChange={setCategoryId} />
      </label>

      <div className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
        <label className="label">
          Only if the amount is at least (₹)
          <input className="field" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="any" />
        </label>
        <label className="label">
          and at most (₹)
          <input className="field" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder="any" />
        </label>
        <label className="label">
          Only for the account
          <select className="field" value={onlyAccount} onChange={(e) => setOnlyAccount(e.target.value)}>
            <option value="">Any account</option>
            {accounts.filter((a) => (a.type === 'asset' || a.type === 'liability') && !a.isArchived).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      </div>
      {!conditionsOk && <p className="text-sm text-danger sm:col-span-2">Enter amounts like 500 or leave them empty.</p>}

      <div className="text-sm text-muted sm:col-span-2" aria-live="polite">
        {settled.length < 2 ? (
          'Type at least two characters to see what it would match. Case does not matter.'
        ) : preview.isError ? (
          <span className="text-danger">{preview.error.message}</span>
        ) : preview.data ? (
          preview.data.matches === 0 ? (
            'Nothing in your books matches yet. It will apply to future imports.'
          ) : (
            <>
              Matches {plural(preview.data.matches, 'transaction')} in your books, {preview.data.unsorted} still uncategorised, for example{' '}
              {preview.data.examples.join(', ')}.
            </>
          )
        ) : (
          'Checking…'
        )}
      </div>

      {create.isError && <p className="text-sm text-danger sm:col-span-2">{create.error.message}</p>}
      <div className="sm:col-span-2">
        <button className="button" disabled={!categoryId || pattern.trim().length < 2 || !conditionsOk || create.isPending}>
          Add rule
        </button>
      </div>
    </form>
  );
}

// Payees already put in the same category several times. Accepting one adds the
// rule and sorts what is still uncategorised from that payee.
// Asks a model to place the payees that rules could not. Off until turned on,
// and shows exactly what would leave the machine.
function AiSuggestions() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ['ai-categorize'], queryFn: api.aiCategorize });
  const [showSent, setShowSent] = useState(false);
  const refresh = () => client.invalidateQueries();
  const toggle = useMutation({ mutationFn: api.setAiCategorize, onSuccess: refresh });
  const run = useMutation({ mutationFn: api.runAiCategorize, onSuccess: refresh });
  const data = state.data;
  if (!data || !data.configured) return null;
  const where = data.destination?.local ? `Stays on this machine (${data.destination.host}).` : `Sent to ${data.destination?.host}.`;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="font-medium">Suggest categories with AI</h2>
      <p className="text-sm text-muted">
        For payees that no rule or past choice covers, a model suggests a category. Each confident answer becomes a suggested rule that waits in the approval list on the Agents page, and nothing changes until you approve it. {where} What leaves is only the payee text with long numbers blanked, how often it appears, a rough amount and the names of your categories: never dates, accounts, balances or individual transactions.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={data.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
        I have read what is sent, and want this on
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="button-quiet" aria-expanded={showSent} onClick={() => setShowSent(!showSent)}>{showSent ? 'Hide' : 'Show'} what would be sent ({data.send.groups.length} payees)</button>
        <button className="button" disabled={!data.enabled || run.isPending || data.send.groups.length === 0} onClick={() => run.mutate()}>{run.isPending ? 'Asking…' : 'Suggest categories'}</button>
      </div>
      {showSent && <pre className="max-h-80 overflow-auto rounded-md border border-line p-3 text-xs">{JSON.stringify(data.send, null, 2)}</pre>}
      {run.data && <p className="text-sm" aria-live="polite">{run.data.proposed} suggested rule{run.data.proposed === 1 ? '' : 's'} waiting for your approval below{run.data.skipped > 0 ? `, ${run.data.skipped} left alone as unsure` : ''}.</p>}
      {run.error && <p className="text-sm text-danger">{run.error.message}</p>}
      <AiProposals />
    </section>
  );
}

// What the model suggested, to approve in one go: each is a rule, and approving it
// also sorts the uncategorised transactions it matches. Untick any you disagree with.
function AiProposals() {
  const client = useQueryClient();
  const pending = useQuery({ queryKey: ['agents', 'proposals', 'pending'], queryFn: () => api.proposals('pending') });
  const mine = (pending.data ?? []).filter((p) => p.source === 'AI suggestions' && p.rule);
  const [off, setOff] = useState<number[]>([]);
  const chosen = mine.filter((p) => !off.includes(p.id)).map((p) => p.id);
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => api.decideSome(decision, decision === 'approve' ? chosen : mine.map((p) => p.id)),
    onSuccess: () => client.invalidateQueries(),
  });
  if (mine.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-sm font-medium">Suggested by the model ({mine.length})</h3>
      <ul className="divide-y divide-line text-sm">
        {mine.map((p) => (
          <li key={p.id} className="flex items-start gap-2 py-2">
            <input className="mt-1" type="checkbox" aria-label={`Use ${p.rule!.pattern}`} checked={!off.includes(p.id)} onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== p.id) : [...off, p.id])} />
            <span className="min-w-0">
              <span className="font-mono">{p.rule!.pattern}</span> <span className="text-muted">to</span> {p.to}
              <span className="block text-xs text-muted">{p.reason}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button className="button" disabled={decide.isPending || chosen.length === 0} onClick={() => decide.mutate('approve')}>Approve {chosen.length} and sort my transactions</button>
        <button className="button-quiet" disabled={decide.isPending} onClick={() => decide.mutate('reject')}>Dismiss all</button>
      </div>
      {decide.error && <p className="text-sm text-danger">{decide.error.message}</p>}
    </div>
  );
}

// Rules that do nothing useful, with the reason, and a button to remove each.
function RuleHealth() {
  const client = useQueryClient();
  const health = useQuery({ queryKey: ['rules', 'health'], queryFn: api.ruleHealth });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteRule(id), onSuccess: () => client.invalidateQueries({ queryKey: ['rules'] }) });
  const problems = health.data ?? [];
  if (problems.length === 0) return null;
  const LABEL = { unused: 'Matches nothing', shadowed: 'Already covered', conflict: 'Never applies' } as const;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Rules to tidy ({problems.length})</h2>
      <ul className="card divide-y divide-line">
        {problems.map((p) => (
          <li key={`${p.ruleId}-${p.kind}`} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <span className="min-w-0">
              <span className="font-mono">{p.pattern}</span> <span className="text-muted">to {p.categoryName} · {LABEL[p.kind]}</span>
              <span className="block text-muted">{p.reason}</span>
            </span>
            <button className="button-quiet" disabled={remove.isPending} onClick={() => remove.mutate(p.ruleId)}>Remove</button>
          </li>
        ))}
      </ul>
      {remove.error && <p className="text-sm text-danger">{remove.error.message}</p>}
    </section>
  );
}

function Suggestions() {
  const client = useQueryClient();
  const suggestions = useQuery({ queryKey: ['rules', 'suggestions'], queryFn: api.ruleSuggestions });
  const [notice, setNotice] = useState('');

  const add = useMutation({
    mutationFn: async (items: RuleSuggestion[]) => {
      let sorted = 0;
      for (const item of items) {
        const rule = await api.createRule({ pattern: item.pattern, matchType: 'contains', categoryId: item.categoryId });
        if (item.unsorted > 0) sorted += (await api.applyRule(rule.id)).updated;
      }
      return { rules: items.length, sorted };
    },
    onSuccess: ({ rules, sorted }) => {
      setNotice(`${plural(rules, 'rule')} added${sorted ? `, and ${plural(sorted, 'transaction')} sorted` : ''}.`);
      client.invalidateQueries();
    },
  });

  const items = suggestions.data ?? [];
  if (items.length === 0) return notice ? <p className="text-sm text-muted" aria-live="polite">{notice}</p> : null;

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Suggested rules</h2>
          <p className="text-sm text-muted">Payees you have put in the same category several times. A rule does it for you from now on.</p>
        </div>
        {items.length > 1 && (
          <button className="button-quiet" disabled={add.isPending} onClick={() => add.mutate(items)}>
            Add all {items.length}
          </button>
        )}
      </header>
      {add.isError && <p className="text-sm text-danger">{add.error.message}</p>}
      <ul className="card divide-y divide-line">
        {items.map((item) => (
          <li key={item.pattern} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {item.pattern} <span className="text-muted">→</span> {item.categoryName}
              </p>
              <p className="text-sm text-muted">
                You put it there {item.seen} times
                {item.unsorted > 0 && `, and ${item.unsorted} more ${item.unsorted === 1 ? 'is' : 'are'} still uncategorised`}
              </p>
              {item.conflicts > 0 && (
                <p className="text-sm text-danger">
                  Careful: it would also match {plural(item.conflicts, 'transaction')} you put in another category.
                </p>
              )}
            </div>
            <button className="button-quiet" disabled={add.isPending} onClick={() => add.mutate([item])}>
              Add rule
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const payeeKey = (item: UncategorizedPayee) => `${item.payee.toLowerCase()}|${item.type}`;
// Under this (in paise), a payee is noise: a test charge or a coin of change.
const SMALL = 10_000;

type Choice = { payee: string; categoryId: number };

function PayeeLine({
  item,
  options,
  value,
  suggested,
  hint,
  disabled,
  onChange,
  onSort,
}: {
  item: UncategorizedPayee;
  options: Account[];
  value: number | null;
  suggested: boolean;
  hint?: string;
  disabled: boolean;
  onChange: (categoryId: number | null) => void;
  onSort: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
      <div className="min-w-0 lg:w-2/5">
        <p className="truncate text-sm font-medium" title={item.payee}>
          {item.payee}
        </p>
        <p className="text-sm text-muted">
          {plural(item.transactions, 'transaction')} · {formatAmount(item.total)}
          {item.type === 'income' && ' in'}
        </p>
      </div>
      <div className="flex items-center gap-2 lg:flex-1">
        <div className="min-w-0 flex-1">
          <CategorySelect value={value} accounts={options} ownAccountId={null} disabled={disabled} onChange={onChange} />
        </div>
        {hint ? <span className="max-w-48 text-xs text-muted" title={hint}>AI: {hint}</span> : suggested && <span className="text-xs whitespace-nowrap text-muted">Suggested</span>}
      </div>
      <button className="button" disabled={!value || disabled} onClick={onSort}>
        Sort and remember
      </button>
    </li>
  );
}

// The way in when little is sorted yet: a rule can only be suggested from choices
// already made, so this lists what is still unsorted, with the easy decisions
// made for you. Known merchants arrive filled in, payments to people are decided
// together, and tiny amounts are folded away.
function PayeeSorting({ accounts }: { accounts: Account[] }) {
  const client = useQueryClient();
  const payees = useQuery({ queryKey: ['rules', 'payees'], queryFn: api.uncategorizedPayees });
  const friends = accounts.find((a) => a.type === 'expense' && a.name === 'Friends & Family' && !a.isArchived);
  const [chosen, setChosen] = useState<Record<string, number | null>>({});
  const [peopleCategory, setPeopleCategory] = useState<number | null>(friends?.id ?? null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [aiPicks, setAiPicks] = useState<Record<string, { categoryId: number | null; reason: string }>>({});
  const aiState = useQuery({ queryKey: ['ai-categorize'], queryFn: api.aiCategorize });
  const fill = useMutation({
    mutationFn: api.payeePicksAi,
    onSuccess: (r) => {
      setAiPicks(Object.fromEntries(r.picks.map((p) => [`${p.payee.toLowerCase()}|${p.type}`, { categoryId: p.categoryId, reason: `${p.categoryId === null ? `looks like ${p.label}, choose which` : p.label}: ${p.reason}` }])));
      setNotice(r.picks.length === 0 ? 'The model was not sure about any of these. Try Tidy payee names first, so it has cleaner names to work from.' : `The model filled in ${r.picks.length} of ${r.sent}. Check each one, then press Sort and remember.`);
    },
  });

  const sort = useMutation({
    mutationFn: async (choices: Choice[]) => {
      let sorted = 0;
      for (const choice of choices) {
        const rule = await api.createRule({ pattern: choice.payee, matchType: 'contains', categoryId: choice.categoryId });
        sorted += (await api.applyRule(rule.id)).updated;
      }
      return { payees: choices.length, sorted };
    },
    onSuccess: ({ payees: count, sorted }) => {
      setNotice(`${plural(count, 'payee')} sorted: ${plural(sorted, 'transaction')} filed, and a rule saved for each for future imports.`);
      client.invalidateQueries();
    },
  });

  const items = payees.data ?? [];
  if (items.length === 0) return notice ? <p className="text-sm text-muted" aria-live="polite">{notice}</p> : null;

  const expenseOptions = accounts.filter((a) => a.type === 'expense' || isMoneyAccount(a));
  const optionsFor = (item: UncategorizedPayee) =>
    item.type === 'expense' ? expenseOptions : accounts.filter((a) => a.type === 'income');
  const valueOf = (item: UncategorizedPayee) => {
    const key = payeeKey(item);
    return key in chosen ? chosen[key]! : (aiPicks[payeeKey(item)]?.categoryId ?? item.suggestion?.categoryId ?? null);
  };
  const choiceFor = (item: UncategorizedPayee): Choice | null => {
    const categoryId = valueOf(item);
    return categoryId ? { payee: item.payee, categoryId } : null;
  };

  const people = items.filter((item) => item.person && item.type === 'expense');
  const rest = items.filter((item) => !people.includes(item));
  const small = rest.filter((item) => item.total < SMALL);
  const main = rest.filter((item) => item.total >= SMALL);
  const accepting = main.filter((item) => item.suggestion && !(payeeKey(item) in chosen));
  const picked = people.filter((item) => !skipped.has(payeeKey(item)));

  const line = (item: UncategorizedPayee) => (
    <PayeeLine
      key={payeeKey(item)}
      item={item}
      options={optionsFor(item)}
      value={valueOf(item)}
      suggested={Boolean(item.suggestion) && !(payeeKey(item) in chosen)}
      hint={!(payeeKey(item) in chosen) ? aiPicks[payeeKey(item)]?.reason : undefined}
      disabled={sort.isPending}
      onChange={(categoryId) => setChosen({ ...chosen, [payeeKey(item)]: categoryId })}
      onSort={() => {
        const choice = choiceFor(item);
        if (choice) sort.mutate([choice]);
      }}
    />
  );

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-medium">Sort by payee</h2>
        <p className="max-w-2xl text-sm text-muted">
          Ledgerly suggests a rule once you have put a payee in the same category 3 times. Until then, start here. Choosing a category files
          every uncategorised transaction from that payee and remembers it for future imports.
        </p>
      </div>
      {aiState.data?.configured && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="button" disabled={!aiState.data.enabled || fill.isPending} onClick={() => fill.mutate()}>{fill.isPending ? 'Asking…' : 'Fill in with AI'}</button>
          <span className="text-xs text-muted">{aiState.data.enabled ? 'Nothing is filed until you press Sort and remember on a row.' : 'Tick "Suggest categories with AI" above first.'}</span>
        </div>
      )}
      {fill.error && <p className="text-sm text-danger">{fill.error.message}</p>}
      {notice && <p className="text-sm" aria-live="polite">{notice}</p>}
      {sort.isError && <p className="text-sm text-danger">{sort.error.message}</p>}

      {people.length > 0 && (
        <div className="card flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="min-w-0 lg:w-2/5">
              <p className="text-sm font-medium">Payments to people</p>
              <p className="text-sm text-muted">
                {plural(people.length, 'person', 'people')} · {formatAmount(people.reduce((sum, item) => sum + item.total, 0))}. Decide them
                together.
              </p>
            </div>
            <div className="lg:flex-1">
              <CategorySelect
                value={peopleCategory}
                accounts={accounts.filter((a) => a.type === 'expense')}
                ownAccountId={null}
                disabled={sort.isPending}
                onChange={setPeopleCategory}
              />
            </div>
            <button
              className="button"
              disabled={!peopleCategory || picked.length === 0 || sort.isPending}
              onClick={() => sort.mutate(picked.map((item) => ({ payee: item.payee, categoryId: peopleCategory! })))}
            >
              Sort {picked.length} {picked.length === 1 ? 'person' : 'people'}
            </button>
          </div>
          <details>
            <summary className="cursor-pointer text-sm text-muted">Who is included</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {people.map((item) => {
                const key = payeeKey(item);
                return (
                  <li key={key}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!skipped.has(key)}
                        onChange={(e) => {
                          const next = new Set(skipped);
                          if (e.target.checked) next.delete(key);
                          else next.add(key);
                          setSkipped(next);
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{item.payee}</span>
                      <span className="text-muted">{formatAmount(item.total)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-muted">Untick anyone who belongs somewhere else, such as a landlord or someone you pay for work.</p>
          </details>
        </div>
      )}

      {accepting.length > 1 && (
        <div>
          <button
            className="button"
            disabled={sort.isPending}
            onClick={() => sort.mutate(accepting.map((item) => choiceFor(item)!))}
          >
            Accept {accepting.length} suggestions
          </button>
        </div>
      )}

      {main.length > 0 && <ul className="card divide-y divide-line">{main.map(line)}</ul>}

      {small.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer p-4 text-sm text-muted">
            {plural(small.length, 'small payee')} under {formatAmount(SMALL)} ({formatAmount(small.reduce((sum, item) => sum + item.total, 0))} in total)
          </summary>
          <ul className="divide-y divide-line border-t border-line">{small.map(line)}</ul>
        </details>
      )}
    </section>
  );
}

function RuleRow({ rule, accounts }: { rule: Rule; accounts: Account[] }) {
  const client = useQueryClient();
  const [result, setResult] = useState('');
  const [priority, setPriority] = useState(String(rule.priority));
  const refresh = () => client.invalidateQueries({ queryKey: ['rules'] });

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateRule>[1]) => api.updateRule(rule.id, patch),
    onSuccess: refresh,
  });
  const apply = useMutation({
    mutationFn: () => api.applyRule(rule.id),
    onSuccess: ({ updated }) => {
      setResult(updated === 0 ? 'Nothing to change' : `${plural(updated, 'transaction')} updated`);
      client.invalidateQueries();
    },
  });
  const remove = useMutation({ mutationFn: () => api.deleteRule(rule.id), onSuccess: refresh });
  const error = [update, apply, remove].find((m) => m.isError)?.error?.message;

  return (
    <li className={`flex flex-col gap-3 p-4 ${rule.isActive ? '' : 'opacity-60'}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 lg:w-1/3">
          <p className="truncate font-mono text-sm" title={rule.pattern}>
            {rule.pattern}
            {rule.createdBy === 'auto' && (
              <span className="ml-2 rounded border border-line px-1.5 font-sans text-xs text-muted" title="Made by Ledgerly">
                Auto
              </span>
            )}
          </p>
          <p className="text-sm text-muted">
            {MATCH_LABEL[rule.matchType]}
            {rule.minAmount !== null && ` · from ${formatAmount(rule.minAmount).replace(/\.00$/, '')}`}
            {rule.maxAmount !== null && ` · up to ${formatAmount(rule.maxAmount).replace(/\.00$/, '')}`}
            {rule.accountId !== null && ` · ${accounts.find((a) => a.id === rule.accountId)?.name ?? 'one account'} only`}
          </p>
        </div>
        <div className="lg:flex-1">
          <CategorySelect
            value={rule.categoryId}
            accounts={accounts}
            ownAccountId={null}
            disabled={update.isPending}
            allowEmpty={false}
            onChange={(categoryId) => categoryId && update.mutate({ categoryId })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted" title="Rules with a lower number are tried first">
          Order
          <input
            className="field w-20"
            inputMode="numeric"
            aria-label={`Order for ${rule.pattern}`}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            onBlur={() => {
              const next = Number(priority);
              if (Number.isInteger(next) && next >= 0 && next !== rule.priority) update.mutate({ priority: next });
              else setPriority(String(rule.priority));
            }}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={rule.isActive} onChange={(e) => update.mutate({ isActive: e.target.checked })} />
          On
        </label>
        <div className="flex gap-2">
          <button className="button-quiet" disabled={apply.isPending || !rule.isActive} title="Apply to transactions that are still uncategorised" onClick={() => apply.mutate()}>
            Apply now
          </button>
          <button
            className="button-quiet"
            disabled={remove.isPending}
            onClick={() => window.confirm(`Delete the rule for "${rule.pattern}"?`) && remove.mutate()}
          >
            Delete
          </button>
        </div>
      </div>
      {(result || error) && <p className={`text-sm ${error ? 'text-danger' : 'text-muted'}`}>{error ?? result}</p>}
    </li>
  );
}

export function RulesPage() {
  const client = useQueryClient();
  const rules = useQuery({ queryKey: ['rules'], queryFn: api.rules });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [notice, setNotice] = useState('');

  const applyAll = useMutation({
    mutationFn: api.applyAllRules,
    onSuccess: ({ updated }) => {
      setNotice(updated === 0 ? 'No uncategorised transactions matched a rule.' : `${plural(updated, 'transaction')} sorted.`);
      client.invalidateQueries();
    },
  });

  if (rules.isError) return <p className="text-sm text-danger">{rules.error.message}</p>;
  const list = rules.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <SectionTabs section="organise" />
          <p className="mt-1 max-w-xl text-sm text-muted">
            A rule puts transactions into a category when their payee or description matches. They apply to every statement you import, and
            to what you already have when you press Apply. A transaction you sorted yourself is never changed.
          </p>
        </div>
        {list.length > 0 && (
          <button className="button-quiet" disabled={applyAll.isPending} onClick={() => applyAll.mutate()}>
            Apply all rules to uncategorised transactions
          </button>
        )}
      </header>

      {notice && <p className="text-sm text-muted" aria-live="polite">{notice}</p>}
      {applyAll.isError && <p className="text-sm text-danger">{applyAll.error.message}</p>}

      <AutoRules />

      <Suggestions />
      <AiSuggestions />
      <PayeeTidy />
      <RuleHealth />

      {accounts.data && <PayeeSorting accounts={accounts.data} />}

      {accounts.data && <AddRule accounts={accounts.data} />}

      {rules.isSuccess && list.length === 0 ? (
        <p className="card p-6 text-sm text-muted">
          No rules yet. Add one above, press Remember when you review an import, or approve a rule an agent suggests.
        </p>
      ) : (
        accounts.data && (
          <ul className="card divide-y divide-line">
            {list.map((rule) => (
              <RuleRow key={rule.id} rule={rule} accounts={accounts.data} />
            ))}
          </ul>
        )
      )}
    </div>
  );
}
