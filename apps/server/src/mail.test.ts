import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHoldings, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadMail } from './config.ts';
import { allowedSender, authenticated, mailState, parseRawMessage, scanMail, type MailMessage, type MailSource } from './mail.ts';
import { configFor } from './tenants.ts';

const CSV = 'Instrument,Qty.,Avg. cost,LTP,Cur. val\nSample Corp Ltd,10,1500.00,1650.50,16505.00\n';
const PASS = 'mx.example; dkim=pass header.d=scripbox.com header.s=k1; spf=pass smtp.mailfrom=scripbox.com; dmarc=pass header.from=scripbox.com';

const ENV = { MAIL_HOST: 'imap.example.com', MAIL_USER: 'me@example.com', MAIL_PASSWORD: 'app-pass', MAIL_SENDERS: 'scripbox.com,statements@axisbank.com' };

function setup(env: Record<string, string> = ENV) {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ledgerly-mail-')), ...env });
  const db = openDb(config.dbPath);
  seedDefaults(db);
  return { config, db };
}

function fakeSource(messages: MailMessage[]) {
  const marked: string[] = [];
  let closed = false;
  const source: MailSource = { fetchNew: async () => messages, markDone: async (ids) => void marked.push(...ids), close: async () => void (closed = true) };
  return { source, marked, closed: () => closed };
}

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: '1',
  from: 'reports@scripbox.com',
  subject: 'Your portfolio report',
  authResults: PASS,
  attachments: [{ filename: 'holdings.csv', content: Buffer.from(CSV) }],
  ...over,
});

describe('which mail is believed', () => {
  it('matches an address exactly and a domain with its subdomains, and nothing else', () => {
    const senders = ['scripbox.com', 'statements@axisbank.com'];
    expect(allowedSender('reports@scripbox.com', senders)).toBe(true);
    expect(allowedSender('Reports@Mail.Scripbox.com', senders)).toBe(true);
    expect(allowedSender('statements@axisbank.com', senders)).toBe(true);
    expect(allowedSender('other@axisbank.com', senders)).toBe(false);
    expect(allowedSender('x@scripbox.com.evil.io', senders)).toBe(false);
    expect(allowedSender('x@notscripbox.com', senders)).toBe(false);
    expect(allowedSender('', senders)).toBe(false);
  });

  it('trusts only what the mail server confirmed came from that domain', () => {
    expect(authenticated(PASS, 'reports@scripbox.com')).toBe(true);
    expect(authenticated('mx; dmarc=pass header.from=axisbank.com', 'a@axisbank.com')).toBe(true);
    expect(authenticated('mx; dkim=pass header.d=axisbank.com', 'a@axisbank.com')).toBe(true);
    // Signed, but by somebody else's domain: a forged From.
    expect(authenticated('mx; dkim=pass header.d=evil.io; spf=pass smtp.mailfrom=evil.io', 'a@axisbank.com')).toBe(false);
    expect(authenticated('mx; dmarc=fail header.from=axisbank.com; dkim=pass header.d=axisbank.com', 'a@axisbank.com')).toBe(false);
    expect(authenticated('mx; spf=pass', 'a@axisbank.com')).toBe(false);
    expect(authenticated('', 'a@axisbank.com')).toBe(false);
  });
});

describe('reading a message', () => {
  it('finds the sender, the server\'s verdict and the statement attachments, and skips the rest', async () => {
    const boundary = 'BOUNDARY';
    const raw = [
      'From: Scripbox <reports@scripbox.com>',
      'To: me@example.com',
      'Subject: Your portfolio report',
      `Authentication-Results: ${PASS}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'Your report is attached.',
      `--${boundary}`,
      'Content-Type: text/csv; name="holdings.csv"',
      'Content-Disposition: attachment; filename="holdings.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(CSV).toString('base64'),
      `--${boundary}`,
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: attachment; filename="logo.png"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('png').toString('base64'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const parsed = await parseRawMessage('7', Buffer.from(raw));
    expect(parsed).toMatchObject({ id: '7', from: 'reports@scripbox.com', subject: 'Your portfolio report' });
    expect(authenticated(parsed.authResults, parsed.from)).toBe(true);
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['holdings.csv']);
    expect(parsed.attachments[0]!.content.toString()).toBe(CSV);
  });
});

describe('collecting statements from email', () => {
  it('imports an attachment from a listed sender, marks the message read and records it', async () => {
    const { config, db } = setup();
    const { source, marked, closed } = fakeSource([message()]);
    const run = await scanMail(db, config, source);
    expect(run!.results).toMatchObject([{ from: 'scripbox.com', file: 'holdings.csv', outcome: 'staged' }]);
    expect(run!.lastImport).toEqual({ imported: 1, held: 0 });
    expect(getHoldings(db).holdings[0]!.name).toBe('Sample Corp Ltd');
    expect(marked).toEqual(['1']);
    expect(closed()).toBe(true);

    const state = mailState(db, config);
    expect(state).toMatchObject({ enabled: true, mailbox: 'me@example.com on imap.example.com', senders: ['scripbox.com', 'statements@axisbank.com'], lastError: null });
    expect(JSON.stringify(state)).not.toContain('app-pass');
    expect(state.results[0]).toMatchObject({ outcome: 'staged' });
  });

  it('does not read mail that claims a listed sender but is not confirmed, or is from anyone else', async () => {
    const { config, db } = setup();
    const { source, marked } = fakeSource([
      message({ id: '1', authResults: '' }),
      message({ id: '2', authResults: 'mx; dkim=pass header.d=evil.io' }),
      message({ id: '3', from: 'someone@else.com' }),
    ]);
    const run = await scanMail(db, config, source);
    expect(run!.results.map((r) => r.outcome)).toEqual(['ignored', 'ignored', 'ignored']);
    expect(run!.results[0]!.note).toMatch(/could not confirm/);
    expect(getHoldings(db).holdings).toEqual([]);
    // Nothing was marked read: it is not the app's mail to touch.
    expect(marked).toEqual([]);
    // And it is not looked at again next time.
    expect((await scanMail(db, config, fakeSource([message({ id: '1', authResults: '' })]).source))!.results).toEqual([]);
  });

  it('can be told to trust the listed sender without the server\'s confirmation', async () => {
    const { config, db } = setup({ ...ENV, MAIL_REQUIRE_AUTH: 'false' });
    const run = await scanMail(db, config, fakeSource([message({ authResults: '' })]).source);
    expect(run!.results[0]!.outcome).toBe('staged');
  });

  it('holds back what it cannot read, skips a message with nothing attached, and never follows links', async () => {
    const { config, db } = setup();
    const { source } = fakeSource([
      message({ id: '1', attachments: [{ filename: 'broken.pdf', content: Buffer.from('%PDF-1.4 not really') }] }),
      message({ id: '2', attachments: [] }),
    ]);
    const run = await scanMail(db, config, source);
    expect(run!.results).toMatchObject([
      { file: 'broken.pdf', outcome: 'held', note: expect.stringMatching(/could not be read/i) },
      { outcome: 'ignored', note: expect.stringMatching(/Links in mail are never followed/) },
    ]);
    expect(readdirSync(join(config.dataDir, 'documents'))).toEqual([]);
  });

  it('tries a held message again when it is marked unread, but never a handled one', async () => {
    const { config, db } = setup();
    const broken = message({ id: '7', attachments: [{ filename: 'broken.pdf', content: Buffer.from('%PDF-1.4 not really') }] });
    expect((await scanMail(db, config, fakeSource([broken]).source))!.results).toMatchObject([{ outcome: 'held' }]);
    // Marked unread again: it comes back and is tried again.
    expect((await scanMail(db, config, fakeSource([broken]).source))!.results).toMatchObject([{ outcome: 'held' }]);

    // A statement that was read is remembered, and is not looked at twice.
    await scanMail(db, config, fakeSource([message({ id: '8' })]).source);
    expect((await scanMail(db, config, fakeSource([message({ id: '8' })]).source))!.results).toEqual([]);
  });

  it('recognises a statement it has already imported, however it arrives again', async () => {
    const { config, db } = setup();
    await scanMail(db, config, fakeSource([message({ id: '1' })]).source);
    const again = await scanMail(db, config, fakeSource([message({ id: '9', subject: 'Resent' })]).source);
    expect(again!.results).toMatchObject([{ outcome: 'already' }]);
    expect(getHoldings(db).holdings).toHaveLength(1);
  });

  it('records a mailbox that cannot be reached, without leaking the password', async () => {
    const { config, db } = setup();
    const broken: MailSource = { fetchNew: async () => { throw new Error('Connection refused'); }, markDone: async () => {}, close: async () => {} };
    const run = await scanMail(db, config, broken);
    expect(run!.error).toBe('Connection refused');
    expect(mailState(db, config).lastError).toBe('Connection refused');
  });

  it('does nothing without a mailbox, and tells you what is missing', async () => {
    expect(await scanMail(setup({}).db, setup({}).config)).toBeNull();
    expect(loadMail({ MAIL_HOST: 'h' }).mailProblem).toMatch(/MAIL_USER/);
    expect(loadMail({ MAIL_HOST: 'h', MAIL_USER: 'u', MAIL_PASSWORD: 'p' }).mailProblem).toMatch(/MAIL_SENDERS/);
    expect(loadMail({})).toEqual({});
    const ok = loadMail({ ...ENV, MAIL_PORT: '143', MAIL_SECURE: 'false', MAIL_FOLDER: 'Statements' }).mail!;
    expect(ok).toMatchObject({ port: 143, secure: false, folder: 'Statements', requireAuth: true });
  });

  it('is only for the administrator when there are several people', () => {
    const { config } = setup();
    expect(configFor(config, { isAdmin: true, dataDir: '/x' }).mail).toBeDefined();
    expect(configFor(config, { isAdmin: false, dataDir: '/x' }).mail).toBeUndefined();
  });
});

describe('bank alerts in the mailbox', () => {
  it('reads an alert email that has no attachment, and does not add it twice', async () => {
    const { config, db } = setup();
    const { createAccount, listAlertEntries } = await import('@ledgerly/core');
    createAccount(db, { name: 'Axis Card', type: 'liability', subtype: 'credit_card', numberLast4: '7788' } as never);
    const alert = message({
      id: '9',
      from: 'alerts@scripbox.com',
      subject: 'Transaction alert',
      attachments: [],
      text: 'INR 1,250.00 spent on your Credit Card no. XX7788 at SWIGGY on 05-11-26.',
    });
    const first = fakeSource([alert]);
    const result = await scanMail(db, config, first.source);
    expect(result!.results[0]).toMatchObject({ outcome: 'alert' });
    expect(first.marked).toEqual(['9']);
    expect(listAlertEntries(db)).toHaveLength(1);

    const again = await scanMail(db, config, fakeSource([{ ...alert, id: '10' }]).source);
    expect(again!.results[0]).toMatchObject({ outcome: 'alert', note: 'Already read' });
    expect(listAlertEntries(db)).toHaveLength(1);
  });
});
