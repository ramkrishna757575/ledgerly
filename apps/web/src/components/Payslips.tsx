import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, isMoneyAccount, type PayslipDraft } from '../api.ts';

type Line = { label: string; kind: PayslipDraft['deductions'][number]['kind']; amount: string };
const KINDS: Record<Line['kind'], string> = { tax: 'Income tax (TDS)', pf: 'Provident fund', professional_tax: 'Professional tax', other: 'Other deduction' };
const rupees = (paise: number | null) => (paise === null ? '' : (paise / 100).toFixed(2));

// Records a month's salary with its deductions split out, so tax and provident fund show up.
export function Payslips() {
  const client = useQueryClient();
  const slips = useQuery({ queryKey: ['payslips'], queryFn: api.payslips });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [month, setMonth] = useState('');
  const [employer, setEmployer] = useState('');
  const [accountId, setAccountId] = useState(0);
  const [gross, setGross] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [shown, setShown] = useState(false);

  const read = useMutation({
    mutationFn: () => api.readPayslip(file!, password || undefined),
    onSuccess: (d) => {
      setNotes(d.notes);
      setMonth(d.month ?? '');
      setGross(rupees(d.gross));
      setLines(d.deductions.map((x) => ({ label: x.label, kind: x.kind, amount: rupees(x.amount) })));
      setShown(true);
    },
  });
  const save = useMutation({
    mutationFn: () => api.savePayslip({ month, employer, accountId, gross: parseAmount(gross), deductions: lines.filter((l) => l.amount).map((l) => ({ label: l.label || KINDS[l.kind], kind: l.kind, amount: parseAmount(l.amount) })) }),
    onSuccess: () => { setOpen(false); setShown(false); setFile(null); setLines([]); client.invalidateQueries(); },
  });
  const remove = useMutation({ mutationFn: api.deletePayslip, onSuccess: () => client.invalidateQueries() });

  const banks = (accounts.data ?? []).filter((a) => isMoneyAccount(a) && a.type === 'asset');
  const taken = lines.reduce((s, l) => s + (Number.isFinite(Number(l.amount)) ? Math.round(Number(l.amount) * 100) : 0), 0);
  const grossPaise = Number.isFinite(Number(gross)) && gross !== '' ? Math.round(Number(gross) * 100) : 0;
  const net = grossPaise - taken;

  return (
    <section className="card flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">Payslips</h2>
          <p className="mt-1 text-sm text-muted">Record your salary with its deductions split out, so your income is the full pay and tax and provident fund show up. The bank statement that shows the credit later takes the entry over, so the salary is not counted twice. The PDF is read for its numbers and not kept.</p>
        </div>
        {!open && <button className="button-quiet" onClick={() => setOpen(true)}>Add a payslip</button>}
      </header>

      {open && !shown && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); read.mutate(); }}>
          <label className="label">Payslip PDF<input className="field" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <label className="label">Password (if locked)<input className="field" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="button" disabled={!file || read.isPending}>{read.isPending ? 'Reading…' : 'Read it'}</button>
          <button type="button" className="button-quiet" onClick={() => setShown(true)}>Type it in instead</button>
          <button type="button" className="button-quiet" onClick={() => setOpen(false)}>Cancel</button>
        </form>
      )}

      {open && shown && (
        <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
          {notes.length > 0 && <p className="rounded-md border border-line p-3 text-sm">Check these: {notes.join('. ')}. Fill them in below.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="label">Month<input className="field" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
            <label className="label">Employer<input className="field" value={employer} onChange={(e) => setEmployer(e.target.value)} /></label>
            <label className="label">Paid into<select className="field" value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}><option value={0}>Choose a bank account</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="label">Gross pay<input className="field" inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} /></label>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Deductions</p>
            {lines.map((l, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select className="field w-44" aria-label="Kind" value={l.kind} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kind: e.target.value as Line['kind'] } : x)))}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <input className="field w-48" aria-label="Label" value={l.label} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input className="field w-32" aria-label="Amount" inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                <button type="button" className="button-quiet" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <div><button type="button" className="button-quiet" onClick={() => setLines([...lines, { label: '', kind: 'tax', amount: '' }])}>Add a deduction</button></div>
          </div>
          <p className="text-sm">Reaches the bank: <span className="font-medium">{formatAmount(net)}</span> <span className="text-muted">(compare with the net pay on the payslip)</span></p>
          <div className="flex gap-2">
            <button className="button" disabled={save.isPending || !month || !employer.trim() || !accountId || grossPaise <= 0 || net <= 0}>Add to my books</button>
            <button type="button" className="button-quiet" onClick={() => { setOpen(false); setShown(false); }}>Cancel</button>
          </div>
        </form>
      )}

      {(read.error || save.error || remove.error) && <p className="text-sm text-danger">{(read.error ?? save.error ?? remove.error)!.message}</p>}
      {(slips.data?.length ?? 0) > 0 && (
        <ul className="divide-y divide-line text-sm">
          {slips.data!.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{p.month} · {p.employer} <span className="text-muted">· gross {formatAmount(p.gross)}, net {formatAmount(p.net)}</span></span>
              <button className="button-quiet" disabled={remove.isPending} onClick={() => window.confirm('Remove this payslip and its entry in your books?') && remove.mutate(p.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
