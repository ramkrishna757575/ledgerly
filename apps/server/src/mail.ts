import { commitReadyImports, getSetting, parseAlertEmail, recordAlert, setSetting } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config, MailConfig } from './config.ts';
import { ingestStatement } from './ingest.ts';
import { allChannels, deliver } from './notify.ts';

export type MailAttachment = { filename: string; content: Buffer };
export type MailMessage = { id: string; from: string; subject: string; authResults: string; attachments: MailAttachment[]; text?: string; date?: string };
export type MailSource = {
  // Unread mail from the senders asked for.
  fetchNew(): Promise<MailMessage[]>;
  markDone(ids: string[]): Promise<void>;
  close(): Promise<void>;
};

const WANTED = /\.(pdf|csv|tsv|xlsx)$/i;
const MAX_ATTACHMENT = 15 * 1024 * 1024;

// ---- Whose mail is believed ----------------------------------------------------

export function senderDomain(from: string) {
  return from.toLowerCase().split('@').pop() ?? '';
}

// An entry with an @ is one exact address; without, a domain and anything under it.
export function allowedSender(from: string, senders: string[]) {
  const address = from.trim().toLowerCase();
  const domain = senderDomain(address);
  return senders.some((entry) => (entry.includes('@') ? entry === address : domain === entry || domain.endsWith(`.${entry}`)));
}

// A From line is easy to forge. The receiving mail server records whether the
// message really came from that domain; this believes it only if the domain's
// own policy passed (DMARC), or its signature passed and was made by the
// sender's own domain. Mail the server did not check at all is not believed.
export function authenticated(authResults: string, from: string) {
  const text = authResults.toLowerCase();
  const domain = senderDomain(from);
  if (/\bdmarc=fail\b/.test(text)) return false;
  if (/\bdmarc=pass\b/.test(text)) return true;
  return [...text.matchAll(/dkim=pass[^;]*?header\.d=([a-z0-9.-]+)/g)].some((m) => m[1] === domain || domain.endsWith(`.${m[1]}`) || m[1]!.endsWith(`.${domain}`));
}

// ---- Reading a message ---------------------------------------------------------

export async function parseRawMessage(id: string, raw: Buffer): Promise<MailMessage> {
  const parsed = await simpleParser(raw);
  return {
    id,
    from: parsed.from?.value[0]?.address ?? '',
    subject: parsed.subject ?? '',
    text: (parsed.text ?? '').slice(0, 6000),
    date: parsed.date ? parsed.date.toISOString().slice(0, 10) : undefined,
    authResults: parsed.headerLines.filter((h) => h.key === 'authentication-results').map((h) => h.line).join(' '),
    attachments: parsed.attachments
      .filter((a) => a.content.length <= MAX_ATTACHMENT && (WANTED.test(a.filename ?? '') || a.contentType === 'application/pdf'))
      .map((a) => ({ filename: a.filename ?? `statement-${id}.pdf`, content: a.content })),
  };
}

export function imapSource(config: MailConfig): MailSource {
  const client = new ImapFlow({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: config.password }, logger: false });
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;

  return {
    async fetchNew() {
      await client.connect();
      lock = await client.getMailboxLock(config.folder);
      // Ask the server only for unread mail from the chosen senders: other mail is never even downloaded.
      const wanted = config.senders.length === 1 ? { from: config.senders[0]! } : { or: config.senders.map((from) => ({ from })) };
      const found = await client.search({ seen: false, ...wanted }, { uid: true });
      const messages: MailMessage[] = [];
      for (const uid of found || []) {
        const item = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
        if (!item || !item.source || (item.size ?? 0) > 40 * 1024 * 1024) continue;
        messages.push(await parseRawMessage(String(uid), item.source));
      }
      return messages;
    },
    async markDone(ids) {
      if (ids.length > 0) await client.messageFlagsAdd(ids.join(','), ['\\Seen'], { uid: true });
    },
    async close() {
      lock?.release();
      await client.logout().catch(() => {});
    },
  };
}

// ---- Collecting ------------------------------------------------------------------

export type MailResult = { at: string; from: string; file: string; outcome: 'staged' | 'already' | 'held' | 'ignored' | 'alert'; note?: string };
export type MailState = {
  enabled: boolean;
  problem: string | null;
  mailbox: string | null;
  senders: string[];
  lastCheck: string | null;
  lastError: string | null;
  results: MailResult[];
  lastImport: { imported: number; held: number } | null;
};

const LOG_KEY = 'mail.log';
type Log = { lastCheck: string | null; lastError: string | null; results: MailResult[]; lastImport: MailState['lastImport']; seen: string[] };
const readLog = (db: Db): Log => {
  try {
    return { lastCheck: null, lastError: null, results: [], lastImport: null, seen: [], ...(JSON.parse(getSetting(db, LOG_KEY) ?? '{}') as Partial<Log>) };
  } catch {
    return { lastCheck: null, lastError: null, results: [], lastImport: null, seen: [] };
  }
};

export function mailState(db: Db, config: Config): MailState {
  const log = readLog(db);
  return {
    enabled: Boolean(config.mail),
    problem: config.mailProblem ?? null,
    mailbox: config.mail ? `${config.mail.user} on ${config.mail.host}` : null,
    senders: config.mail?.senders ?? [],
    lastCheck: log.lastCheck,
    lastError: log.lastError,
    results: log.results,
    lastImport: log.lastImport,
  };
}

// Reads new statement mail, stages every attachment and then imports what is
// safe, the same as the watched folder. Mail from anyone else is left alone and
// unread. A message is marked read only once its attachments are dealt with, so
// nothing is lost if the check stops half-way, and a statement already imported is
// recognised by its contents, so reading one twice does no harm.
export async function scanMail(db: Db, config: Config, source?: MailSource, fetcher: typeof fetch = fetch) {
  const mail = config.mail;
  if (!mail) return null;
  const log = readLog(db);
  const at = new Date().toISOString();
  const results: MailResult[] = [];
  const done: string[] = [];
  const src = source ?? imapSource(mail);
  let lastError: string | null = null;

  try {
    for (const message of await src.fetchNew()) {
      if (log.seen.includes(message.id)) continue;
      const domain = senderDomain(message.from);
      if (!allowedSender(message.from, mail.senders)) {
        results.push({ at, from: domain, file: '(message)', outcome: 'ignored', note: 'Not from one of your senders' });
        log.seen.push(message.id);
        continue;
      }
      if (mail.requireAuth && !authenticated(message.authResults, message.from)) {
        results.push({ at, from: domain, file: '(message)', outcome: 'ignored', note: "Claims to be from a sender you listed, but the mail server could not confirm it. Not read." });
        log.seen.push(message.id);
        continue;
      }
      if (message.attachments.length === 0) {
        // A bank's "you spent ..." alert has no attachment: read it for the transaction it announces.
        const alert = parseAlertEmail(message.subject, message.text ?? '', message.date);
        if (alert) {
          const { entry } = recordAlert(db, alert, domain);
          results.push({ at, from: domain, file: '(bank alert)', outcome: 'alert', note: entry ? 'Read the alert. Review it on the Import page.' : 'Already read' });
          done.push(message.id);
          log.seen.push(message.id);
          continue;
        }
        results.push({ at, from: domain, file: '(no attachment)', outcome: 'ignored', note: 'No PDF or CSV attached. Links in mail are never followed.' });
        done.push(message.id);
        continue;
      }
      let held = false;
      for (const attachment of message.attachments) {
        const result = await ingestStatement(db, config, { name: attachment.filename, buffer: attachment.content, passwords: config.watchPasswords });
        results.push({ at, from: domain, file: attachment.filename, outcome: result.outcome, note: result.note });
        held ||= result.outcome === 'held';
      }
      done.push(message.id);
      // A message with something it could not read is not remembered, so marking it unread again, after the
      // format is supported or the password is added, tries it again. It is read now, so it does not repeat by itself.
      if (!held) log.seen.push(message.id);
    }
    await src.markDone(done);
  } catch (error) {
    // The password is never in the message, but keep it short and plain anyway.
    lastError = error instanceof Error ? error.message.slice(0, 200) : 'Could not read the mailbox';
  } finally {
    await src.close().catch(() => {});
  }

  let lastImport = log.lastImport;
  const staged = results.filter((r) => r.outcome === 'staged').length;
  const problems = results.filter((r) => r.outcome === 'held' || (r.outcome === 'ignored' && /not read|could not confirm/i.test(r.note ?? '')));
  if (staged > 0) {
    const imported = commitReadyImports(db);
    lastImport = { imported: imported.imported.length, held: imported.held.length };
  }
  if (allChannels(db, config).length > 0 && (staged > 0 || problems.length > 0)) {
    const lines = [
      ...(staged > 0 ? [`${lastImport!.imported} statement${lastImport!.imported === 1 ? '' : 's'} imported from email${lastImport!.held ? `, ${lastImport!.held} need your review` : ''}`] : []),
      ...problems.map((r) => `${r.file} from ${r.from}: ${r.note}`),
    ];
    await deliver(db, allChannels(db, config), 'Ledgerly: statements from email', lines.join('\n'), lines, fetcher);
  }

  setSetting(db, LOG_KEY, JSON.stringify({ lastCheck: at, lastError, results: [...results, ...log.results].slice(0, 30), lastImport, seen: log.seen.slice(-500) }));
  return { results, lastImport, error: lastError };
}

export async function tickMail(db: Db, config: Config, log: (message: string) => void) {
  if (config.demoMode || !config.mail) return;
  await scanMail(db, config).catch((error) => log(`Mail check failed: ${error instanceof Error ? error.message : String(error)}`));
}

// Whether these details open the mailbox, without reading anything.
export async function testMailbox(mail: MailConfig) {
  const client = new ImapFlow({ host: mail.host, port: mail.port, secure: mail.secure, auth: { user: mail.user, pass: mail.password }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mail.folder);
    lock.release();
    return { ok: true as const };
  } catch (error) {
    // Say what failed in plain words, never echoing the password.
    return { ok: false as const, error: error instanceof Error ? error.message.slice(0, 200) : 'Could not connect' };
  } finally {
    await client.logout().catch(() => {});
  }
}
