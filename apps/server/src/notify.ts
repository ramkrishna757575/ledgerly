import { appendAlertLog, DomainError, getSetting, setSetting, buildDigest, digestDue, formatDigest, markDigestSent, markSent, pendingAlerts, type AlertLogEntry } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { Config } from './config.ts';
import { assertPublicUrl } from './net-safety.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';

export type Channel = { id: 'ntfy' | 'telegram' | 'webhook'; label: string; host: string; send: (title: string, message: string, fetcher: typeof fetch) => Promise<void> };

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid address';
  }
};

async function post(fetcher: typeof fetch, url: string, init: RequestInit) {
  const response = await fetcher(url, { method: 'POST', signal: AbortSignal.timeout(15_000), ...init });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

const ntfyChannel = (url: string): Channel => ({ id: 'ntfy', label: 'ntfy', host: hostOf(url), send: (title, message, fetcher) => post(fetcher, url, { headers: { Title: title }, body: message }) });
const telegramChannel = (token: string, chat: string): Channel => ({
  id: 'telegram',
  label: 'Telegram',
  host: 'api.telegram.org',
  send: (title, message, fetcher) => post(fetcher, `https://api.telegram.org/bot${token}/sendMessage`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `${title}\n\n${message}` }) }),
});
// `text` suits Slack and Mattermost, `content` suits Discord.
const webhookChannel = (url: string): Channel => ({
  id: 'webhook',
  label: 'Webhook',
  host: hostOf(url),
  send: (title, message, fetcher) => post(fetcher, url, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, message, text: `${title}\n${message}`, content: `${title}\n${message}` }) }),
});

// Where messages can go, from the environment: the places the person running
// the server chose. Addresses and tokens stay there.
export function loadChannels(env: NodeJS.ProcessEnv): Channel[] {
  const channels: Channel[] = [];
  const ntfy = env.NOTIFY_NTFY_URL?.trim();
  if (ntfy) channels.push(ntfyChannel(ntfy));
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  if (token && chat) channels.push(telegramChannel(token, chat));
  const hook = env.NOTIFY_WEBHOOK_URL?.trim();
  if (hook) channels.push(webhookChannel(hook));
  return channels;
}

// ---- A person's own channels, kept in their own books ---------------------------

export type StoredChannel = { id: string; kind: 'ntfy' | 'telegram' | 'webhook'; url?: string; token?: string; chat?: string };
const STORED_KEY = 'alerts.own';

// On disk, the address or token is sealed; only the kind and where it goes are readable.
type Sealed = { id: string; kind: StoredChannel['kind']; host: string; secret?: string } & Partial<Pick<StoredChannel, 'url' | 'token' | 'chat'>>;

const readSealed = (db: Db): Sealed[] => {
  try {
    return JSON.parse(getSetting(db, STORED_KEY) ?? '[]') as Sealed[];
  } catch {
    return [];
  }
};

export function storedChannels(db: Db): (StoredChannel & { host: string })[] {
  return readSealed(db).flatMap((c) => {
    // A channel saved before sealing existed keeps working, and is sealed the next time the list is saved.
    const opened = c.secret ? (JSON.parse(decryptSecret(c.secret) ?? 'null') as Pick<StoredChannel, 'url' | 'token' | 'chat'> | null) : { url: c.url, token: c.token, chat: c.chat };
    return opened ? [{ id: c.id, kind: c.kind, host: c.host, ...opened }] : [];
  });
}

const seal = (c: StoredChannel): Sealed => ({ id: c.id, kind: c.kind, host: c.kind === 'telegram' ? 'api.telegram.org' : hostOf(c.url ?? ''), secret: encryptSecret(JSON.stringify({ url: c.url, token: c.token, chat: c.chat })) });

const toChannel = (c: StoredChannel, restricted: boolean): Channel => {
  const base = c.kind === 'ntfy' ? ntfyChannel(c.url!) : c.kind === 'webhook' ? webhookChannel(c.url!) : telegramChannel(c.token!, c.chat!);
  if (!restricted || c.kind === 'telegram') return base;
  // Checked again at the moment of sending, since a name can point somewhere new.
  return { ...base, send: async (title, message, fetcher) => { await assertPublicUrl(c.url!); return base.send(title, message, fetcher); } };
};

// Everywhere this person's messages can go: what the server's owner set up for
// them (only for the administrator), and what they added themselves.
export function allChannels(db: Db, config: { channels: Channel[]; restrictOutbound: boolean }): Channel[] {
  return [...config.channels, ...storedChannels(db).map((c) => toChannel(c, config.restrictOutbound))];
}

export async function addStoredChannel(db: Db, config: { restrictOutbound: boolean }, input: { kind: StoredChannel['kind']; url?: string; token?: string; chat?: string }) {
  const url = input.url?.trim();
  if (input.kind === 'telegram') {
    if (!input.token?.trim() || !input.chat?.trim()) throw new DomainError('invalid', 'Telegram needs a bot token and a chat id');
  } else {
    if (!url || !/^https?:\/\//.test(url)) throw new DomainError('invalid', 'Enter the address, starting with https://');
    if (config.restrictOutbound) await assertPublicUrl(url);
  }
  const channel: StoredChannel = { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind: input.kind, url, token: input.token?.trim(), chat: input.chat?.trim() };
  const all = storedChannels(db);
  if (all.length >= 5) throw new DomainError('conflict', 'That is enough channels; remove one first');
  setSetting(db, STORED_KEY, JSON.stringify([...all, channel].map(seal)));
  return channel;
}

export function removeStoredChannel(db: Db, id: string) {
  const all = storedChannels(db);
  if (!all.some((c) => c.id === id)) throw new DomainError('not_found', 'No such channel');
  setSetting(db, STORED_KEY, JSON.stringify(all.filter((c) => c.id !== id).map(seal)));
}

export const describeStored = (c: StoredChannel & { host?: string }) => ({ id: c.id, kind: c.kind, host: c.host ?? (c.kind === 'telegram' ? 'api.telegram.org' : hostOf(c.url ?? '')) });

export async function deliver(db: Db, channels: Channel[], title: string, message: string, titles: string[], fetcher: typeof fetch = fetch) {
  const results = await Promise.allSettled(channels.map((c) => c.send(title, message, fetcher)));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${channels[i]!.label}: ${r.reason instanceof Error ? r.reason.message : 'failed'}`] : []));
  const entry: AlertLogEntry = { at: new Date().toISOString(), titles, channels: channels.map((c) => c.label), ok: failed.length === 0, error: failed.join('; ') || undefined };
  appendAlertLog(db, entry);
  return entry;
}

// Sends what is new as one message. A finding is marked as sent only if at
// least one channel took it, so a failed send is tried again next time.
export async function sendPendingAlerts(db: Db, channels: Channel[], fetcher: typeof fetch = fetch) {
  if (channels.length === 0) return null;
  const pending = pendingAlerts(db);
  if (pending.length === 0) return null;
  const { title, message } = formatDigest(pending);
  const entry = await deliver(db, channels, title, message, pending.map((p) => p.title), fetcher);
  if (entry.ok || entry.error!.split(';').length < channels.length) markSent(db, pending);
  return entry;
}

// The weekly or monthly summary, once per period, if you chose one. A period
// starts on Monday or the 1st, so it goes out on the first check after that
// (or straight away when you turn it on part-way through one).
export async function sendDigestIfDue(db: Db, channels: Channel[], fetcher: typeof fetch = fetch, today = new Date().toISOString().slice(0, 10)) {
  if (channels.length === 0) return null;
  const due = digestDue(db, today);
  if (!due) return null;
  const { title, message } = buildDigest(db, { today });
  const entry = await deliver(db, channels, title, message, [title], fetcher);
  if (entry.ok) markDigestSent(db, due.mode, due.period);
  return entry;
}

export async function tickAlerts(db: Db, config: Config, log: (message: string) => void) {
  if (config.demoMode) return;
  // Looked up each time, so a channel added later is used without a restart.
  const channels = allChannels(db, config);
  if (channels.length === 0) return;
  await Promise.all([sendPendingAlerts(db, channels), sendDigestIfDue(db, channels)]).catch((error) => log(`Alerts failed: ${error instanceof Error ? error.message : String(error)}`));
}
