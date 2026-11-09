import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { axisConsolidated, axisCreditCard, axisStatement } from './adapters/axis.ts';
import { builtinCategory } from './categorize.ts';
import { parseNarration } from './narration.ts';
import { detectAdapter } from './registry.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const sum = (rows: { amount: number }[]) => rows.reduce((total, row) => total + row.amount, 0);

describe('narration', () => {
  it('reads Axis UPI narrations', () => {
    expect(parseNarration('UPI/P2A/100000000001/Rahul Sharma /UPI/Demo Bank')).toEqual({
      channel: 'upi',
      reference: '100000000001',
      payee: 'Rahul Sharma',
    });
    expect(parseNarration('UPI/P2M/100000000002/SWIGGY/swiggy@icici/Demo Bank')).toMatchObject({
      payee: 'Swiggy',
      reference: '100000000002',
    });
  });

  it('reads credit card UPI narrations', () => {
    expect(parseNarration('UPI/Demo Cafe/democafe@icici/Payment')).toEqual({
      channel: 'upi',
      payee: 'Demo Cafe',
    });
  });

  it('reads NEFT in both layouts', () => {
    expect(
      parseNarration('NEFT/DEMOB2610050001/ACME TECHNOLOGIES LIMITED/DEMO BANK/OCTOBER SALARY'),
    ).toEqual({ channel: 'neft', reference: 'DEMOB2610050001', payee: 'Acme Technologies Limited' });
    expect(
      parseNarration('NEFT CREDITED FROM ACME TECHNOLOGIES LIMITED(DEMO BANK) (DEMOB2610020001)'),
    ).toEqual({ channel: 'neft', reference: 'DEMOB2610020001', payee: 'Acme Technologies Limited' });
  });

  it('reads ACH mandates even when the line wrapped', () => {
    expect(
      parseNarration('ACH-DR-DE ACH INDIAN CLEARING CORP- 1234567890-DEMO000001'),
    ).toEqual({ channel: 'ach', payee: 'Indian Clearing Corp', reference: '1234567890' });
  });

  it('recognises card payments, interest and charges', () => {
    expect(parseNarration('Demo Card Payment DE 1234 Ref#DEMOREF000001')).toEqual({
      channel: 'card_payment',
      reference: 'DEMOREF000001',
    });
    expect(parseNarration('BBPS PAYMENT #DEMO000000001').channel).toBe('card_payment');
    expect(parseNarration('SB:123456789012345:Int.Pd:01-07-2026 to 30-09-2026').channel).toBe(
      'interest',
    );
    expect(parseNarration('GST ON DEMO ANNUAL FEE').channel).toBe('charge');
    expect(parseNarration('PPF/100000000/DEMO CUSTOMER').channel).toBe('investment');
    expect(parseNarration('Something unexpected').channel).toBe('other');
  });
});

describe('built-in categories', () => {
  it('suggests from the merchant and the channel', () => {
    const swiggy = parseNarration('UPI/P2M/100000000002/SWIGGY/swiggy@icici/Demo Bank');
    expect(builtinCategory(swiggy, 'UPI/P2M/1/SWIGGY', 'out')).toBe('Food & Dining');
    expect(builtinCategory({ channel: 'interest' }, 'Int.Pd', 'in')).toBe('Interest');
    expect(builtinCategory({ channel: 'charge' }, 'GST', 'out')).toBe('Bank Charges');
  });

  it('puts the specific pattern ahead of the general one', () => {
    const category = (payee: string) => builtinCategory({ channel: 'upi', payee }, payee, 'out');
    expect(category('Amazon Pay Groceries')).toBe('Groceries');
    expect(category('Amazon India')).toBe('Shopping');
    expect(category('Netflix.com')).toBe('Subscriptions');
    expect(category('Indian Oil Corporation')).toBe('Fuel');
    expect(category('BESCOM')).toBe('Utilities');
  });

  it('does not guess for money coming in or unknown merchants', () => {
    expect(builtinCategory({ channel: 'upi', payee: 'Swiggy' }, 'Swiggy refund', 'in')).toBeUndefined();
    expect(builtinCategory({ channel: 'upi', payee: 'Ravi' }, 'UPI/Ravi', 'out')).toBeUndefined();
  });
});

describe('Axis consolidated statement', () => {
  const parsed = axisConsolidated.parse(fixture('axis-consolidated.txt'));

  it('reads every row, with narration that continues below', () => {
    expect(parsed.rows).toHaveLength(7);
    expect(parsed.rows[1]).toMatchObject({
      date: '2026-10-02',
      amount: 8500000,
      description: 'NEFT CREDITED FROM ACME TECHNOLOGIES LIMITED(DEMO BANK) (DEMOB2610020001)',
    });
    expect(parsed.rows[2]?.description).toMatch(/swiggy@icici\/Demo Bank LIMITED$/);
  });

  it('works out money in and out from the running balance', () => {
    expect(parsed.rows.map((row) => Math.sign(row.amount))).toEqual([-1, 1, -1, -1, -1, -1, 1]);
    expect(parsed.rows[2]?.amount).toBe(-125050);
  });

  it('adds up to the statement and ignores the page footer', () => {
    expect(parsed.openingBalance).toBe(10000000);
    expect(parsed.closingBalance).toBe(14164950);
    expect(sum(parsed.rows)).toBe(parsed.statedNet);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows.at(-1)?.description).not.toMatch(/Page/);
    expect(parsed).toMatchObject({
      accountKind: 'bank',
      accountLast4: '2345',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    });
  });
});

describe('Axis account statement', () => {
  const parsed = axisStatement.parse(fixture('axis-statement.txt'));

  it('joins narration written above the date line', () => {
    expect(parsed.rows).toHaveLength(7);
    expect(parsed.rows[0]?.description).toBe('SB:123456789012345:Int.Pd:01-07-2026 to 30- 09-2026');
    expect(parsed.rows[5]?.description).toBe(
      'NEFT/DEMOB2610050001/ACME TECHNOLOGIES LIMITED/DEMO BANK/OCTOBER SALARY October 26',
    );
  });

  it('takes the direction from the balance and reconciles with the closing balance', () => {
    expect(parsed.rows.map((row) => Math.sign(row.amount))).toEqual([1, -1, -1, -1, -1, 1, -1]);
    expect(parsed.openingBalance).toBe(10000000);
    expect(parsed.closingBalance).toBe(14164950);
    expect(sum(parsed.rows)).toBe(parsed.statedNet);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.accountLast4).toBe('2345');
    expect(parsed.periodStart).toBe('2026-10-01');
  });

  it('falls back to the column when there is no opening balance', () => {
    const without = fixture('axis-statement.txt').replace(/^.*OPENING BALANCE.*\n/m, '');
    const rows = axisStatement.parse(without).rows;
    expect(rows[0]?.amount).toBe(40000);
    expect(rows[1]?.amount).toBe(-125050);
  });

  it('flags a row that disagrees with the running balance', () => {
    const broken = fixture('axis-statement.txt').replace('99149.50', '99150.50');
    expect(axisStatement.parse(broken).warnings.length).toBeGreaterThan(0);
  });
});

describe('Axis credit card statement', () => {
  const parsed = axisCreditCard.parse(fixture('axis-card.txt'));

  it('reads charges as money out and payments as money in', () => {
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.rows[0]).toMatchObject({ date: '2026-09-14', amount: 500000 });
    expect(parsed.rows[1]).toMatchObject({
      amount: -32000,
      description: 'UPI/Demo Cafe/democafe@icici/Payment',
    });
    expect(parsed.rows[3]?.description).toBe('DEMO FOREX TRANSACTION ( USD 40.00 )');
  });

  it('checks the rows against the statement summary', () => {
    expect(parsed.openingBalance).toBe(500000);
    expect(parsed.closingBalance).toBe(750000);
    expect(parsed.statedNet).toBe(-250000);
    expect(sum(parsed.rows)).toBe(parsed.statedNet);
    expect(parsed).toMatchObject({
      accountKind: 'credit_card',
      accountLast4: '9876',
      periodStart: '2026-09-12',
      periodEnd: '2026-10-11',
    });
  });
});

describe('detecting a statement', () => {
  it('picks the matching adapter for each layout', () => {
    expect(detectAdapter(fixture('axis-consolidated.txt'))?.id).toBe('axis-savings-consolidated');
    expect(detectAdapter(fixture('axis-statement.txt'))?.id).toBe('axis-savings-statement');
    expect(detectAdapter(fixture('axis-card.txt'))?.id).toBe('axis-credit-card');
  });

  it('declines text it does not know', () => {
    expect(detectAdapter('Dear customer, your order has shipped.')).toBeUndefined();
  });
});
