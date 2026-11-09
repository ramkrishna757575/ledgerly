import { formatAmount } from '@ledgerly/core/money';
import { SectionTabs } from '../components/SectionTabs.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, fmtDate, fmtDateTime, type AgentToken, type Proposal } from '../api.ts';

const KIND_LABEL = {
  categorize_transaction: 'Change a category',
  categorize_import_row: 'Statement row',
  create_rule: 'New rule',
} as const;

const SCOPE_LABEL = { read: 'Read only', propose: 'Read and suggest' } as const;

function describeProposal(proposal: Proposal) {
  if (proposal.rule) {
    const how = proposal.rule.matchType === 'regex' ? 'matches' : 'contains';
    return {
      title: `Payee or description ${how} “${proposal.rule.pattern}”`,
      detail: `Put future transactions in ${proposal.to ?? 'a category'}`,
    };
  }
  if (!proposal.target) return { title: 'This item no longer exists', detail: '' };
  const { target } = proposal;
  return {
    title: target.payee ?? target.description,
    detail: `${fmtDate(target.date)}${target.account ? ` · ${target.account}` : ''} · ${formatAmount(target.amount)} · ${proposal.from ?? 'No category'} → ${proposal.to}`,
  };
}

function ProposalRow({ proposal, onDecide, busy }: { proposal: Proposal; onDecide?: (id: number, decision: 'approve' | 'reject') => void; busy?: boolean }) {
  const { title, detail } = describeProposal(proposal);
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs text-muted">{KIND_LABEL[proposal.kind]}</p>
        <p className="truncate text-sm font-medium" title={title}>
          {title}
        </p>
        {detail && <p className="text-sm text-muted">{detail}</p>}
        {proposal.reason && <p className="mt-1 text-sm">“{proposal.reason}”</p>}
        <p className="mt-1 text-xs text-muted">
          Suggested by {proposal.source} · {fmtDateTime(proposal.createdAt)}
          {proposal.status !== 'pending' && ` · ${proposal.status}`}
        </p>
        {proposal.error && <p className="mt-1 text-sm text-danger">Not applied: {proposal.error}</p>}
      </div>
      {onDecide && (
        <div className="flex shrink-0 gap-2">
          <button className="button" disabled={busy} onClick={() => onDecide(proposal.id, 'approve')}>
            Approve
          </button>
          <button className="button-quiet" disabled={busy} onClick={() => onDecide(proposal.id, 'reject')}>
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

function Pending() {
  const client = useQueryClient();
  const pending = useQuery({ queryKey: ['agents', 'proposals', 'pending'], queryFn: () => api.proposals('pending') });
  const [notice, setNotice] = useState('');
  const refresh = () => client.invalidateQueries();

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'approve' | 'reject' }) =>
      decision === 'approve' ? api.approveProposal(id) : api.rejectProposal(id),
    onSuccess: (result) => {
      setNotice(result.status === 'failed' ? `Not applied: ${result.error}` : '');
      refresh();
    },
  });
  const decideAll = useMutation({
    mutationFn: api.decideAll,
    onSuccess: ({ done, failed }, decision) => {
      setNotice(`${done} ${decision === 'approve' ? 'approved' : 'rejected'}${failed ? `, ${failed} could not be applied` : ''}.`);
      refresh();
    },
  });

  const items = pending.data ?? [];
  const busy = decide.isPending || decideAll.isPending;
  const error = (decide.error ?? decideAll.error)?.message;

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Waiting for your approval{items.length > 0 && ` (${items.length})`}</h2>
        {items.length > 1 && (
          <div className="flex gap-2">
            <button className="button" disabled={busy} onClick={() => decideAll.mutate('approve')}>
              Approve all
            </button>
            <button className="button-quiet" disabled={busy} onClick={() => decideAll.mutate('reject')}>
              Reject all
            </button>
          </div>
        )}
      </header>
      {notice && <p className="text-sm text-muted" aria-live="polite">{notice}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {pending.isSuccess && items.length === 0 ? (
        <p className="card p-6 text-sm text-muted">
          Nothing is waiting. When an agent suggests a category or a rule, it appears here, and nothing changes until you approve it.
        </p>
      ) : (
        <ul className="card divide-y divide-line">
          {items.map((proposal) => (
            <ProposalRow key={proposal.id} proposal={proposal} busy={busy} onDecide={(id, decision) => decide.mutate({ id, decision })} />
          ))}
        </ul>
      )}
    </section>
  );
}

function History() {
  const [open, setOpen] = useState(false);
  const all = useQuery({ queryKey: ['agents', 'proposals', 'all'], queryFn: () => api.proposals(), enabled: open });
  const done = (all.data ?? []).filter((p) => p.status !== 'pending').slice(0, 30);
  return (
    <section className="flex flex-col gap-3">
      <button className="button-quiet self-start" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} earlier suggestions
      </button>
      {open && (done.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
        <ul className="card divide-y divide-line">
          {done.map((proposal) => (
            <ProposalRow key={proposal.id} proposal={proposal} />
          ))}
        </ul>
      ))}
    </section>
  );
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The text is on screen to select by hand.
    }
  }
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-page p-3 text-xs">{text}</pre>
      <button className="button-quiet shrink-0" aria-label={`Copy ${label}`} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Connect({ token }: { token?: string }) {
  const url = `${window.location.origin}/mcp`;
  const shown = token ?? 'YOUR_TOKEN';
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-2">
        <p className="font-medium">An agent that connects over the network</p>
        <p className="text-muted">Point it at this address and send the token as a bearer token. In Claude Code:</p>
        <CopyBlock label="Claude Code command" text={`claude mcp add --transport http ledgerly ${url} --header "Authorization: Bearer ${shown}"`} />
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-medium">An agent on the same machine</p>
        <p className="text-muted">
          It reads the database directly and needs no token. Add this to its MCP settings, with the path to this project. Set
          LEDGERLY_MCP_SCOPE to read to stop it suggesting anything.
        </p>
        <CopyBlock
          label="local configuration"
          text={JSON.stringify({ mcpServers: { ledgerly: { command: 'node', args: ['/path/to/money-manager/packages/mcp/src/stdio.ts'] } } }, null, 2)}
        />
      </div>
    </div>
  );
}

function TokenRow({ token }: { token: AgentToken }) {
  const client = useQueryClient();
  const revoke = useMutation({ mutationFn: () => api.revokeAgentToken(token.id), onSuccess: () => client.invalidateQueries({ queryKey: ['agents'] }) });
  return (
    <li className={`flex flex-wrap items-center justify-between gap-3 p-4 ${token.revokedAt ? 'opacity-60' : ''}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{token.name}</p>
        <p className="text-sm text-muted">
          {SCOPE_LABEL[token.scope]} · {token.tokenPrefix}… · {token.lastUsedAt ? `used ${fmtDateTime(token.lastUsedAt)}` : 'never used'}
        </p>
      </div>
      {token.revokedAt ? (
        <span className="text-sm text-muted">Revoked</span>
      ) : (
        <button
          className="button-quiet"
          disabled={revoke.isPending}
          onClick={() => window.confirm(`Revoke "${token.name}"? Anything using it stops working.`) && revoke.mutate()}
        >
          Revoke
        </button>
      )}
    </li>
  );
}

function Access({ demo }: { demo: boolean }) {
  const client = useQueryClient();
  const tokens = useQuery({ queryKey: ['agents', 'tokens'], queryFn: api.agentTokens });
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'propose'>('propose');
  const [created, setCreated] = useState<(AgentToken & { token: string }) | null>(null);

  const create = useMutation({
    mutationFn: () => api.createAgentToken(name.trim(), scope),
    onSuccess: (result) => {
      setCreated(result);
      setName('');
      client.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setCreated(null);
    create.mutate();
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Connect an agent</h2>
      <p className="max-w-2xl text-sm text-muted">
        An agent can look at your accounts, spending and transactions, and suggest categories and rules. It can never change, delete or import
        anything itself, and every request is logged below.
      </p>

      {demo ? (
        <p className="card p-4 text-sm text-muted">Agent access is turned off in the demo.</p>
      ) : (
        <form onSubmit={submit} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
          <label className="label sm:flex-1">
            Name
            <input className="field" required maxLength={60} placeholder="Claude on my laptop" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="label">
            Access
            <select className="field" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="propose">Read and suggest</option>
              <option value="read">Read only</option>
            </select>
          </label>
          <button className="button" disabled={create.isPending || !name.trim()}>
            Create token
          </button>
        </form>
      )}
      {create.isError && <p className="text-sm text-danger">{create.error.message}</p>}

      {created && (
        <div className="card flex flex-col gap-3 border-accent p-4" role="status">
          <p className="text-sm">
            <strong className="font-medium">Copy this token now.</strong> It is shown once, and only a fingerprint of it is kept.
          </p>
          <CopyBlock label="token" text={created.token} />
          <Connect token={created.token} />
        </div>
      )}

      {(tokens.data ?? []).length > 0 && (
        <ul className="card divide-y divide-line">
          {tokens.data?.map((token) => (
            <TokenRow key={token.id} token={token} />
          ))}
        </ul>
      )}

      {!created && !demo && (
        <details className="card p-4">
          <summary className="cursor-pointer text-sm font-medium">How to connect</summary>
          <div className="mt-3">
            <Connect />
          </div>
        </details>
      )}
    </section>
  );
}

function Activity() {
  const activity = useQuery({ queryKey: ['agents', 'activity'], queryFn: api.agentActivity });
  const rows = activity.data ?? [];
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Recent activity</h2>
      {activity.isSuccess && rows.length === 0 ? (
        <p className="card p-6 text-sm text-muted">No agent has used Ledgerly yet.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-4 py-2 font-normal">When</th>
                <th className="px-4 py-2 font-normal">Agent</th>
                <th className="px-4 py-2 font-normal">Did</th>
                <th className="px-4 py-2 font-normal">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap text-muted">{fmtDateTime(row.at)}</td>
                  <td className="px-4 py-2">{row.actor}</td>
                  <td className="px-4 py-2 font-mono text-xs">{row.tool}</td>
                  <td className={`px-4 py-2 ${row.outcome === 'ok' ? '' : 'text-danger'}`} title={row.detail ?? undefined}>
                    {row.outcome === 'ok' ? 'Done' : (row.detail ?? row.outcome)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AgentsPage() {
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  return (
    <div className="flex flex-col gap-8">
      <SectionTabs section="automation" />
      <Pending />
      <History />
      <Access demo={auth.data?.demo ?? false} />
      <Activity />
    </div>
  );
}
