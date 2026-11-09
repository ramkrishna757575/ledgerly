import { collapse } from './text.ts';

export type Channel =
  | 'upi'
  | 'imps'
  | 'neft'
  | 'rtgs'
  | 'ach'
  | 'card_payment'
  | 'atm'
  | 'pos'
  | 'interest'
  | 'charge'
  | 'cheque'
  | 'investment'
  | 'other';

export type Narration = {
  channel: Channel;
  payee?: string;
  reference?: string;
};

function tidy(name: string | undefined) {
  const cleaned = collapse((name ?? '').replace(/^[/\-\s]+|[/\-\s]+$/g, ''));
  if (!cleaned) return undefined;
  const shouting = cleaned === cleaned.toUpperCase() && /[A-Z]/.test(cleaned);
  if (!shouting) return cleaned;
  return cleaned.toLowerCase().replace(/(^|[\s.&(-])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
}

const digitsReference = (value: string | undefined) => (/^\d{9,}$/.test(value ?? '') ? value : undefined);

// Axis writes UPI and IMPS as TYPE/P2A/<reference>/<name>/..., while the credit
// card statement writes UPI/<name>/<handle>.
function transferByParts(channel: 'upi' | 'imps', text: string): Narration {
  const parts = text.split('/').map((part) => part.trim());
  if (/^P2[A-Z]$/i.test(parts[1] ?? '')) {
    return { channel, reference: digitsReference(parts[2]), payee: tidy(parts[3]) };
  }
  return { channel, payee: tidy(parts[1]) };
}

export function parseNarration(raw: string): Narration {
  const text = collapse(raw);

  if (/^UPI\//i.test(text)) return transferByParts('upi', text);
  if (/^IMPS\//i.test(text)) return transferByParts('imps', text);

  const slashed = /^(NEFT|RTGS)\/([^/]+)\/([^/]*)/i.exec(text);
  if (slashed) {
    return {
      channel: slashed[1]!.toLowerCase() as 'neft' | 'rtgs',
      reference: /^[A-Z0-9]{8,}$/i.test(slashed[2]!.trim()) ? slashed[2]!.trim() : undefined,
      payee: tidy(slashed[3]),
    };
  }

  const incoming = /^(NEFT|RTGS)\b.*?\bFROM\s+(.+?)\s*\(([^)]*)\)\s*(?:\(([A-Z0-9]{8,})\))?/i.exec(text);
  if (incoming) {
    return {
      channel: incoming[1]!.toLowerCase() as 'neft' | 'rtgs',
      reference: incoming[4],
      payee: tidy(incoming[2]),
    };
  }
  if (/^(NEFT|RTGS)\b/i.test(text)) {
    return { channel: /^NEFT/i.test(text) ? 'neft' : 'rtgs' };
  }

  const ach = /^ACH[-\s](?:DR|CR)[-\s]\S+\s+(?:ACH\s+)?(.+?)-\s*(\d{6,})\s*-\s*(\S+)/i.exec(text);
  if (ach) return { channel: 'ach', payee: tidy(ach[1]), reference: ach[2] };
  if (/^ACH\b/i.test(text)) return { channel: 'ach' };

  if (/\bpayment\b/i.test(text) && /#\s*\S+/.test(text)) {
    return { channel: 'card_payment', reference: /#\s*(\S+)/.exec(text)?.[1] };
  }
  if (/^(ATM|NFS)\b|\bcash\s*(wdl|withdrawal)\b/i.test(text)) return { channel: 'atm' };
  if (/^(POS|ECOM|PUR)\b/i.test(text)) return { channel: 'pos' };
  if (/\bInt\.[A-Za-z]{2}\b|\binterest\b/i.test(text)) return { channel: 'interest' };
  if (/\b(gst|fees?|charges?|chgs?|penalty|surcharge)\b/i.test(text)) return { channel: 'charge' };
  if (/^(CHQ|CHEQUE|CLG)\b/i.test(text)) return { channel: 'cheque' };
  if (/^(PPF|NPS|EPF)\b/i.test(text)) return { channel: 'investment' };

  return { channel: 'other' };
}
