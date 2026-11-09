import { formatAmount, parseAmount } from '@ledgerly/core/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, fmtDate } from '../api.ts';

const rupees = (paise: number) => formatAmount(paise).replace(/\.00$/, '');
const KINDS = [['life', 'Life'], ['term', 'Term'], ['health', 'Health'], ['vehicle', 'Vehicle'], ['home', 'Home'], ['other', 'Other']] as const;
const FREQ = [['yearly', 'Yearly'], ['quarterly', 'Quarterly'], ['monthly', 'Monthly']] as const;

function months(n: number) {
  const years = Math.floor(n / 12);
  const rest = n % 12;
  return [years ? `${years} yr` : '', rest ? `${rest} mo` : ''].filter(Boolean).join(' ') || '0';
}

function LoanForm({ onAdd, busy, error }: { onAdd: (input: unknown) => void; busy: boolean; error?: string }) {
  const [f, setF] = useState({ name: '', principal: '', rate: '', years: '', emi: '', first: '' });
  const [problem, setProblem] = useState('');
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const input: Record<string, unknown> = { name: f.name, principal: parseAmount(f.principal), rateBps: Math.round(Number(f.rate) * 100), tenureMonths: Math.round(Number(f.years) * 12), firstEmiDate: f.first };
      if (f.emi.trim()) input.emi = parseAmount(f.emi);
      if (!Number.isFinite(input.rateBps as number) || !Number.isFinite(input.tenureMonths as number) || !f.first) throw new Error();
      setProblem('');
      onAdd(input);
    } catch {
      setProblem('Check the amounts, rate, years and the first instalment date');
    }
  }
  return (
    <form className="card flex flex-col gap-3 p-4" onSubmit={submit}>
      <h2 className="font-medium">Add a loan</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">Name<input className="field" value={f.name} placeholder="Home loan" onChange={(e) => set('name', e.target.value)} /></label>
        <label className="label">Amount borrowed (₹)<input className="field w-36" inputMode="decimal" value={f.principal} onChange={(e) => set('principal', e.target.value)} /></label>
        <label className="label">Interest % a year<input className="field w-24" inputMode="decimal" value={f.rate} onChange={(e) => set('rate', e.target.value)} /></label>
        <label className="label">Years<input className="field w-20" inputMode="decimal" value={f.years} onChange={(e) => set('years', e.target.value)} /></label>
        <label className="label">First instalment<input className="field" type="date" value={f.first} onChange={(e) => set('first', e.target.value)} /></label>
        <label className="label">EMI (₹, optional)<input className="field w-32" inputMode="decimal" value={f.emi} onChange={(e) => set('emi', e.target.value)} /></label>
        <button className="button" disabled={busy || !f.name.trim()}>Add</button>
      </div>
      <p className="text-xs text-muted">Leave the EMI empty to work it out from the other terms. Later instalments fall on the same day each month.</p>
      {(problem || error) && <p className="text-sm text-danger">{problem || error}</p>}
    </form>
  );
}

function PolicyForm({ onAdd, busy, error }: { onAdd: (input: unknown) => void; busy: boolean; error?: string }) {
  const [f, setF] = useState({ name: '', kind: 'term', insurer: '', premium: '', frequency: 'yearly', next: '', sum: '' });
  const [problem, setProblem] = useState('');
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (!f.next) throw new Error();
      const input: Record<string, unknown> = { name: f.name, kind: f.kind, premium: parseAmount(f.premium), frequency: f.frequency, nextDue: f.next };
      if (f.insurer.trim()) input.insurer = f.insurer;
      if (f.sum.trim()) input.sumAssured = parseAmount(f.sum);
      setProblem('');
      onAdd(input);
    } catch {
      setProblem('Check the premium and the next due date');
    }
  }
  return (
    <form className="card flex flex-col gap-3 p-4" onSubmit={submit}>
      <h2 className="font-medium">Add an insurance policy</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="label">Name<input className="field" value={f.name} placeholder="Term plan" onChange={(e) => set('name', e.target.value)} /></label>
        <label className="label">Kind<select className="field" value={f.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="label">Insurer (optional)<input className="field" value={f.insurer} onChange={(e) => set('insurer', e.target.value)} /></label>
        <label className="label">Premium (₹)<input className="field w-32" inputMode="decimal" value={f.premium} onChange={(e) => set('premium', e.target.value)} /></label>
        <label className="label">Paid<select className="field" value={f.frequency} onChange={(e) => set('frequency', e.target.value)}>{FREQ.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="label">Next due<input className="field" type="date" value={f.next} onChange={(e) => set('next', e.target.value)} /></label>
        <label className="label">Cover (₹, optional)<input className="field w-36" inputMode="decimal" value={f.sum} onChange={(e) => set('sum', e.target.value)} /></label>
        <button className="button" disabled={busy || !f.name.trim()}>Add</button>
      </div>
      {(problem || error) && <p className="text-sm text-danger">{problem || error}</p>}
    </form>
  );
}

export function LoansPage() {
  const client = useQueryClient();
  const loans = useQuery({ queryKey: ['loans'], queryFn: api.loans });
  const policies = useQuery({ queryKey: ['policies'], queryFn: api.policies });
  const refresh = () => client.invalidateQueries();
  const addLoan = useMutation({ mutationFn: api.createLoan, onSuccess: refresh });
  const delLoan = useMutation({ mutationFn: api.deleteLoan, onSuccess: refresh });
  const addPolicy = useMutation({ mutationFn: api.createPolicy, onSuccess: refresh });
  const delPolicy = useMutation({ mutationFn: api.deletePolicy, onSuccess: refresh });

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">Loans and insurance</h1>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Loans</h2>
        {loans.isSuccess && loans.data.length === 0 && <p className="card p-6 text-sm text-muted">No loans yet. Add one to see its schedule, what is left, and what paying some off early would save. Instalments are counted in the forecast.</p>}
        <ul className="flex flex-col gap-3">
          {loans.data?.map((l) => (
            <li key={l.id} className="card flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{l.name} <span className="text-sm font-normal text-muted">{(l.rateBps / 100).toFixed(2)}% · {months(l.tenureMonths)}</span></p>
                <p className="text-sm"><span className="font-medium tabular-nums">{rupees(l.outstanding)}</span> <span className="text-muted">still owed of {rupees(l.principal)}</span></p>
              </div>
              <div className="h-2 rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((1 - l.outstanding / l.principal) * 100)} aria-label={`${l.name} repaid`}>
                <div className="h-full rounded-full" style={{ width: `${(1 - l.outstanding / l.principal) * 100}%`, background: 'var(--color-accent)' }} />
              </div>
              <p className="text-sm text-muted">
                EMI {rupees(l.emi)} · {l.instalmentsPaid} paid, {l.instalmentsLeft} left{l.nextDate && ` · next ${fmtDate(l.nextDate)}`}{l.payoffDate && ` · clear by ${fmtDate(l.payoffDate)}`} · {rupees(l.interestLeft)} of interest still to pay
              </p>
              {l.prepay && (
                <p className="rounded-md border border-line p-3 text-sm">
                  Paying {rupees(l.prepay.amount)} off now, keeping the same EMI, would save about <span className="font-medium">{rupees(l.prepay.interestSaved)}</span> of interest and finish <span className="font-medium">{months(l.prepay.monthsSaved)}</span> sooner. That is a guaranteed {l.prepay.guaranteedReturnPercent.toFixed(2)}% a year on the money, with no market risk. Money invested has to beat that after tax to be worth more, and it is not guaranteed to.
                </p>
              )}
              {l.ledgerOwed !== null && Math.abs(l.ledgerOwed - l.outstanding) > 1_000_00 && (
                <p className="text-xs text-muted">The linked account shows {rupees(l.ledgerOwed)} owed, which differs from the schedule's {rupees(l.outstanding)}. Part payments, a rate change or missing statements can explain it.</p>
              )}
              <div><button className="button-quiet" disabled={delLoan.isPending} onClick={() => window.confirm(`Delete ${l.name}?`) && delLoan.mutate(l.id)}>Delete</button></div>
            </li>
          ))}
        </ul>
        <LoanForm busy={addLoan.isPending} error={addLoan.error?.message} onAdd={(input) => addLoan.mutate(input)} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Insurance</h2>
        {policies.isSuccess && policies.data.length === 0 && <p className="card p-6 text-sm text-muted">No policies yet. Add them to be reminded before a premium is due, and to count them in the forecast.</p>}
        {policies.data && policies.data.length > 0 && (
          <>
            <p className="text-sm text-muted">Premiums come to {rupees(policies.data.reduce((s, p) => s + p.premiumPerYear, 0))} a year.</p>
            <ul className="card divide-y divide-line">
              {policies.data.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.name} <span className="font-normal text-muted">{KINDS.find(([k]) => k === p.kind)?.[1]}{p.insurer ? ` · ${p.insurer}` : ''}</span></p>
                    <p className="text-sm text-muted">{rupees(p.premium)} {p.frequency} · next {fmtDate(p.nextDue)} ({p.daysToDue === 0 ? 'today' : `in ${p.daysToDue} days`}){p.sumAssured !== null && ` · cover ${rupees(p.sumAssured)}`}</p>
                  </div>
                  <button className="button-quiet" disabled={delPolicy.isPending} onClick={() => window.confirm(`Delete ${p.name}?`) && delPolicy.mutate(p.id)}>Delete</button>
                </li>
              ))}
            </ul>
          </>
        )}
        <PolicyForm busy={addPolicy.isPending} error={addPolicy.error?.message} onAdd={(input) => addPolicy.mutate(input)} />
      </section>
    </div>
  );
}
