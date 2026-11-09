import { AI_PROVIDERS, DomainError, getSetting, setSetting, type AiConfig } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import { z } from 'zod';
import type { MailConfig } from './config.ts';
import { assertPublicHost, assertPublicUrl } from './net-safety.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';

// What a person sets for their own books: their AI provider and key, their
// mailbox, their statement folder and the passwords for their locked PDFs. Kept
// in their own database, with keys and passwords encrypted.
const AI = 'cfg.ai';
const MAIL = 'cfg.mail';
const WATCH = 'cfg.watch';

const json = <T>(db: Db, key: string): T | undefined => {
  try {
    const raw = getSetting(db, key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
};

// ---- AI provider ---------------------------------------------------------------

type StoredAi = { provider: AiConfig['provider']; model: string; baseUrl?: string; region?: string; apiKey?: string };

export function readAi(db: Db): AiConfig | null {
  const s = json<StoredAi>(db, AI);
  if (!s) return null;
  return { provider: s.provider, model: s.model, baseUrl: s.baseUrl, region: s.region, apiKey: decryptSecret(s.apiKey) };
}

export function describeAi(db: Db) {
  const s = json<StoredAi>(db, AI);
  return s ? { provider: s.provider, model: s.model, baseUrl: s.baseUrl ?? null, region: s.region ?? null, hasKey: Boolean(decryptSecret(s.apiKey)) } : null;
}

const aiInput = z.object({
  provider: z.enum(AI_PROVIDERS),
  model: z.string().trim().max(120).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  region: z.string().trim().max(40).optional(),
  // Left out when editing, to keep the key that is already saved.
  apiKey: z.string().max(500).optional(),
});

export async function saveAi(db: Db, input: z.input<typeof aiInput>, restricted: boolean) {
  const data = aiInput.parse(input);
  const existing = json<StoredAi>(db, AI);
  const model = data.model || (data.provider === 'anthropic' ? 'claude-sonnet-5-5' : '');
  if (!model) throw new DomainError('invalid', 'Enter the model name');
  const baseUrl = data.baseUrl || undefined;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new DomainError('invalid', 'The address must start with https://');
  if (data.provider === 'openai' && !baseUrl) throw new DomainError('invalid', 'Enter the address of your model server, such as https://models.example.com/v1');
  if (restricted && baseUrl) await assertPublicUrl(baseUrl);
  const key = data.apiKey?.trim() ? encryptSecret(data.apiKey.trim()) : existing?.provider === data.provider ? existing.apiKey : undefined;
  if (data.provider !== 'openai' && !key) throw new DomainError('invalid', 'Enter your API key');
  setSetting(db, AI, JSON.stringify({ provider: data.provider, model, baseUrl, region: data.region || undefined, apiKey: key } satisfies StoredAi));
}

export const clearAi = (db: Db) => setSetting(db, AI, '');

// ---- Mailbox ---------------------------------------------------------------------

type StoredMail = Omit<MailConfig, 'password'> & { password?: string };

export function readMail(db: Db): MailConfig | undefined {
  const s = json<StoredMail>(db, MAIL);
  const password = decryptSecret(s?.password);
  return s && password ? { ...s, password } : undefined;
}

export function describeMail(db: Db) {
  const s = json<StoredMail>(db, MAIL);
  return s ? { host: s.host, port: s.port, secure: s.secure, user: s.user, folder: s.folder, senders: s.senders, requireAuth: s.requireAuth, hasPassword: Boolean(decryptSecret(s.password)) } : null;
}

const mailInput = z.object({
  host: z.string().trim().min(3).max(200),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().trim().min(1).max(200),
  password: z.string().max(500).optional(),
  folder: z.string().trim().max(100).default('INBOX'),
  senders: z.array(z.string().trim().toLowerCase().min(3).max(200)).min(1).max(20),
  requireAuth: z.boolean().default(true),
});

export async function saveMail(db: Db, input: z.input<typeof mailInput>, restricted: boolean) {
  const data = mailInput.parse(input);
  const existing = json<StoredMail>(db, MAIL);
  if (restricted) await assertPublicHost(data.host);
  const password = data.password ? encryptSecret(data.password) : existing?.password;
  if (!password) throw new DomainError('invalid', 'Enter the mailbox password (an app password)');
  setSetting(db, MAIL, JSON.stringify({ ...data, folder: data.folder || 'INBOX', password } satisfies StoredMail));
}

export const clearMail = (db: Db) => setSetting(db, MAIL, '');

// ---- Statement folder and the passwords for locked PDFs ---------------------------

type StoredWatch = { enabled: boolean; passwords?: string };

export function readWatch(db: Db) {
  const s = json<StoredWatch>(db, WATCH);
  let passwords: string[] = [];
  try {
    passwords = JSON.parse(decryptSecret(s?.passwords) ?? '[]') as string[];
  } catch {
    passwords = [];
  }
  return { enabled: s?.enabled ?? false, passwords };
}

export function saveWatch(db: Db, input: { enabled?: boolean; passwords?: string[] }) {
  const current = readWatch(db);
  const passwords = (input.passwords ?? current.passwords).map((p) => p.trim()).filter(Boolean);
  if (passwords.length > 10) throw new DomainError('invalid', 'Ten passwords is the most');
  setSetting(db, WATCH, JSON.stringify({ enabled: input.enabled ?? current.enabled, passwords: encryptSecret(JSON.stringify(passwords)) } satisfies StoredWatch));
}
