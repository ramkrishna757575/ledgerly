import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from './config.ts';

export type Outgoing = { to: string; subject: string; text: string };

// Tests swap this for something that keeps the mail instead of sending it.
let override: ((mail: Outgoing & { from: string }) => Promise<void>) | undefined;
export const setMailSender = (send: typeof override) => void (override = send);

const transports = new Map<string, Transporter>();

export const canSendMail = (config: Config) => Boolean(config.smtp) || Boolean(override);

// Plain text only, to one address at a time. The address was given by a person, so line
// breaks are refused to keep it from adding headers.
export async function sendMail(config: Config, mail: Outgoing) {
  if (/[\r\n]/.test(mail.to) || /[\r\n]/.test(mail.subject)) throw new Error('Not a valid address');
  const from = config.smtp?.from ?? 'Ledgerly <no-reply@localhost>';
  if (override) return override({ ...mail, from });
  const smtp = config.smtp;
  if (!smtp) throw new Error('Mail is not set up on this server');
  const key = `${smtp.host}:${smtp.port}:${smtp.user ?? ''}`;
  let transport = transports.get(key);
  if (!transport) {
    transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      connectionTimeout: 15_000,
      socketTimeout: 20_000,
    });
    transports.set(key, transport);
  }
  await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
}
