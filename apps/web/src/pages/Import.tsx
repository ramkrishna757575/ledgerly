import { Payslips } from '../components/Payslips.tsx';
import { LearnFormat, LearnedFormats } from '../components/LearnFormat.tsx';
import { BankAlerts } from '../components/BankAlerts.tsx';
import { Coverage } from '../components/Coverage.tsx';
import { formatAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  fmtDate,
  fmtDateTime,
  isMoneyAccount,
  type Account,
  type ImportBatch,
  type CommitReady,
  type ImportSummary,
  type StagedRow,
} from '../api.ts';
import { needsPassword, sendWithPassword } from '../pdfPassword.ts';
import { CategorySelect } from '../components/CategorySelect.tsx';
import type { ImportSearch } from '../search.ts';

const ROW_LABEL: Record<string, string> = {
  duplicate: 'Already imported',
  skipped: 'Skipped',
  committed: 'Imported',
  undone: 'Undone',
};

const needsCardChoice = (item: StagedRow) =>
  item.status === 'pending' && item.channel === 'card_payment' && item.categoryId === null;

function Row({
  item,
  accounts,
  ownAccountId,
  editable,
  busy,
  onPatch,
}: {
  item: StagedRow;
  accounts: Account[];
  ownAccountId: number | null;
  editable: boolean;
  busy: boolean;
  onPatch: (rowId: number, patch: Parameters<typeof api.updateRow>[1]) => void;
}) {
  const settled = item.status !== 'pending' && item.status !== 'skipped';
  const dimmed = item.status !== 'pending';
  const locked = !editable || settled || item.status === 'skipped';
  // Recording a card payment as spending would count it twice, so it needs a card.
  const needsChoice = editable && needsCardChoice(item);

  return (
    <li
      className={`flex flex-col gap-3 p-4 lg:flex-row lg:items-center ${dimmed ? 'opacity-60' : ''} ${
        needsChoice ? 'border-l-2 border-danger' : ''
      }`}
    >
      <div className="min-w-0 lg:w-2/5">
        <p className="truncate text-sm font-medium">{item.payee ?? item.description}</p>
        <p className="truncate text-sm text-muted" title={item.description}>
          {fmtDate(item.date)} · {item.description}
        </p>
        {needsChoice && <p className="text-sm text-danger">Choose the card this payment was for</p>}
      </div>
      <p className={`text-sm whitespace-nowrap lg:w-32 lg:text-right ${item.amount > 0 ? 'text-accent' : ''}`}>
        {formatAmount(item.amount)}
      </p>
      <div className="flex flex-1 items-center gap-2">
        {item.status === 'pending' || item.status === 'skipped' ? (
          <>
            <div className="min-w-0 flex-1">
              <CategorySelect
                value={item.categoryId}
                accounts={accounts}
                ownAccountId={ownAccountId}
                disabled={locked || busy}
                onChange={(categoryId) => onPatch(item.id, { categoryId })}
              />
            </div>
            {editable && item.categorySource === 'manual' && item.categoryId && item.status === 'pending' && (
              <button
                className="button-quiet whitespace-nowrap"
                disabled={busy}
                title="Use this category for similar transactions from now on"
                onClick={() => onPatch(item.id, { categoryId: item.categoryId, createRule: true })}
              >
                Remember
              </button>
            )}
            {editable && (
              <button
                className="button-quiet whitespace-nowrap"
                disabled={busy}
                onClick={() => onPatch(item.id, { status: item.status === 'skipped' ? 'pending' : 'skipped' })}
              >
                {item.status === 'skipped' ? 'Include' : 'Skip'}
              </button>
            )}
          </>
        ) : (
          <span className="text-sm text-muted">{ROW_LABEL[item.status]}</span>
        )}
      </div>
      {item.categorySource === 'rule' && item.status === 'pending' && (
        <span className="text-xs text-muted lg:w-14">Rule</span>
      )}
    </li>
  );
}

function Review({ id, onClose }: { id: number; onClose: () => void }) {
  const client = useQueryClient();
  const [acceptMismatch, setAcceptMismatch] = useState(false);
  const batch = useQuery({ queryKey: ['import', id], queryFn: () => api.importBatch(id) });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });

  const refresh = () => {
    client.invalidateQueries({ queryKey: ['import', id] });
    client.invalidateQueries({ queryKey: ['imports'] });
  };
  useEffect(() => {
    // Picks up accounts and rules added since the statement was read.
    api.refreshSuggestions(id).then(refresh, () => {});
  }, [id]);
  const patchRow = useMutation({
    mutationFn: ({ rowId, patch }: { rowId: number; patch: Parameters<typeof api.updateRow>[1] }) =>
      api.updateRow(rowId, patch),
    onSuccess: refresh,
  });
  const assign = useMutation({ mutationFn: (accountId: number) => api.assignAccount(id, accountId), onSuccess: refresh });
  const commit = useMutation({
    mutationFn: () => api.commitImport(id, acceptMismatch),
    onSuccess: () => client.invalidateQueries(),
  });
  const undo = useMutation({ mutationFn: () => api.undoImport(id), onSuccess: () => client.invalidateQueries() });
  const discard = useMutation({
    mutationFn: () => api.discardImport(id),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['imports'] });
      onClose();
    },
  });

  const error = [patchRow, assign, commit, undo, discard].find((m) => m.isError)?.error?.message;
  if (batch.isError) return <p className="text-sm text-danger">{batch.error.message}</p>;
  if (!batch.data || !accounts.data) return <p className="text-sm text-muted">Loading…</p>;

  const data: ImportBatch = batch.data;
  const staged = data.status === 'staged';
  const busy = patchRow.isPending || assign.isPending;
  const count = (status: string) => data.items.filter((item) => item.status === status).length;
  const toImport = count('pending');
  const fitting = accounts.data.filter(
    (a) => !a.isArchived && a.type === (data.accountKind === 'credit_card' ? 'liability' : 'asset'),
  );
  const needsConfirm = data.reconciliation === 'mismatch';
  const needsCard = data.items.filter(needsCardChoice).length;
  // Banks print the card's last four digits in the payment narration.
  const cardDigits = /\b(\d{4})\b/.exec(data.items.find(needsCardChoice)?.description ?? '')?.[1];
  const cards = accounts.data.filter((a) => !a.isArchived && a.subtype === 'credit_card');
  const hasCard = cards.length > 0;
  const cardKnown = cards.some((a) => a.numberLast4 === cardDigits);
  const offerCard = !hasCard || (cardDigits !== undefined && !cardKnown);

  return (
    <section className="card flex flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{data.filename}</h2>
          <p className="text-sm text-muted">
            {data.periodStart && data.periodEnd
              ? `${fmtDate(data.periodStart)} to ${fmtDate(data.periodEnd)}`
              : 'Period not found'}
            {' · '}
            {data.items.length} transactions
          </p>
        </div>
        <button className="button-quiet" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="flex flex-col gap-3 border-b border-line p-4 text-sm">
        {data.reconciliation === 'ok' && (
          <p className="text-accent">The transactions add up to the statement's own totals.</p>
        )}
        {data.reconciliation === 'unchecked' && (
          <p className="text-muted">This statement has no totals to check against.</p>
        )}
        {data.accountKind === 'credit_card' &&
          data.items.some((item) => item.channel === 'card_payment' && item.status === 'skipped') && (
            <p className="text-muted">
              Payments to the card are skipped here because your bank statement records them as transfers. Include one
              and choose the account it came from if you pay from an account you don't import.
            </p>
          )}
        {staged && needsCard > 0 && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-danger">
              {needsCard === 1 ? '1 card payment needs' : `${needsCard} card payments need`} a card before importing.{' '}
              {hasCard ? 'Pick the card in the highlighted rows, or skip them.' : 'You have no credit card account yet.'}
            </p>
            {offerCard && (
              <Link
                to="/accounts"
                search={{
                  add: 'credit_card',
                  name: cardDigits ? `Credit Card ${cardDigits}` : 'Credit Card',
                  last4: cardDigits,
                  back: id,
                }}
                className="button"
              >
                Add credit card{cardDigits ? ` ending ${cardDigits}` : ''}
              </Link>
            )}
          </div>
        )}
        {data.warnings.map((warning) => (
          <p key={warning} className="text-danger">
            {warning}
          </p>
        ))}
        <label className="label max-w-sm">
          Account
          {staged ? (
            <select
              className="field"
              value={data.accountId ?? ''}
              disabled={assign.isPending}
              onChange={(e) => assign.mutate(Number(e.target.value))}
            >
              {data.accountId === null && <option value="">Choose an account…</option>}
              {fitting.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-ink">{data.accountName}</span>
          )}
        </label>
        {staged && fitting.length === 0 && (
          <Link
            to="/accounts"
            search={{
              add: data.accountKind === 'credit_card' ? 'credit_card' : 'bank',
              name: `${data.bank ?? ''} ${data.accountKind === 'credit_card' ? 'Credit Card' : 'Savings'}`.trim(),
              last4: data.accountLast4 ?? undefined,
              institution: data.bank ?? undefined,
              back: id,
            }}
            className="button w-fit"
          >
            Add {data.accountKind === 'credit_card' ? 'credit card' : 'bank account'}
            {data.accountLast4 ? ` ending ${data.accountLast4}` : ''}
          </Link>
        )}
      </div>

      <ul className="divide-y divide-line">
        {data.items.map((item) => (
          <Row
            key={item.id}
            item={item}
            accounts={accounts.data}
            ownAccountId={data.accountId}
            editable={staged}
            busy={busy}
            onPatch={(rowId, patch) => patchRow.mutate({ rowId, patch })}
          />
        ))}
      </ul>

      <footer className="flex flex-col gap-3 border-t border-line p-4">
        {error && <p className="text-sm text-danger">{error}</p>}
        {commit.data?.autoRules && commit.data.autoRules.created > 0 && (
          <p className="text-sm text-muted" aria-live="polite">
            Ledgerly also created {commit.data.autoRules.created} {commit.data.autoRules.created === 1 ? 'rule' : 'rules'} automatically from your
            choices. You can review them under Rules.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <p className="mr-auto text-sm text-muted">
            {staged
              ? `${toImport} to import · ${count('duplicate')} already imported · ${count('skipped')} skipped`
              : `${count('committed')} imported`}
          </p>
          {staged && needsConfirm && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={acceptMismatch} onChange={(e) => setAcceptMismatch(e.target.checked)} />
              Import anyway
            </label>
          )}
          {staged && (
            <>
              <button className="button-quiet" disabled={discard.isPending} onClick={() => discard.mutate()}>
                Discard
              </button>
              <button
                className="button"
                disabled={
                  commit.isPending ||
                  toImport === 0 ||
                  data.accountId === null ||
                  needsCard > 0 ||
                  (needsConfirm && !acceptMismatch)
                }
                onClick={() => commit.mutate()}
              >
                Import {toImport} transactions
              </button>
            </>
          )}
          {data.status === 'committed' && (
            <button
              className="button-quiet"
              disabled={undo.isPending}
              onClick={() => window.confirm('Remove every transaction this import created?') && undo.mutate()}
            >
              Undo import
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

function UploadCard({ onStaged, onBulk }: { onStaged: (batch: ImportBatch) => void; onBulk: (files: File[]) => void }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const file = files.length === 1 ? files[0]! : null;
  const [password, setPassword] = useState('');
  // Stays up while the next attempt is being read, or the box would vanish as you submit.
  const [locked, setLocked] = useState(false);
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const demo = auth.data?.demo ?? false;
  const samples = useQuery({ queryKey: ['samples'], queryFn: api.demoSamples, enabled: demo });

  const done = (batch: ImportBatch) => {
    client.invalidateQueries({ queryKey: ['imports'] });
    setFiles([]);
    setPassword('');
    setLocked(false);
    if (input.current) input.current.value = '';
    onStaged(batch);
  };
  const upload = useMutation({ mutationFn: (selected: File) => sendWithPassword((pw) => api.upload(selected, undefined, pw), password), onSuccess: done,
    onError: (error) => needsPassword(error) && setLocked(true),
  });
  const sample = useMutation({ mutationFn: api.stageSample, onSuccess: done });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (files.length > 1) {
      onBulk(files);
      setFiles([]);
      if (input.current) input.current.value = '';
    } else if (file) upload.mutate(file);
  }

  const error = (upload.error ?? sample.error)?.message;

  return (
    <section className="card flex flex-col gap-4 p-4">
      {demo ? (
        <>
          <div>
            <h2 className="font-medium">Try an import</h2>
            <p className="mt-1 text-sm text-muted">
              Uploads are off in demo mode. These made-up statements show how an import works.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {samples.data?.map((s) => (
              <button key={s.id} className="button" disabled={sample.isPending} onClick={() => sample.mutate(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <h2 className="font-medium">Upload a statement</h2>
            <p className="mt-1 text-sm text-muted">
              Axis Bank savings and credit card PDFs, bank CSV downloads from most banks, and mutual fund statements. The files stay on this machine.
              Choose one to review it, or select a whole folder's worth at once to import them in bulk.
            </p>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept="application/pdf,.pdf,.csv,.tsv,.xlsx,text/csv"
            aria-label="Statement PDFs"
            className="text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-ink"
            onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setPassword(''); setLocked(false); upload.reset(); }}
          />
          {locked && (
            <label className="label max-w-xs">
              PDF password
              <input
                className="field"
                type="password"
                autoComplete="off"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="text-xs">Banks often use your date of birth or customer ID. It is used once to read the file and is not saved.</span>
            </label>
          )}
          <div>
            <button className="button" disabled={files.length === 0 || upload.isPending}>
              {upload.isPending ? 'Reading…' : files.length > 1 ? `Read ${files.length} statements` : 'Read statement'}
            </button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}

// A folder on the machine that statements are dropped into, for people who would rather not upload each one.
function InboxCard() {
  const client = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: api.inbox, enabled: !(auth.data?.demo ?? true), refetchInterval: 30_000 });
  const scanned = inbox.data?.lastScan;
  const scannedSeen = useRef(scanned);
  useEffect(() => {
    if (scanned !== scannedSeen.current) client.invalidateQueries();
    scannedSeen.current = scanned;
  }, [scanned, client]);
  const scan = useMutation({ mutationFn: api.scanInbox, onSuccess: () => client.invalidateQueries() });
  if (auth.data?.demo || !inbox.data) return null;
  const { enabled, folder, lastScan, results, lastImport } = inbox.data;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Statement folder</h2>
        {enabled && <button className="button-quiet" disabled={scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? 'Looking…' : 'Look now'}</button>}
      </header>
      {enabled ? (
        <>
          <p className="text-sm text-muted">
            Drop statements (PDF, or a CSV of holdings) into <code>{folder}</code> and they are imported by themselves, checked every five minutes, with the safe ones added and the rest left here for review. Files move to <code>processed</code>, or to <code>held</code> if they could not be read.
          </p>
          <p className="text-xs text-muted">
            {lastScan ? `Last looked ${fmtDate(lastScan)}.` : 'Not looked yet.'}
            {lastImport && ` Last import: ${lastImport.imported} added${lastImport.held ? `, ${lastImport.held} waiting for review` : ''}.`}
          </p>
          {results.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {results.slice(0, 8).map((r, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span className="min-w-0 truncate" title={r.file}>{r.file}</span>
                  <span className={r.outcome === 'held' ? 'text-danger' : 'text-muted'}>{r.outcome === 'staged' ? 'Read' : r.outcome === 'already' ? 'Already imported' : r.note}</span>
                </li>
              ))}
            </ul>
          )}
          {scan.error && <p className="text-sm text-danger">{scan.error.message}</p>}
        </>
      ) : (
        <p className="text-sm text-muted">
          Not set up. Turn on your own folder under Settings, or set <code>WATCH_DIR</code> to a folder (in Docker, mount one at <code>/inbox</code> and set <code>WATCH_DIR=/inbox</code>), optionally with <code>WATCH_PASSWORDS</code> for locked statements, and restart. A mail rule or your browser's download folder can then feed it.
        </p>
      )}
    </section>
  );
}

// Statements sent to a mailbox are collected from there, from the senders you named.
function MailCard() {
  const client = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const mail = useQuery({ queryKey: ['mail'], queryFn: api.mail, enabled: !(auth.data?.demo ?? true), refetchInterval: 30_000 });
  // When a check has run since the page last looked, bring the lists below up to date too.
  const checked = mail.data?.lastCheck;
  const seen = useRef(checked);
  useEffect(() => {
    if (checked !== seen.current) client.invalidateQueries();
    seen.current = checked;
  }, [checked, client]);
  const scan = useMutation({ mutationFn: api.scanMail, onSuccess: () => client.invalidateQueries() });
  if (auth.data?.demo || !mail.data) return null;
  const { enabled, problem, mailbox, senders, lastCheck, lastError, results, lastImport, nextCheck } = mail.data;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Statements from email</h2>
        {enabled && <button className="button-quiet" disabled={scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? 'Checking…' : 'Check now'}</button>}
      </header>
      {enabled ? (
        <>
          <p className="text-sm text-muted">
            Reading unread mail in <code>{mailbox}</code> from {senders.join(', ')} every 15 minutes. PDF and CSV attachments are read and imported by the same safe rules as bulk import; what needs a look waits for you. Mail from anyone else is never opened, and mail that only claims to be from them is not believed.
          </p>
          <p className="text-xs text-muted">
            {lastCheck ? `Last checked ${fmtDateTime(lastCheck)}.` : 'Not checked yet.'}
            {nextCheck && ` Next check ${new Date(nextCheck).getTime() <= Date.now() ? 'any moment' : `about ${fmtDateTime(nextCheck)}`}.`}
            {lastImport && ` Last import: ${lastImport.imported} added${lastImport.held ? `, ${lastImport.held} waiting for review` : ''}.`}
          </p>
          {lastError && <p className="text-sm text-danger">The last check failed: {lastError}</p>}
          {results.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {results.slice(0, 8).map((r, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span className="min-w-0 truncate" title={`${r.file} from ${r.from}`}>{r.file} <span className="text-muted">from {r.from}</span></span>
                  <span className={r.outcome === 'held' ? 'text-danger' : 'text-muted'}>{r.outcome === 'staged' ? 'Read' : r.outcome === 'already' ? 'Already imported' : r.note}</span>
                </li>
              ))}
            </ul>
          )}
          {scan.error && <p className="text-sm text-danger">{scan.error.message}</p>}
        </>
      ) : (
        <div className="text-sm text-muted">
          <p>{problem ? <span className="text-danger">{problem}. </span> : null}Not set up. Use a mailbox just for statements (a new Gmail or Outlook address that your bank mail is forwarded to) and an app password, not your main one. Add it under Settings, or set these in <code>.env</code> and restart:</p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-line p-3 text-xs">{`MAIL_HOST=imap.gmail.com
MAIL_USER=statements@example.com
MAIL_PASSWORD=<app password>
MAIL_SENDERS=axisbank.com,scripbox.com
# Optional: MAIL_FOLDER=INBOX  MAIL_PORT=993  WATCH_PASSWORDS=pass1,pass2`}</pre>
        </div>
      )}
    </section>
  );
}

function History({ items, onOpen }: { items: ImportSummary[]; onOpen: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 font-medium">Imports</h2>
      <ul className="card divide-y divide-line">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{item.filename}</p>
              <p className="truncate text-sm text-muted">
                {item.accountName ?? 'No account yet'} · {item.counts.total} transactions
                {item.status === 'staged' && ` · ${item.counts.pending} waiting`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted capitalize">{item.status === 'staged' ? 'To review' : item.status}</span>
              <button className="button-quiet" onClick={() => onOpen(item.id)}>
                {item.status === 'staged' ? 'Review' : 'View'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

type BulkState = 'waiting' | 'reading' | 'read' | 'locked' | 'failed';
type BulkItem = { file: File; state: BulkState; message?: string; kind?: 'bank' | 'investment'; id?: number };

// Reads each statement in turn, then imports the ones that are safe to import
// without a look. Whatever is left is listed with the reason.
function BulkRun({ files, onReview, onClose }: { files: File[]; onReview: (id: number) => void; onClose: () => void }) {
  const client = useQueryClient();
  const [items, setItems] = useState<BulkItem[]>(() => files.map((file) => ({ file, state: 'waiting' })));
  const [password, setPassword] = useState('');
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<CommitReady | null>(null);

  const patch = (index: number, change: Partial<BulkItem>) => setItems((all) => all.map((item, i) => (i === index ? { ...item, ...change } : item)));

  async function readAll(retryLocked: boolean, only?: number) {
    setRunning(true);
    setStarted(true);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (only !== undefined ? i !== only : item.state === 'read' || (item.state === 'failed' && !retryLocked) || (item.state === 'locked' && !retryLocked)) continue;
      patch(i, { state: 'reading', message: undefined });
      try {
        const staged = await sendWithPassword((pw) => api.uploadStatement(item.file, pw), password);
        patch(i, { state: 'read', kind: staged.kind, id: staged.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not be read';
        patch(i, needsPassword(error) ? { state: 'locked', message } : { state: 'failed', message });
      }
    }
    setRunning(false);
    client.invalidateQueries();
  }

  const preview = useMutation({ mutationFn: api.previewReady });
  const importReady = useMutation({
    mutationFn: api.commitReady,
    onSuccess: (result) => {
      setOutcome(result);
      client.invalidateQueries();
    },
  });

  const count = (state: BulkState) => items.filter((i) => i.state === state).length;
  const locked = count('locked');
  const read = count('read');
  const finished = started && !running;

  return (
    <section className="card flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Importing {items.length} statements</h2>
        <button className="button-quiet" disabled={running || importReady.isPending} onClick={onClose}>Close</button>
      </header>

      {!started && (
        <div className="flex flex-col gap-3">
          <label className="label max-w-xs">
            Password for locked files (optional)
            <input className="field" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="text-xs">Used once to read them, not saved. If files need different passwords, you will be asked again for the rest.</span>
          </label>
          <div><button className="button" onClick={() => readAll(false)}>Start reading</button></div>
        </div>
      )}

      <ul className="divide-y divide-line text-sm">
        {items.map((item, i) => (
          <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
            <span className="min-w-0 truncate" title={item.file.name}>{item.file.name}</span>
            <span className={item.state === 'failed' || item.state === 'locked' ? 'text-danger' : 'text-muted'}>
              {item.state === 'waiting' && 'Waiting'}
              {item.state === 'reading' && 'Reading…'}
              {item.state === 'read' && (item.kind === 'investment' ? 'Fund statement read' : 'Statement read')}
              {(item.state === 'failed' || item.state === 'locked') && item.message}
            </span>
            {item.state === 'failed' && /not supported/i.test(item.message ?? '') && (
              <LearnFormat file={item.file} password={password} onLearned={() => readAll(false, i)} />
            )}
          </li>
        ))}
      </ul>

      {finished && locked > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="label max-w-xs">
            Password for the locked files
            <input className="field" type="password" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="button" disabled={running || !password} onClick={() => readAll(true)}>Retry {locked} locked</button>
        </div>
      )}

      {finished && read > 0 && !outcome && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            {read} {read === 1 ? 'statement is' : 'statements are'} read and nothing is in your books yet. Importing adds every one that is safe to add
            without a look, oldest first. A statement is held back for review if its transactions do not add up to its own totals, if no account matched it,
            or if it needs a decision. Accounts that do not exist yet are created from the bank name and the last four digits.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="button-quiet" disabled={preview.isPending || running} onClick={() => preview.mutate()}>{preview.isPending ? 'Working it out…' : 'Preview what will happen'}</button>
            <button className="button" disabled={importReady.isPending || running} onClick={() => importReady.mutate()}>{importReady.isPending ? 'Importing…' : `Import ${read}`}</button>
          </div>
          {preview.error && <p className="text-sm text-danger">{preview.error.message}</p>}
          {preview.data && (
            <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
              <p className="font-medium">If you import now: {preview.data.imported.length} added, {preview.data.held.length} held back. Nothing has been changed yet.</p>
              <ul className="divide-y divide-line">
                {preview.data.imported.map((i) => (
                  <li key={`${i.kind}-${i.id}`} className="flex flex-wrap justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate" title={i.filename}>{i.filename}</span>
                    <span className="text-muted">
                      {i.kind === 'investment' ? `${i.holdings} holdings` : `${i.transactions} transactions · in ${formatAmount(i.moneyIn ?? 0)} · out ${formatAmount(i.moneyOut ?? 0)}`}
                    </span>
                  </li>
                ))}
                {preview.data.held.map((h) => (
                  <li key={`h-${h.kind}-${h.id}`} className="flex flex-wrap justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate" title={h.filename}>{h.filename}</span>
                    <span className="text-danger">Held: {h.reason}</span>
                  </li>
                ))}
              </ul>
              {preview.data.balances.length > 0 && (
                <ul className="text-muted">
                  {preview.data.balances.map((b) => (
                    <li key={b.accountName}>{b.accountName}: {formatAmount(b.before)} → {formatAmount(b.after)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      {importReady.error && <p className="text-sm text-danger">{importReady.error.message}</p>}

      {outcome && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            <span className="font-medium">{outcome.imported.length} imported</span>
            {outcome.held.length > 0 && <>, <span className="font-medium">{outcome.held.length} held back for your review</span></>}.
          </p>
          {outcome.held.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {outcome.held.map((h) => (
                <li key={`${h.kind}-${h.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium" title={h.filename}>{h.filename}</span>
                    <span className="text-muted">{h.reason}</span>
                  </span>
                  {h.kind === 'bank' ? (
                    <button className="button-quiet" onClick={() => onReview(h.id)}>Review</button>
                  ) : (
                    <Link className="button-quiet" to="/investments">Open Investments</Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">Next: open Review and press "Match the statement" if the dashboard says a balance disagrees with its statement.</p>
        </div>
      )}
    </section>
  );
}

export function ImportPage() {
  const search = useSearch({ strict: false }) as ImportSearch;
  const [openId, setOpenId] = useState<number | null>(search.open ?? null);
  const imports = useQuery({ queryKey: ['imports'], queryFn: api.imports });
  const [bulk, setBulk] = useState<File[] | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Import</h1>
      <UploadCard onStaged={(batch) => setOpenId(batch.id)} onBulk={(files) => { setOpenId(null); setBulk(files); }} />
      <InboxCard />
      <MailCard />
      <BankAlerts />
      <Payslips />
      <Coverage />
      {bulk && <BulkRun key={bulk.map((f) => f.name).join('|')} files={bulk} onReview={(id) => setOpenId(id)} onClose={() => setBulk(null)} />}
      {openId !== null && <Review key={openId} id={openId} onClose={() => setOpenId(null)} />}
      {imports.isError && <p className="text-sm text-danger">{imports.error.message}</p>}
      <LearnedFormats />
      <History items={imports.data ?? []} onOpen={setOpenId} />
    </div>
  );
}
