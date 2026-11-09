import { join, resolve } from 'node:path';
import { loadChannels, type Channel } from './notify.ts';
import { AI_PROVIDERS, type AiConfig } from '@ledgerly/core';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  webDir: string;
  authPassword?: string;
  // Several people, each with their own separate books.
  multiUser: boolean;
  // Who may create their own account: nobody, people with an invite code, anyone once an administrator approves, or anyone.
  signupMode: 'closed' | 'invite' | 'approval' | 'open';
  // Which proxies in front of the server may say who is calling: "true" for any (only behind your own proxy), or addresses.
  trustProxy: boolean | string;
  // Space each person (other than the one running the server) may use, in bytes; 0 for no limit.
  quotaBytes: number;
  // How many daily backups are kept.
  backupKeep: number;
  // How many sign-ups one address may make in ten minutes.
  signupRate: number;
  adminUsername: string;
  // Whether everyone may use the AI key set up on this server (otherwise only the administrator).
  aiForAllUsers: boolean;
  // A second login that can look but not change anything, for a partner or an accountant.
  viewerPassword?: string;
  cookieSecure: boolean;
  allowedHosts: string[];
  demoMode: boolean;
  // The model behind the AI review, or null with the reason it is not set up.
  ai: AiConfig | null;
  aiProblem?: string;
  amfiUrl: string;
  mfapiUrl: string;
  channels: Channel[];
  // A folder to drop statements into, and passwords to try on locked ones.
  // With several people, a person who is not the administrator may not make the server call addresses inside its own network.
  restrictOutbound: boolean;
  // When set, backups are encrypted with it.
  backupPassphrase?: string;
  // A mailbox to collect statements from.
  mail?: MailConfig;
  mailProblem?: string;
  watchDir?: string;
  watchPasswords: string[];
  // Mail the server sends, and the address people reach it at (for the links in that mail).
  smtp?: SmtpConfig;
  smtpProblem?: string;
  offsite?: OffsiteConfig;
  offsiteProblem?: string;
  publicUrl?: string;
};

// Where the server sends mail from (verification, forgotten passwords, a monthly summary).
export type SmtpConfig = { host: string; port: number; secure: boolean; user?: string; password?: string; from: string };

// Where each new backup is also copied: a folder (a mounted drive or a synced folder), and/or a bucket on any S3-compatible service.
export type OffsiteConfig = { dir?: string; s3?: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string } };

export type MailConfig = { host: string; port: number; secure: boolean; user: string; password: string; folder: string; senders: string[]; requireAuth: boolean };

// A mailbox is read only when it is fully set up, and only for mail from the
// senders you name: a statement is only believed if its sender is one you chose.
export function loadMail(env: NodeJS.ProcessEnv): { mail?: MailConfig; mailProblem?: string } {
  const host = env.MAIL_HOST?.trim();
  if (!host) return {};
  const user = env.MAIL_USER?.trim();
  const password = env.MAIL_PASSWORD;
  if (!user || !password) return { mailProblem: 'Set MAIL_USER and MAIL_PASSWORD (an app password, not your main one)' };
  const senders = (env.MAIL_SENDERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (senders.length === 0) return { mailProblem: 'Set MAIL_SENDERS to the addresses or domains statements come from, such as axisbank.com,scripbox.com' };
  const port = Number(env.MAIL_PORT || 993);
  return { mail: { host, port, secure: env.MAIL_SECURE !== 'false', user, password, folder: env.MAIL_FOLDER?.trim() || 'INBOX', senders, requireAuth: env.MAIL_REQUIRE_AUTH !== 'false' } };
}

export function loadSmtp(env: NodeJS.ProcessEnv): { smtp?: SmtpConfig; smtpProblem?: string } {
  const host = env.SMTP_HOST?.trim();
  if (!host) return {};
  const from = env.SMTP_FROM?.trim();
  if (!from || !/^[^@\s<>]+@[^@\s<>]+$|<[^@\s<>]+@[^@\s<>]+>$/.test(from)) return { smtpProblem: 'Set SMTP_FROM to the address mail comes from, such as Ledgerly <no-reply@example.com>' };
  const publicUrl = env.PUBLIC_URL?.trim();
  if (!publicUrl || !/^https?:\/\/[^\s/]+/.test(publicUrl)) return { smtpProblem: 'Set PUBLIC_URL to the address people open Ledgerly at (such as https://money.example.com), for the links in the mail' };
  const port = Number(env.SMTP_PORT || 587);
  return { smtp: { host, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465, user: env.SMTP_USER?.trim() || undefined, password: env.SMTP_PASSWORD || undefined, from } };
}

// Backups leave this machine only when they are encrypted first, so a passphrase is required.
export function loadOffsite(env: NodeJS.ProcessEnv): { offsite?: OffsiteConfig; offsiteProblem?: string } {
  const dir = env.BACKUP_COPY_DIR?.trim() || undefined;
  const endpoint = env.BACKUP_S3_ENDPOINT?.trim();
  if (!dir && !endpoint) return {};
  if (!env.BACKUP_PASSPHRASE) return { offsiteProblem: 'Set BACKUP_PASSPHRASE: backups are encrypted before they leave this machine, and are never copied out unencrypted' };
  const offsite: OffsiteConfig = { dir };
  if (endpoint) {
    const bucket = env.BACKUP_S3_BUCKET?.trim();
    const accessKey = env.BACKUP_S3_KEY?.trim();
    const secretKey = env.BACKUP_S3_SECRET;
    if (!/^https?:\/\/[^\s/]+/.test(endpoint) || !bucket || !accessKey || !secretKey) return { offsiteProblem: 'BACKUP_S3_ENDPOINT needs BACKUP_S3_BUCKET, BACKUP_S3_KEY and BACKUP_S3_SECRET too' };
    offsite.s3 = { endpoint, region: env.BACKUP_S3_REGION?.trim() || 'auto', bucket, accessKey, secretKey, prefix: (env.BACKUP_S3_PREFIX ?? 'ledgerly').replace(/^\/+|\/+$/g, '') };
  }
  return { offsite };
}

export function loadAi(env: NodeJS.ProcessEnv): { ai: AiConfig | null; aiProblem?: string } {
  const provider = env.AI_PROVIDER?.trim().toLowerCase();
  if (!provider) return { ai: null };
  if (!(AI_PROVIDERS as readonly string[]).includes(provider)) {
    return { ai: null, aiProblem: `AI_PROVIDER must be one of ${AI_PROVIDERS.join(', ')}` };
  }
  const kind = provider as AiConfig['provider'];
  const model = env.AI_MODEL?.trim() || (kind === 'anthropic' ? 'claude-sonnet-5-5' : '');
  if (!model) return { ai: null, aiProblem: 'AI_MODEL is not set' };

  const apiKey =
    env.AI_API_KEY || (kind === 'anthropic' ? env.ANTHROPIC_API_KEY : kind === 'bedrock' ? env.AWS_BEARER_TOKEN_BEDROCK : undefined) || undefined;
  if (kind !== 'openai' && !apiKey) {
    return { ai: null, aiProblem: kind === 'anthropic' ? 'Set ANTHROPIC_API_KEY (or AI_API_KEY)' : 'Set AWS_BEARER_TOKEN_BEDROCK (or AI_API_KEY)' };
  }
  const baseUrl = env.AI_BASE_URL?.trim() || undefined;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) return { ai: null, aiProblem: 'AI_BASE_URL must start with http:// or https://' };
  return { ai: { provider: kind, model, apiKey, baseUrl, region: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST ?? '127.0.0.1';
  const authPassword = env.AUTH_PASSWORD || undefined;
  const demoMode = env.DEMO_MODE === 'true';
  const multiUser = env.MULTI_USER === 'true' && !demoMode;
  if (multiUser && !authPassword) throw new Error('MULTI_USER needs AUTH_PASSWORD, which becomes the first administrator\'s password');
  const viewerPassword = env.VIEWER_PASSWORD || undefined;
  if (multiUser && viewerPassword) throw new Error('VIEWER_PASSWORD is for one person sharing their books; with MULTI_USER everyone has their own');
  if (viewerPassword && !authPassword) throw new Error('VIEWER_PASSWORD needs AUTH_PASSWORD to be set too');
  if (viewerPassword && viewerPassword === authPassword) throw new Error('VIEWER_PASSWORD must differ from AUTH_PASSWORD');

  // Demo mode holds only made-up data, so it may be shared without a login.
  // In Docker the server has to listen on 0.0.0.0, so PUBLISH_ADDRESS carries
  // the address that is really exposed on the host.
  const exposedAddress = env.PUBLISH_ADDRESS || host;
  if (!demoMode && !authPassword && !LOCAL_ADDRESSES.has(exposedAddress)) {
    throw new Error(
      `Refusing to expose financial data on ${exposedAddress} without a login. Set AUTH_PASSWORD.`,
    );
  }

  const dataDir = env.DATA_DIR ?? join(REPO_ROOT, 'data');
  return {
    port: Number(env.PORT ?? 4310),
    host,
    dataDir,
    // A separate file, so demo data can never end up in the real database.
    dbPath: join(dataDir, demoMode ? 'demo.db' : 'ledgerly.db'),
    webDir: join(REPO_ROOT, 'apps', 'web', 'dist'),
    authPassword,
    multiUser,
    signupMode: (['invite', 'approval', 'open'] as const).find((m) => m === env.SIGNUP_MODE) ?? 'closed',
    trustProxy: env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY?.trim() || 'loopback',
    quotaBytes: Math.max(0, Number(env.USER_QUOTA_MB) || 0) * 1_048_576,
    backupKeep: 14,
    signupRate: Number(env.SIGNUP_RATE) > 0 ? Number(env.SIGNUP_RATE) : 6,
    adminUsername: (env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
    aiForAllUsers: env.AI_FOR_ALL_USERS === 'true',
    viewerPassword,
    cookieSecure: env.COOKIE_SECURE === 'true',
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...splitList(env.ALLOWED_HOSTS)],
    demoMode,
    // A public demo must never spend someone's key on a stranger's request.
    ...(demoMode ? { ai: null } : loadAi(env)),
    amfiUrl: env.AMFI_URL ?? 'https://portal.amfiindia.com/spages/NAVAll.txt',
    mfapiUrl: env.MFAPI_URL ?? 'https://api.mfapi.in',
    channels: demoMode ? [] : loadChannels(env),
    restrictOutbound: false,
    backupPassphrase: env.BACKUP_PASSPHRASE || undefined,
    ...(demoMode ? {} : loadMail(env)),
    ...(demoMode ? {} : loadSmtp(env)),
    ...(demoMode ? {} : loadOffsite(env)),
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined,
    watchDir: demoMode ? undefined : env.WATCH_DIR?.trim() || undefined,
    watchPasswords: splitList(env.WATCH_PASSWORDS ?? '', false),
  };
}

function splitList(value = '', lower = true) {
  return value
    .split(',')
    .map((item) => (lower ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}
