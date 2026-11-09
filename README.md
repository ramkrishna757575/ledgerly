# Ledgerly

A self-hosted personal finance manager for India. Your data stays in one SQLite
file on your own machine, with double-entry accounting underneath a simple UI.

## Run with Docker

```bash
docker compose up -d --build
```

Open http://localhost:4310. Data lives in the `ledgerly-data` volume.

By default the port is published on `127.0.0.1` only and there is no login. To
reach it from other machines, set both of these in `.env`:

```bash
BIND_ADDRESS=0.0.0.0
AUTH_PASSWORD=choose-a-long-password
```

The server refuses to start on a non-local address without a password. Traffic
is plain HTTP, so put a reverse proxy such as Caddy in front of it for HTTPS and
set `COOKIE_SECURE=true`.

### Run the published image

Every push to `main` builds an image and publishes it to GitHub's container registry. To
run that instead of building it yourself, use `docker-compose.image.yml`, which is a
ready-made starting point for a server or a stack manager such as Dockhand:

```bash
docker login ghcr.io -u <github user>     # only while the image is private; a token with read:packages
docker compose -f docker-compose.image.yml up -d
```

It takes the same settings as above (`BIND_ADDRESS`, `AUTH_PASSWORD`, `COOKIE_SECURE`, the AI
and backup settings). `LEDGERLY_TAG` picks a version (default `latest`; a commit is
`sha-<short hash>`), and `DATA_PATH` keeps the data in a folder of yours instead of a named
volume. To update, `docker compose -f docker-compose.image.yml pull` and `up -d` again.

## Try the demo

Demo mode loads a made-up ledger (accounts, a few months of transactions, a
credit card and a mutual fund) so you can look around. It uses its own database
file that is wiped on every start, so it never touches real data.

```bash
docker compose --profile demo up --build demo
```

Open http://localhost:4311. Without Docker, run `DEMO_MODE=true pnpm start` after
`pnpm build`. A banner marks the demo, and its "Reset demo data" link restores
the sample data. Demo mode may be shared without a login because it holds
nothing real.

## Import statements

Open **Import** and upload a PDF. Ledgerly reads it on your machine, shows every
transaction with a suggested category, and adds nothing to your books until you
press **Import**.

- **Supported today:** Axis Bank savings statements (both the consolidated and the
  plain account layouts) and Axis Bank credit card statements. Other banks are
  added as adapters, see below.
- **Many at once:** choose several PDFs (or press Ctrl/Cmd+A in a folder) and Ledgerly reads each one, works out whether it is a bank, credit card or fund statement, creates any account it does not have yet (named from the bank and the last four digits, rename it later), and then offers **Import all**. That imports, oldest first, every statement that is safe to add without a look. A statement is held back, with the reason, if its transactions do not add up to its own totals, if no account matched it, or if it pays a card that is not set up. Rows already imported from an overlapping statement are left out, and a file you imported before is recognised and skipped. Locked files share one password field; ask again for any that need another.
- **Locked PDFs:** if a bank has locked the file with a password (often a date of
  birth or customer ID), Ledgerly asks for it, on both the Import and Investments
  pages. The password is used once to read the file and is not saved. The file
  itself stays locked on disk, and the last password that worked is kept only in
  the open page, so a batch of months needs it typed once. A wrong password is
  rejected and nothing is stored. `pdftotext` only accepts a password as an
  argument, so while it runs (about a second) another user on the same machine
  could see it in the process list; on a personal computer or in the container
  that is only you.
- **Checks:** the transactions must add up to the statement's own totals. If they
  don't, the import is blocked until you confirm it.
- **Duplicates:** overlapping statements are fine. Rows already imported for the
  same account are marked and left out.
- **Categories:** known merchants get a suggestion, and a rule you save with
  **Remember** applies to every later statement.
- **Card payments:** the bank statement records a card payment as a transfer, so
  the matching "payment received" row on the card statement is skipped by default.
- **Undo:** any import can be undone, which removes exactly what it added.
- **Privacy:** the PDF is stored in `data/documents` (owner-only) and never leaves
  your machine.

Reading PDFs needs `pdftotext` from poppler. The Docker image includes it. For
local development install it with `sudo apt install poppler-utils qpdf` or
`brew install poppler qpdf`.

To see how a statement is read without importing it:

```bash
pnpm check-statement path/to/statement.pdf
```

It prints counts, whether the totals reconcile, and masked text for anything it
does not recognise, so the output is safe to share. Add `--show` for the real rows.

### Adding a bank

A bank is one adapter in `packages/core/src/imports/adapters/`. It says how
sure it is that a text is its layout (`detect`) and turns the text into rows
(`parse`), then goes in `registry.ts`. The rest (review, duplicates, rules, undo)
needs no changes. Test it with made-up text in the style of `fixtures/`, never a
real statement.

## Categories

Ledgerly suggests a category for each imported transaction, in this order:

1. **Your rules**, saved with **Remember** on the review screen.
2. **What you chose before for the same payee**, read from your own books, when
   most of your earlier choices agree.
3. **Built-in merchants** such as Swiggy, BigBasket, Netflix and Airtel.

Nothing is applied until you review it. You can also change the category of a
transaction already in your books on the **Transactions** page, and Ledgerly
offers to apply it to other unsorted transactions from the same payee. What you
choose there feeds the suggestions for future imports.

## Reports

**Reports** shows income, spending and savings for a date range: this month,
the last 3 or 12 months, this or last financial year (April to March), this or
last year, or dates of your own. Every chart can be grouped by month, year or
financial year, and has a table view with the same numbers.

- Income and spending over time
- Spending by category, where selecting a category lists its transactions
- The biggest categories over time
- Net worth at the end of each month
- Your biggest payees

Money you move between your own accounts, such as paying a credit card bill, is
never counted as spending. A note appears when transactions are still
uncategorised, since the charts are only as good as the categories.

## Needs attention

The dashboard checks your books and lists what looks wrong, with a one-click fix
where a safe one exists. Each finding can be dismissed if it is not a problem.

- **Investments counted as spending:** SIPs, PPF, NPS and EPF that sit in
  Uncategorized. The fix moves them to an investment account (creating it if you
  have none) as transfers, and adds a rule so future imports do the same.
- **Credit card payments counted as spending:** the fix files them under the
  right card, found by the last four digits in the payment, as transfers. With no
  card yet, it opens the add-card form filled in.
- **A large uncategorised share**, a **negative balance**, a card showing a
  **credit**, imports and agent suggestions **waiting for you**, and **suggested
  rules**.

Agents can read the same list with the `get_insights` tool.

## Managing categories

The **Categories** page lists every spending and income category with how many transactions, rules and budgets depend on it.

- **Rename** changes it everywhere at once, since transactions point at the category and not its name.
- **Merge into…** moves the transactions, rules, statement rows waiting for review and the budget into another category of the same kind, then removes the first. If both have a budget, the target keeps its own. It shows what will move before you confirm, and it cannot be undone.
- **Archive** hides a category from pickers but keeps its history; **Delete** is offered only for one with no transactions.
- **Uncategorized** is fixed: imports, rules and the findings rely on it, so it cannot be renamed, merged away, archived or deleted. You can merge other categories into it.
- The built-in merchant guesses (Swiggy to Food & Dining and so on) look categories up by their starter name. If you rename or merge one away, that guess is skipped, and the app falls back to how you categorised the same payee before, so merged history keeps working.

## Rules

**Rules** lists the rules that categorise imports. Add one with a plain "contains"
match or a pattern, and a live preview shows what it would catch in your books
before you save it. **Apply now** sorts the transactions you already have that are
still uncategorised, and never changes one you sorted yourself or turns spending
into income. Rules also come from **Remember** on the review screen and from
agent suggestions you approve. Ledgerly also spots payees you have put in the same
category several times and lists them under **Suggested rules**, to add with one
click.

A rule can only be suggested from choices you have already made, so when little is
sorted yet, **Sort by payee** lists what is still uncategorised, with the easy
decisions made for you:

- **Known merchants** (Netflix, Canva, Axis Max and so on) arrive with a suggested
  category already chosen. **Accept** them all in one click.
- **Payments to people** (Axis marks these P2A) are decided together under one
  category, **Friends & Family** by default, with a list to untick anyone who
  belongs elsewhere, such as a landlord.
- **Small amounts** under ₹100 are folded away.

Choosing a category files every uncategorised transaction from that payee and
remembers it for future imports.

**Automatic rules** is a setting on the Rules page, off by default:

- *Create rules automatically* makes the rules that would otherwise be suggested,
  for future imports.
- *Create rules and sort what is still uncategorised* also files the matching
  uncategorised transactions you already have.

It acts after an import, when you recategorise, and when you approve an agent's
suggestion. Safeguards: a payee must have gone to the same category at least 3
times (80% or more of the time), its name must be at least 4 letters, and it never
creates a rule that would also catch something you filed elsewhere. A transaction
you sorted yourself is never changed. Rules it makes are tagged **Auto**, and one
you delete or switch off does not come back.

## Budgets

A budget is a monthly limit for one spending category, set on the **Budgets** page. Each shows what is spent, what is left, and a state: on track, close to the limit (80% used, or over half used and ahead of an even pace through the month) or over. Use the arrows to look at earlier months.

- **Suggestions:** categories with no budget get a starting figure, the average of the last three full months rounded up to ₹100. They need spending in at least two of those months, so one odd month does not set the limit. "Add all" takes them in one click.
- **Spending without a budget** in the month is listed, with a button to set one.
- **Needs attention:** a budget that is over or close to its limit appears on the dashboard, once per month, so turning it down does not hide next month's.
- **Agents:** the `get_budgets` MCP tool reads them (read only).
- A budget counts what the category's transactions add up to. It does not predict the month, since bills such as rent land once and a straight-line projection would mislead.

## Bills

The **Bills** page lists payments that keep coming back, found from your own transactions rather than typed in: the same payee, at about the same interval, three times or more (twice for a yearly one). Weekly, monthly, quarterly and yearly rhythms are recognised, and narrations whose reference numbers change are still grouped.

- **Coming up:** the typical amount (marked "about" when it varies, like an electricity bill), when it was last paid and when it is next due, plus what you are committed to each month and what falls due in the next 30 days.
- **Overdue and lapsed:** a bill shortly past its date is flagged as expected but not seen. One that has gone quiet is moved to "Not seen lately", which is where a cancelled subscription, or one that quietly stopped, shows up. After two missed cycles it drops off.
- **Hide** anything that is not really a bill; it can be brought back. Nothing is stored apart from that, so the list follows the data as you import more.
- **Needs attention** shows bills expected in the next 7 days. The `get_recurring_payments` MCP tool reads the same list.
- Detection looks at spending categories only, so card bill payments and other transfers are never counted twice. Bills you have paid fewer than three times are not found until they have been.

## Investments

The **Investments** page tracks mutual funds. Upload a statement and review what was read before it is imported.

- **Supported statements:** CDSL consolidated account statements (holdings and transactions) and Scripbox portfolio summaries. Funds are matched across statements by ISIN, then folio, then name, so a second statement updates the same fund instead of adding a copy.
- **In the ledger:** each investment account is revalued to market value against an "Unrealised Gains" equity account. Gains therefore show in net worth but never count as income or spending. Undoing an import rebuilds the account from the remaining imports, so it returns exactly to where it was.
- **Returns:** XIRR is computed from transactions only when the full history is known. Otherwise the figure reported in the statement is shown and labelled "as reported".
- **Prices:** "Update prices" downloads AMFI's NAV file (override the address with `AMFI_URL`) and revalues funds by ISIN, keeping the units from the last statement. It is disabled in demo mode.
- **Check a real statement without importing it:** `node apps/server/src/scripts/check-investments.ts <file.pdf>` prints counts and totals only, no names or amounts per fund.

## Agents and MCP

Ledgerly has an [MCP](https://modelcontextprotocol.io) server, so an AI agent can
look at your finances and help sort them out.

**What an agent can do**

- Read accounts, balances, transactions, spending by category, income and
  spending over time, biggest payees and net worth.
- See transactions and statement rows that still need a category.
- **Suggest** categories for transactions and statement rows, and suggest rules.

**What it cannot do:** change, delete or import anything by itself. A suggestion
waits on the **Agents** page, where you see the transaction, the old and new
category and the agent's reason, then approve or reject it (or approve all). If
you changed that transaction yourself in the meantime, the suggestion is not
applied. Every request an agent makes is listed under Recent activity.

Statement text is untrusted, so the server tells agents to treat descriptions and
payees as data and never as instructions, and a suggestion can only ever be a
category or a rule.

**Connecting**

- *Over the network:* on the Agents page create a token (read only, or read and
  suggest). It is shown once and only its hash is kept. Then, for example in Claude
  Code: `claude mcp add --transport http ledgerly http://localhost:4310/mcp --header "Authorization: Bearer <token>"`.
  The endpoint always needs a token, even when the app itself needs no login.
- *On the same machine:* run `pnpm mcp`, or in Docker
  `docker exec -i <container> node packages/mcp/src/stdio.ts`. It uses the same
  database and needs no token. Set `LEDGERLY_MCP_SCOPE=read` to stop it suggesting.

Agent access is turned off in demo mode.

## Review: idle cash, portfolio and AI

The **Review** page answers "is there money sitting idle, and is my portfolio sensible?". It is decision support, not licensed advice. Ledgerly never moves money or places orders.

- **Idle cash** is worked out by code: bank and cash, less credit card balances owed, less bills expected in the next 30 days, less an emergency buffer of several months of spending (6 by default, your choice). Spending comes from the last three full months, and months with no data are left out, so a short history gives a rough guide and says so.
- **Balance check:** idle cash is only as good as the balances. If an account's balance in your books differs from the one printed on its latest imported statement (usually money held before your first statement), the page says so, and so does the dashboard, with a button that adds the difference as an opening balance before the first transaction. Income, spending and history do not change. When your books come from imported statements, a month counts toward "a normal month" only if a bank statement covers all of it.
- **Portfolio:** allocation by asset class against a target mix you set, plus plain facts: a fund that is a large share of the whole, values that have gone stale, funds that look like Regular plans.
- **Market context** (optional): public price history for your funds and a broad index, from AMFI and mfapi.in. Only public scheme codes are sent, nothing about you.
- **AI review** (optional) asks a model to explain those figures and lay out the options for idle money, with when each fits and what it costs. It is told to use only the figures given, to predict nothing and to name no products to buy. The answer is shown as plain text, and every review is kept with exactly what was sent.

**Choosing a model.** Set these in `.env` (or the environment) and restart. With none set, everything except the AI review still works.

| Provider | Settings |
| --- | --- |
| Anthropic | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, optional `AI_MODEL` |
| Amazon Bedrock | `AI_PROVIDER=bedrock`, `AI_MODEL`, `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key), `AWS_REGION`. IAM-role signing is not supported. |
| Ollama, llama.cpp, vLLM, LM Studio or any OpenAI-compatible server | `AI_PROVIDER=openai`, `AI_MODEL`, `AI_BASE_URL` (Ollama: `http://localhost:11434/v1`), optional `AI_API_KEY` |

**What leaves your machine.** Only when you press Run review, and only to the host you configured (shown on the page; a model on your own machine is marked as such). The page's "Show what will be sent" displays the exact summary first: whole-rupee totals, category averages, fund names and shares. It never includes account names or numbers, payee names or individual transactions. Keys are sent in a header and are never stored, logged or returned by the app. The AI review is off in demo mode.

Agents can read the same summary with the `get_financial_review` MCP tool.

## Forecast

The **Forecast** page projects your bank balance over the next 30 to 180 days: today's balance, recurring income and bills on the days they usually arrive, active SIPs, and your usual remaining spending spread evenly. It shows the lowest point and the first day the balance would go below zero, and the dashboard warns when that is within 30 days. A credit card bill counts on the due date of its latest imported statement (an overdue one is assumed paid tomorrow); spending on the card since then is not included. It is an estimate; with under a month of history it leaves everyday spending out and says so.

## Other assets

**Other assets** holds what is not in a bank account or a fund statement: fixed deposits, recurring deposits, PPF, EPF, NPS, stocks, gold, property. Each is an ordinary asset account, so it counts in net worth, and a rise in value is never counted as income. A fixed deposit with an interest rate and start date grows by itself, compounded quarterly until maturity; everything else is valued by hand. A deposit maturing within 30 days shows on the dashboard, and the Review page sends the assets (kind, value, rate, maturity, no names) along with the rest of the summary.

Other assets are counted in more than net worth:
- **Mix:** the Review page's allocation and target mix cover mutual funds plus these assets: deposits, RDs, PPF and EPF as debt, NPS as hybrid, stocks as equity, gold as gold. Property is left out, since it is not something you rebalance.
- **Forecast:** a deposit maturing in the window pays its maturity value into the bank on that day (if you renew it instead, the forecast is too high from then).
- **Tax:** interest a fixed deposit earned in the year is listed on the Tax page, worked out from its rate and taxed as income at your slab rate; the TDS limit is shown but TDS itself is not tracked.
- **Not counted as idle cash:** deposits are not instantly available, so they stay out of the idle-cash figure.

## Goals

**Goals** tracks what you are saving for. Point a goal at the accounts that hold its money, add savings kept by hand, and give an optional date. It shows progress, what to set aside each month to meet the date and, from what you usually save, when you would get there.

## Alerts

Set `NOTIFY_NTFY_URL`, `TELEGRAM_BOT_TOKEN` with `TELEGRAM_CHAT_ID`, or `NOTIFY_WEBHOOK_URL` (Slack, Discord, Mattermost, your own) in `.env` and Ledgerly sends a message when something needs you: a bill due within 7 days, a budget over its limit, a balance heading for zero, a deposit about to mature, or a balance that disagrees with its statement. It checks hourly, sends each finding once (a new bill or a new month is a new message), and tries again if every channel failed. The **Alerts** page shows where messages go (host only), lets you choose which kinds you want, sends a test message and lists what was sent. Addresses and tokens stay in the environment and are never shown. Alerts are off in demo mode.

## Receipts and bills

Press **Receipts** on any transaction to attach a PDF, PNG, JPEG or WebP (up to 10 MB). The type is checked from the file's contents, not its name. Files are kept on this machine in the data folder, included in backups, shown with headers that stop them running anything, and removed when you delete the transaction or the receipt.

## Payslips

On the Import page, **Payslips** reads a payslip PDF for the month, gross pay, net pay and deductions (income tax, the employee's provident fund, professional tax, anything else), shows them for you to correct, and records the salary the way it really is: the **full gross pay as income**, the tax and other deductions split out, the provident fund as money moved into a Provident Fund account, and only the net reaching the bank. Payslip layouts are the employer's own, so what could not be read is listed for you to fill in, and nothing is added until you confirm. The PDF is read for its numbers and not kept (it holds PAN and other identity numbers the books have no use for); locked ones are tried with the password you give or the ones saved in Settings. When the bank statement later shows the salary credit, the entry is taken over (same account and net amount, within three days) instead of being added again. Payslips also fill a **Salary** sheet in the tax pack (gross, income tax, provident fund and professional tax by month, with totals).

## Knowing what is missing

The Import page shows, for each account, which months have statements you have imported (a card's cycle that runs from the 10th to the 9th counts, because a month is covered when the periods together cover every day of it). A month with none is marked, and an alert on the dashboard names the missing months, since payments from your bank with no card purchases make a card show a credit. Each alert has a "What does this mean?" note. New accounts get a **Getting started** list on the dashboard (add accounts, import a statement, check categories, set a budget) that ticks itself off, and a **How it works** page explains card purchases, card bill payments, salary and SIPs in plain words.

## Tax

The **Tax** page, per Indian financial year, works out mutual fund capital gains first in, first out from your imported statements: equity funds short term (up to 12 months) and long term, with the yearly long-term exemption and an estimate of the tax, and the gain on other funds (debt, gold, hybrid), whose tax depends on purchase date and holdings. It tells you when a sale reaches back past your earliest imported statement, since that cost is unknown. Deductions (80C, 80CCD(1B), 80D, 80G, 24(b)) are tracked against their limits from the categories you assign to each section, and purchases of ELSS funds count toward 80C. Sales before 23 July 2024 use the old rates (15% and 10%, with a ₹1 lakh exemption until 2023-24) and later ones the new (20% and 12.5%, ₹1.25 lakh), blended in a year that has both. **Download for filing (CSV)** lists every sale with the fund's ISIN, purchase and sale dates, units, cost, sale value and term, which is what a return's capital gains schedule asks for. The **tax pack** (Excel) puts it all in one workbook for your accountant: a summary, the mutual fund sales, deposit interest, interest credited to savings accounts, deductions by section with the transactions behind them, salary from your payslips, and income or advance tax recorded, each sheet with the lines behind its total. Not handled: units bought before 1 February 2018 (their cost for long-term gains is the higher of cost and the 31 January 2018 value), equity-oriented hybrid funds (counted as other funds), and cess or surcharge. Rates change. It is an estimate to plan with, not a tax return or advice.

## Split transactions

Press **Split** on a purchase or receipt to spread it across categories (part groceries, part household). The account balance does not change, and amounts must add up exactly.

## Holdings CSV and SIPs

The Investments and Import pages also take a **CSV or TSV export of holdings** from a broker or app: it needs a name column and units or a value, and recognises common headers (Instrument, Qty., Avg. cost, LTP, Cur. val; Scheme Name, Units, NAV, Current Value, Invested Amount and similar). Stocks are treated as equity. An export has no date, so today is used. **Monthly SIPs** are found from fund statements (the same fund, a fixed amount, about monthly), checked against your bank transactions, and counted in the forecast.

## Install as an app

Ledgerly can be installed from the browser (Chrome, Edge, Safari: Install or Add to Home Screen) and opens like any app. The browser keeps only the app's own files; nothing from the API is ever cached. Installing needs `localhost` or HTTPS.

## Statement folder and bank CSVs

- **Statement folder:** set `WATCH_DIR` (in Docker, mount a folder at `/inbox`, the default `./inbox`, and set `WATCH_DIR=/inbox`) and Ledgerly looks there every five minutes. Anything you drop in (a bank or card PDF, a fund statement, a CSV) is read, filed in `processed/`, and imported by the same safe rules as bulk import. Files it cannot use go to `held/` with the reason on the Import page, and your alert channel is told. Locked PDFs are tried with the passwords in `WATCH_PASSWORDS` (comma separated, stored only in your `.env`). A mail rule, a download folder or a sync client can also feed the folder. To collect from a mailbox directly, see Statements from email below.
- **Bank CSV downloads:** most banks offer a CSV. Ledgerly reads the common layouts: separate withdrawal and deposit columns, debit and credit columns, or one amount with a Dr/Cr column, with preamble lines, quoted commas, Indian digit grouping, many date styles and newest-first order. When the file has a running balance it is checked against the amounts and the import is flagged if they disagree, which catches missing rows. A CSV does not say which account it is, so you choose one in the review. These are not yet tried against any real bank's file, so tell me if one does not read. Excel workbooks (`.xlsx`, the biggest sheet in the file) are read the same way, for statements and holdings alike, and for the statement folder and email; the old `.xls` format needs saving as `.xlsx` or CSV first.

## Statements from email

Point Ledgerly at a mailbox and statements that arrive by email are collected for you.

1. **Make a mailbox just for statements** (a new Gmail or Outlook address) and forward your bank, card and Scripbox mail to it, or have those senders use it. Create an **app password** for it. Do not give Ledgerly your main email password.
2. Set `MAIL_HOST` (such as `imap.gmail.com`), `MAIL_USER`, `MAIL_PASSWORD` and **`MAIL_SENDERS`**, the addresses or domains statements come from (`axisbank.com,scripbox.com`), in `.env` and restart. Optional: `MAIL_FOLDER`, `MAIL_PORT`, `MAIL_SECURE`, and `WATCH_PASSWORDS` for locked PDFs.

On the quarter hour (:00, :15, :30, :45, plus a few seconds of its own, so a restart does not move the times) it asks the mailbox for **unread mail from those senders only**: nothing else is downloaded or opened. Each PDF or CSV attachment is read, staged and imported by the same safe rules as bulk import, anything unreadable or needing a decision waits on the Import page (and in your alert channel), and a message is marked read only once its attachments are dealt with. A statement already imported is recognised by its contents, so reading one twice does no harm.

**Safety.** A From line is easy to forge, and a forged statement would put false numbers in your books. So a message is believed only if the sender is on your list **and** your mail provider's own check (DMARC, or a DKIM signature made by the sender's own domain) says it really came from there. Mail that fails or was not checked is ignored, and the Import page says so. `MAIL_REQUIRE_AUTH=false` turns that off if your provider does not record it. Links in mail are never followed, only attachments are read. The password stays in `.env` and is never shown or logged. It is read-only apart from marking messages read: Ledgerly never deletes, moves or sends mail.

**Bank alerts.** Banks also email each transaction as it happens ("INR 1,250.00 spent on your Credit Card XX7788 at SWIGGY", "INR 500.00 was debited from A/c XX1234"). Add the bank's alert address to the senders list (and to your forwarding filter, without "has attachment", since these have none) and Ledgerly reads the amount, direction, the account or card by its last four digits, the date and the payee, and lists them on the Import page under **Alerts from your bank**. Add one and it is in your books now, filed by the same rules as statements (the account must have its last four digits set); or switch on **Add them automatically**. When the statement later arrives, the transaction it matches (same account and amount, within three days) is taken over, keeping the category you chose and any receipts, instead of being added again, and an alert you never added is marked as covered. A message is read only if it clearly gives an amount, a direction and an account, and is left alone otherwise (one-time-password mail, transfers that name both a debit and a credit). **Bank wording differs and changes**, and this was written from the common shapes without access to every bank's real emails, so check what it reads before trusting it; if an email is missed or misread, it is the wording that needs adding to the reader.

**Limits.** Many banks email a link to download a statement, or a notice with no file; those cannot be collected this way. It has been tested with made-up messages and a stand-in mailbox, not a live IMAP server, so try it with one real statement first. One mailbox serves the administrator only, not each person on a multi-user server (a mailbox password is not something to keep inside everyone's books).

## More AI, all optional and all opt-in

These need an AI provider (see Review) and are off until you turn each one on, after reading what it sends.

- **Suggest categories** (Rules page): for payees no rule or past choice covers, a model suggests a category. Each confident answer becomes a suggested rule waiting in the Agents approval list, so nothing is categorised until you approve it. Only the payee text with long numbers blanked, how often it appears, a rough amount and your category names leave the machine, shown in full first: never dates, accounts, balances or individual transactions.
- **Ask** (Ask page): a plain-words question, answered by a model that looks things up with the same read-only tools an MCP agent gets, one at a time, and says what it looked at. It cannot change anything, only tools that read are given to it, and each lookup is recorded on the Agents page as "Ask Ledgerly". What the lookups return (names, payees, amounts) goes to the model, which is why it is a separate switch. It may be wrong; check anything important against the page it came from.
- **Read a receipt** (Receipts on a transaction): for a PNG, JPEG or WebP, "Read with AI" sends that one picture to a vision model, then shows what it read next to the transaction (amount, date and shop agree or differ). Nothing is changed. PDFs are kept but not read this way.

## Spotting odd spending and tidy rules

- **Odd spending:** found from your own habits, with nothing sent anywhere: a charge far above what a payee usually costs, the same charge twice in two days, a subscription or bill that went up, and a month well above normal once it is half over. They show as one finding on the dashboard, can be sent as an alert, and are prompts to look, not accusations. Agents can read them with `get_anomalies`.
- **Rules to tidy** (Rules page): rules that match nothing in your books, rules a broader one above them always beats (in the same category, or sending the same payments somewhere else), with the reason and a Remove button. Nothing is removed for you.
- **Preview an import:** before pressing Import on a bulk upload, "Preview what will happen" does the whole import and undoes it, showing what would be added (transactions, money in and out), what would be held back and how each balance would change. Nothing is saved.

## Your own alert channels

On a server shared by several people, each person can add their own ntfy, Telegram or webhook on the Alerts page, so their alerts go to them and not the person running the server. The address or token is kept in their own books and never shown again, only where it goes. Anyone but the administrator may use only public `https` addresses, never `localhost` or a private network, so nobody can make the server call machines inside its own network. The administrator is not limited, since they run the machine.

## Credit cards

A card statement's payment due date and minimum due are read and kept. The bill still owed (the statement amount, less what you have paid since) counts in the forecast on its due date, raises a finding in the last five days and when overdue, and can be sent as an alert. Spending on the card since that statement is not included until the next one is imported.

## Loans and insurance

**Loans** take the amount, rate, years and first instalment date (the EMI is worked out unless you give it) and show the schedule: instalments paid and left, what is still owed, interest still to pay and the payoff date. They show what putting in a lump sum now would do with the same EMI, in interest saved and months saved, and say plainly that prepaying earns the loan's own rate, guaranteed. **Insurance** policies show the next premium date, which moves on by itself, and the yearly cost, with a reminder within two weeks. Instalments and premiums are counted in the forecast, unless the bank history already shows them as a recurring bill, so nothing is counted twice.

## Summary and prices

On the Alerts page, choose a **weekly or monthly summary**: net worth and its change, idle cash, what is due this week, budgets and the lowest bank balance ahead, with totals only and no names. On the Investments page, turn on **daily prices** to refresh fund NAVs from AMFI once a day. Stock and gold prices have no free dependable source, so those stay manual.

## Sharing and safety

- **Read-only login:** set `VIEWER_PASSWORD` (with `AUTH_PASSWORD`) for a login that can look at everything and change nothing, for a partner or an accountant. It cannot download database backups or see agent tokens.
- **Change log:** every change records who made it and whether it went through, by route and item and never by content, so no password or amount is kept. Blocked attempts and wrong passwords are included. See it under Change log.
- **Encrypted backups:** set `BACKUP_PASSPHRASE` and new backups are AES-256-GCM encrypted (`.tar.gz.enc`), safe to put in cloud storage. Restoring needs the same passphrase (`BACKUP_PASSPHRASE=... pnpm restore file`). Without it a backup cannot be opened, so keep it somewhere safe. Existing plain backups are not changed.

## Rules by amount and account

A rule can also require an amount range and one account, such as "Amazon, over ₹5,000, goes to Shopping" and "Amazon, under ₹1,000, goes to Subscriptions". A condition that cannot be checked yet (an import with no account chosen) does not match, so a rule never fires on a guess; it applies once the account is known.

## Performance

At 100,000 transactions (about twenty years of heavy use) the main pages answer in tens of milliseconds, and the dashboard's findings in a few seconds. `pnpm perf` times them on made-up data. It found and fixed three slow spots: an account's transaction list, the net worth history and recurring-bill detection.

## Quick add and compare

**Quick add** logs a purchase in a few seconds from a phone (it remembers the account), and is a shortcut on the installed app. Reports now compare this year's monthly spending with last year's.

## Running a site people sign up to

Set `MULTI_USER=true`, `AUTH_PASSWORD` (the first administrator's password, used once), `COOKIE_SECURE=true`, and put it behind HTTPS (Caddy or nginx, with `TRUST_PROXY=true` if the proxy is not on the same machine). Then choose who may create an account, under **People** or with `SIGNUP_MODE`:

- **Closed** (the default): only administrators make accounts.
- **Invite only:** a person needs a one-time code an administrator made.
- **Open, with approval:** anyone can sign up, but cannot use anything until an administrator approves them. A sensible start for a public site.
- **Open:** anyone can sign up and use it at once.

**For each person.** Their own private books, statements, receipts, backups, agent tokens, rules and change log, in `data/users/<id>/`, and their own **Settings**: AI provider and key, mailbox, a statement folder of their own (a fixed place inside their data folder, never a path they choose), the passwords for their locked PDFs, and alert channels. Keys and passwords are encrypted at rest and never shown again. Except for the person running the server, nobody may point the server at an address inside its own network (private ranges, `localhost`, the cloud metadata address): their AI server and mailbox must be on the public internet and any webhook must be public `https`. Each person can download a backup of everything and close their own account, which deletes it for good.

**Protections.** Sign-up asks for a small piece of work in the browser (a hash puzzle, no outside service), has a hidden field robots fill in, and is limited per address (`SIGNUP_RATE`). A username is paused for fifteen minutes after eight wrong passwords. Passwords need 10 characters and are checked against the obvious ones. `USER_QUOTA_MB` caps each person's disk use. Responses carry a strict content policy (the page may run only its own scripts), clickjacking and sniffing protection, and HSTS over HTTPS. Background work (backups, prices, alerts, folders, mailboxes) runs from one loop that opens a person's books only when something of theirs is due, and the server closes the books of people who have gone quiet (`MAX_OPEN_LEDGERS`).

**Sharing books.** Each person's books are theirs, and they can let others in under **People and password → Share my books**: a **viewer** can look at everything and change nothing, an **editor** can also add and change transactions, accounts, budgets and so on. Neither sees the owner's settings, keys, mailbox, backups, agent access, or anything that spends the owner's AI key, and the owner can take access away (or the person can leave) at any time. Someone let in gets a **Books** switcher in the menu and a banner saying whose books they are in; their own books stay separate. Files and storage count against the owner's space. Sharing is by username, between accounts on the same site; there is no invitation by email.

**Email.** Set `SMTP_HOST`, `SMTP_FROM` and `PUBLIC_URL` (the address people open the site at, used in the links), plus `SMTP_USER` and `SMTP_PASSWORD` if your provider needs them, and the site starts sending mail: sign-up then asks for an address and the account works only after the link in the confirmation mail is opened (3 days); the login page gets **Forgot password?**, which mails a link that works for one hour and only once (it signs the person out everywhere, and two-step sign-in still applies); and each person can choose a **monthly summary** under Settings, sent from the second of the month with last month's income, spending, saved, top categories and anything needing attention (the subject has no amounts, and the mail itself is ordinary email, so it is opt-in and says so). The server never reveals whether an address has an account, limits how often a link can be requested, and sends plain text only. Without SMTP everything works as before and an administrator resets forgotten passwords.

**Site overview and legal pages.** Administrators get a **Site overview** page (the admin-only item in the menu): people counted by state (active, waiting, unconfirmed, disabled), sign-ups over the last 14 days, space each person uses against the quota, last sign-in and whether two-step is on, and the latest failed sign-ins (wrong password, wrong code, a paused name, from which address). Failures are kept in memory only, and a name is shown only if it is a real account, since a mistyped one may be a password. The same page holds the **terms and privacy** text: starting templates that describe what Ledgerly actually does, which you must complete (the page refuses to switch them on while [PLACEHOLDERS] remain) and should have checked for where you live. Once on, they are public at `/terms` and `/privacy`, and sign-up asks people to agree, recording when. This is a template and not legal advice.

**Two-step sign-in.** Each person can turn on a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password) under **People and password**: scan a QR code (or type the key), confirm one code, and save the eight recovery codes shown once. After that, signing in needs the password and a code. Each code works once, wrong codes count toward the same pause as wrong passwords, the secret is stored encrypted, and only hashes of recovery codes are kept. An administrator can reset it for someone who has lost their phone and codes, which also signs that person out everywhere. It applies to multi-user mode; the single shared `AUTH_PASSWORD` login does not have it.

**Set `SECRETS_KEY`** (`openssl rand -base64 32`) in the environment. It is the key that opens everyone's stored API keys and mailbox passwords. Without it one is made in the data folder, next to the data, which is fine for yourself but means a copy of the data folder is a copy of the keys. Lose it and those keys must be entered again; nothing else is affected.

**What is not here yet, and matters for a public site.**
- **Email is optional.** Without SMTP set up nothing is sent, so there is no email verification and no "forgot password": an administrator sets a new password (the person's books are untouched), and people are told so when they sign up. A public site should set up SMTP (above).
- No CAPTCHA service (the puzzle only raises the cost for bots), and no abuse monitoring beyond the limits above.
- **Terms and privacy are templates.** People will put their financial records here, so write and check your own (the admin page has templates), and you are responsible for what you hold: back up the whole data folder, and think about who can reach the machine.
- **One server process with SQLite.** It will carry a good number of people, and `pnpm perf` shows how it behaves at size, but it is not built to spread across several machines.

## Backups that survive the disk

Backups in the data folder do not survive the disk they are on. Set `BACKUP_PASSPHRASE` and either `BACKUP_COPY_DIR` (a folder on another drive, a NAS, or one your sync tool uploads) or the `BACKUP_S3_*` settings for any S3-compatible bucket (Amazon S3, Backblaze B2, Cloudflare R2, MinIO), and after each daily backup the encrypted file is also copied there, in a folder per person. Only encrypted backups are ever copied out. Folder copies keep the same number as on the machine; for a bucket, set a lifecycle rule at the provider to expire old ones. After each backup the newest is also opened in a scratch copy and checked (it decrypts, the database is whole, every transaction balances), and the **Backups and export** page shows the result and when the last copy went out, with buttons to check or copy now. The upload is signed with AWS Signature Version 4, written without a library and tested against AWS's published example.

## Several people, separate books

Set `MULTI_USER=true` (with `AUTH_PASSWORD`, and optionally `ADMIN_USERNAME`, default `admin`) and sign-in asks for a username. **The books already on the server become the first administrator's**: nothing moves, and `AUTH_PASSWORD` is only used the first time, to set that administrator's password (change it later on the People page, which also changes it for anyone else you add).

- **Everyone has their own ledger.** Each person has their own database file, statements, receipts, backups, agent tokens, rules, budgets and change log, in `data/users/<id>/`. Nothing is shared and there is no way, in the app, for one person to see another's money, including an administrator.
- **Administrators** add people (username and password; a new person starts with an empty ledger), disable them (which signs them out immediately), reset passwords, and make others administrators. The last administrator cannot be removed or demoted. Deleting a person removes all of their books and files, and only works once they are disabled and their username is typed to confirm. The first administrator's books are never deleted from the app.
- **Passwords** are hashed with scrypt, a wrong username and a wrong password give the same answer in the same time, and changing a password signs that person out everywhere else.
- **Agents:** a token opens only the books of the person who made it (it carries their id), so one person's agent can never reach another's data.
- **What belongs to the server's owner:** the alert channels (`NOTIFY_*`), the statement folder (`WATCH_DIR`) and the AI key are set in the environment, so they work for the first administrator only. Others get everything else, but no alerts or AI review until `AI_FOR_ALL_USERS=true` for the AI (which spends your key on their behalf, and sends their summaries to that provider). Per-person alert channels are not built.
- **Restoring** one person's backup: run `pnpm restore` with `DATA_DIR` set to their folder (`data/users/<id>`).
- A read-only login (`VIEWER_PASSWORD`) is for one person sharing their own books and is not available together with `MULTI_USER`; sharing one ledger between several named people is not built.

## Backups and export

Everything lives in the data folder (`data/` locally, the `/data` volume in Docker): the database and the statements you uploaded.

- **Automatic:** a backup is taken when the server starts and then daily, keeping the newest 14. Each is one `.tar.gz` in `data/backups/` holding a consistent copy of the database and the uploaded statements. The **Backups and export** page lists them, takes one on demand, and downloads or deletes them. Copy them off the machine: a backup on the same disk does not survive the disk. Backups are off in demo mode.
- **Restore:** stop the server, then `pnpm restore path/to/backup.tar.gz`. The backup is checked first, and the data it replaces is kept beside it as `*.before-restore-<time>`. In Docker: `docker compose run --rm ledgerly node apps/server/src/scripts/restore.ts /data/backups/<file>` (stop the service first).
- **Export:** the same page downloads transactions as CSV, optionally for a date range. Each ledger line is a row, so a transfer shows both sides. Text that a spreadsheet could run as a formula is defused.

## Theme

The toggle at the bottom of the menu switches between **Auto** (follows your
device), **Light** and **Dark**. The choice is remembered in your browser.

## Develop

```bash
nvm use
pnpm install
pnpm dev
```

The web app runs on http://localhost:5173 and the API on port 4310. Local data
goes in `data/`, which is ignored by git.

| Command | Purpose |
|---|---|
| `pnpm test` | Run the tests |
| `pnpm typecheck` | Check types |
| `pnpm build` | Build the web app |
| `pnpm start` | Serve the API and built web app on port 4310 |
| `pnpm db:generate` | Create a migration after editing `packages/db/src/schema.ts` |

Migrations run automatically when the server starts.

## Layout

```
apps/server     Fastify API, login and request guards
apps/web        React app
packages/core   Ledger rules and reports, shared by the API and the MCP server
packages/mcp    The MCP server (stdio, and over HTTP through the app)
packages/db     Drizzle schema and migrations
```

Amounts are integers in paise. Debits are positive, credits are negative, and
the postings of every transaction sum to zero. Categories are income and expense
accounts.

## License

GNU Affero General Public License, version 3 or later. You can use, change and share Ledgerly freely. If you run a modified version as a service for other people, you must make your changes available to them under the same license. See [LICENSE](LICENSE).
