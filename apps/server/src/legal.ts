import { directorySettings, type Directory } from '@ledgerly/db';
import { eq } from 'drizzle-orm';

// Starting points for the terms and privacy pages. They describe what Ledgerly actually
// does, but they are a template: the person running the site is responsible for what
// they promise, so they should read it, change it, and have it checked for where they live.
export const TERMS_TEMPLATE = `# Terms of use

*Last updated: [DATE]. This site is run by [YOUR NAME OR COMPANY] ("we"). Contact: [EMAIL].*

**What this is.** Ledgerly lets you keep your own private record of your money: accounts, transactions, statements and investments. It is a bookkeeping tool.

**It is not advice.** Nothing here is financial, investment, legal or tax advice. Figures, estimates and explanations are worked out from what you enter and may be wrong or incomplete. Check anything important with a qualified professional. We never place trades or move your money.

**Your account.** Keep your password safe; you are responsible for what happens under your account. Tell us if you think someone else has used it. Give accurate details and do not use the site to break the law, to attack it, or to store data that is not yours to store.

**Your data is yours.** You own what you put in. You can download a backup of everything and delete your account at any time, which deletes your data.

**No guarantee.** We try to keep the site running and your data safe, and we keep backups, but we cannot promise it will always be available or free of errors. Keep your own copy of anything you cannot afford to lose. To the extent the law allows, we are not liable for losses from using the site.

**Changes and ending.** We may change these terms or the site, and may suspend accounts that abuse it. If we change the terms in a way that matters, we will say so.

**Law.** These terms are governed by the laws of [YOUR COUNTRY OR STATE].
`;

export const PRIVACY_TEMPLATE = `# Privacy

*Last updated: [DATE]. Run by [YOUR NAME OR COMPANY]. Contact: [EMAIL].*

**What we keep.** Your username, a hashed password (we cannot read it), your email address if you gave one, and everything you add: accounts, transactions, statements, receipts, and settings. Your books are kept in a database and folder of your own, separate from other people's. We cannot see your money in the normal running of the site, and administrators do not browse it.

**Secrets.** Keys and passwords you save (such as an AI key or a mailbox password) are encrypted and never shown again.

**What we log.** A short, temporary record of failed sign-ins (the time, the address and, for a real account, its username) to spot people guessing passwords. It is held in memory and discarded on restart. Our web server may keep ordinary access logs.

**Cookies.** One cookie keeps you signed in. We do not use advertising or tracking cookies.

**Who else sees it.** We do not sell or share your data. It goes elsewhere only when you ask: if you add an AI provider, the summaries you ask it to read are sent to that provider; if you add a mailbox, we read the statement mail you set it up for; and mail we send you goes through our email provider.

**Email.** We use your address to confirm it is you, to reset a forgotten password, and for a monthly summary only if you turn that on. Email is not private from your mail provider.

**Backups.** We take backups, which include your books. They are encrypted if we have set a passphrase, and old ones are deleted on a schedule, so removed data can remain in them for a short time.

**Your choices.** You can download everything, change your email, and delete your account and all your data at any time from the app. Contact us for anything else about your data.
`;

const read = (directory: Directory, key: string) => directory.select().from(directorySettings).where(eq(directorySettings.key, key)).get()?.value;
const write = (directory: Directory, key: string, value: string) =>
  directory.insert(directorySettings).values({ key, value }).onConflictDoUpdate({ target: directorySettings.key, set: { value } }).run();

export function readLegal(directory: Directory) {
  return { enabled: read(directory, 'legal.enabled') === 'on', terms: read(directory, 'legal.terms') ?? '', privacy: read(directory, 'legal.privacy') ?? '' };
}

export function saveLegal(directory: Directory, input: { enabled: boolean; terms: string; privacy: string }) {
  write(directory, 'legal.enabled', input.enabled ? 'on' : 'off');
  write(directory, 'legal.terms', input.terms);
  write(directory, 'legal.privacy', input.privacy);
}
