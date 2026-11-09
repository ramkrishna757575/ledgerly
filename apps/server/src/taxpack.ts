import { taxPack } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import writeExcelFile from 'write-excel-file/node';

type Cell = string | number | null | { value: string | number | null; fontWeight?: 'bold'; format?: string; type?: typeof Number | typeof String };
type Row = Cell[];

const bold = (value: string): Cell => ({ value, fontWeight: 'bold' });
const money = (paise: number): Cell => ({ value: paise / 100, type: Number, format: '#,##0.00' });
const head = (...names: string[]): Row => names.map(bold);
const units = (micro: number): Cell => ({ value: micro / 1_000_000, type: Number, format: '#,##0.000' });

// One workbook for the year: a summary, then a sheet for each thing a return asks about, each
// with the lines behind its total, so an accountant can check or paste them.
export async function taxPackWorkbook(db: Db, fy: string) {
  const pack = taxPack(db, fy);
  const g = pack.gains;
  const sheet = (name: string, rows: Row[]) => ({ sheet: name, data: rows as never, columns: [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 14 }] });

  const summary: Row[] = [
    [bold(`Tax pack for ${fy}`)],
    ['An estimate to plan with, worked out from your own records using the rules as they stand. It is not a tax return or advice. Check it with a chartered accountant before you file.'],
    [],
    head('Capital gains on mutual funds', 'Amount (INR)'),
    ['Equity funds, short term gain', money(g.equity.shortTermGain)],
    ['Equity funds, long term gain', money(g.equity.longTermGain)],
    ['  of which under the yearly exemption', money(g.equity.longTermExempt)],
    ['Loss to carry forward', money(g.equity.lossToCarryForward)],
    ['Estimated tax on equity gains (before cess and surcharge)', money(g.equity.estimatedTax)],
    ['Other funds (debt, gold, hybrid), gain', money(g.other.gain)],
    ...(g.complete ? [] : [[`Not complete: ${(g.unmatchedProceeds / 100).toFixed(2)} of sales are of units bought before the earliest imported statement`] as Row]),
    [],
    head('Other income', 'Amount (INR)'),
    ['Interest credited to savings accounts', money(pack.interestReceived.total)],
    ['Interest earned on fixed and recurring deposits (accrued)', money(pack.fdInterest.total)],
    [],
    head('Deductions (old regime only)', 'Total', 'Limit', 'Counted'),
    ...pack.deductions.map((d): Row => [d.label, money(d.total), d.limit === null ? 'no limit' : money(d.limit), money(d.counted)]),
    [],
    head('Salary', 'Amount (INR)'),
    ['Gross salary from payslips', money(pack.salary.reduce((s, p) => s + p.gross, 0))],
    ['Income tax deducted (TDS) on payslips', money(pack.salary.reduce((s, p) => s + p.tax, 0))],
    [],
    head('Tax already paid', 'Amount (INR)'),
    ['Income tax and advance tax recorded', money(pack.taxesPaid.total)],
    ['TDS deducted by banks and employers is not tracked here. Check Form 26AS.'],
  ];

  const sales: Row[] = [
    head('Fund', 'ISIN', 'Fund type', 'Bought on', 'Sold on', 'Units', 'Cost (INR)', 'Sale value (INR)', 'Gain (INR)', 'Days held', 'Term'),
    ...g.sales.map((s): Row => [s.fund, s.isin ?? '', s.assetClass, s.boughtOn, s.date, units(s.units), money(s.cost), money(s.proceeds), money(s.gain), s.heldDays, s.term === 'long' ? 'Long term' : 'Short term']),
  ];

  const deposits: Row[] = [
    head('Deposit', 'From', 'To', 'Principal (INR)', 'Rate (%)', 'Interest (INR)'),
    ...pack.fdInterest.items.map((i): Row => [i.name, i.from, i.to, money(i.principal), { value: i.rateBps / 100, type: Number, format: '0.00' }, money(i.interest)]),
    [bold('Total'), '', '', '', '', money(pack.fdInterest.total)],
  ];

  const lines = (rows: { date: string; description: string; category: string; amount: number }[]): Row[] => [
    head('Date', 'Description', 'Category', 'Amount (INR)'),
    ...rows.map((l): Row => [l.date, l.description, l.category, money(l.amount)]),
  ];

  const deductionLines: Row[] = [head('Section', 'Date', 'Description', 'Category', 'Amount (INR)')];
  for (const d of pack.deductions) for (const l of d.lines) deductionLines.push([d.section, l.date, l.description, l.category, money(l.amount)]);

  const salary: Row[] = [
    head('Month', 'Employer', 'Gross (INR)', 'Income tax (INR)', 'Provident fund (INR)', 'Professional tax (INR)', 'Other (INR)', 'Net (INR)'),
    ...pack.salary.map((p): Row => [p.month, p.employer, money(p.gross), money(p.tax), money(p.pf), money(p.professionalTax), money(p.other), money(p.net)]),
    pack.salary.length > 0 ? [bold('Total'), '', money(pack.salary.reduce((s, p) => s + p.gross, 0)), money(pack.salary.reduce((s, p) => s + p.tax, 0)), money(pack.salary.reduce((s, p) => s + p.pf, 0)), money(pack.salary.reduce((s, p) => s + p.professionalTax, 0)), money(pack.salary.reduce((s, p) => s + p.other, 0)), money(pack.salary.reduce((s, p) => s + p.net, 0))] : ['No payslips recorded for this year'],
  ];

  const sheets = [
    sheet('Summary', summary),
    sheet('Mutual fund sales', sales),
    sheet('Deposit interest', deposits),
    sheet('Interest received', lines(pack.interestReceived.lines)),
    sheet('Deductions', deductionLines),
    sheet('Salary', salary),
    sheet('Tax paid', lines(pack.taxesPaid.lines)),
  ];
  const buffer = await (writeExcelFile as unknown as (sheets: unknown) => { toBuffer(): Promise<Buffer> })(sheets).toBuffer();
  return Buffer.from(buffer);
}
