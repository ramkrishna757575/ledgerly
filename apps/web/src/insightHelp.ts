import type { Insight } from './api.ts';

// What each kind of finding means and what to do about it, in plain words.
export const INSIGHT_HELP: Record<Insight['kind'], string[]> = {
  balance: [
    'A balance below zero, or a credit card showing a credit, almost always means something is missing from your books, not that the bank owes you.',
    'The usual cause is statements that were not imported: your bank statement records the card bill payments, but the card\'s own purchases are only known from the card\'s statements.',
    'Check the "Statements imported, by month" grid on the Import page for months with no statement, import them, or set the opening balance on the Accounts page.',
  ],
  coverage: [
    'Each statement covers a period. Months that no imported statement covers have no transactions, so balances and reports for them are incomplete.',
    'Download those statements from your bank or card app (or find them in your email) and import them. Import them together and they are added oldest first.',
  ],
  card_payments: [
    'Paying a credit card bill from your bank is not spending: the spending was counted when you used the card.',
    'These payments are filed as spending because the card they belong to is not set up here. Add the card, or import its statement, and they become card payments.',
  ],
  investments: [
    'Money you put into a mutual fund or SIP is saving, not spending, so it should not reduce what you "saved" this month.',
    'Ledgerly found payments that look like investments counted as spending. Moving them to an investment account fixes your spending reports.',
  ],
  uncategorized: [
    'Reports and budgets group spending by category. Spending with no category cannot be shown in them.',
    'Pick a category once for a shop and Ledgerly can file the same shop automatically from then on.',
  ],
  imports: ['A statement has been read but nothing from it is in your books until you review it and press import. You can undo an import afterwards.'],
  rules: ['A rule files a payee under the same category every time. These are suggested from how you already sorted similar payments.'],
  agents: ['A connected agent suggested a change. Nothing changes until you approve it.'],
  budgets: ['A budget is a monthly limit for a category. This tells you when spending is near or past it, so you can slow down before the month ends.'],
  bills: ['These are payments that come around regularly, found from your history. This reminds you to keep money in the account they come from.'],
  assets: ['A fixed or recurring deposit is about to mature. When it does, the money is paid out, and unless you renew it the bank may roll it over on its own terms, so decide what you want to do with it.'],
  forecast: ['Based on your usual bills and spending, an account is expected to run low. This is a projection, not a certainty.'],
  cards: ['A credit card bill is due soon. Paying the full amount by the due date avoids interest. Paying only the minimum keeps the card in good standing but the rest is charged interest at a high rate.'],
  policies: ['An insurance premium is due soon. Cover can lapse, or a waiting period can restart, if it is paid late.'],
  anomalies: ['Something in your spending looks unusual, such as the same payment recorded twice, or an amount far larger than usual from the same payee. Check it is really yours and was not charged twice.'],
};
