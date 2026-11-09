import type { Db } from '@ledgerly/db';
import { ASSET_CLASSES, type AssetClass } from '@ledgerly/db';
import { ASSET_CLASS_OF, listAssets } from '../assets.ts';
import { getHoldings } from '../investments/portfolio.ts';
import { DomainError } from '../errors.ts';
import { getSetting, setSetting } from '../settings.ts';

const TARGET_KEY = 'analysis.target';
export type Target = Partial<Record<AssetClass, number>>;

export function getTarget(db: Db): Target | null {
  const raw = getSetting(db, TARGET_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Target;
  } catch {
    return null;
  }
}

// Percentages by asset class that must add up to 100, or null to clear it.
export function setTarget(db: Db, target: Target | null) {
  if (target === null) {
    setSetting(db, TARGET_KEY, '');
    return;
  }
  const entries = Object.entries(target).filter(([, value]) => value !== undefined);
  for (const [key, value] of entries) {
    if (!(ASSET_CLASSES as readonly string[]).includes(key)) throw new DomainError('invalid', `Unknown asset class: ${key}`);
    if (!Number.isFinite(value) || value! < 0 || value! > 100) throw new DomainError('invalid', 'Each share must be between 0 and 100');
  }
  const total = entries.reduce((sum, [, value]) => sum + value!, 0);
  if (Math.abs(total - 100) > 0.01) throw new DomainError('invalid', `The shares must add up to 100, they add up to ${total}`);
  setSetting(db, TARGET_KEY, JSON.stringify(Object.fromEntries(entries)));
}

const CONCENTRATION = 0.25;
const STALE_DAYS = 45;

export type Observation = { key: string; level: 'info' | 'attention'; text: string };

// Plain facts about the portfolio, found by code. A fund's share, how far each
// class is from the target, prices that have gone stale, funds that look like
// regular plans. Nothing here is a recommendation to buy or sell.
export function portfolioReview(db: Db, input: { today?: string } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const { holdings, summary, allocation: fundAllocation } = getHoldings(db);

  // Deposits, PPF, EPF, NPS, stocks and gold count toward the mix too, so it
  // shows where all of your investments sit and not only your mutual funds.
  const assets = listAssets(db, { today }).items.filter((a) => a.value > 0 && ASSET_CLASS_OF[a.kind] !== null);
  if (holdings.length === 0 && assets.length === 0) return { hasPortfolio: false as const };

  const mix = new Map<AssetClass, { value: number; funds: number }>();
  for (const a of fundAllocation) mix.set(a.assetClass, { value: a.value, funds: a.funds });
  for (const asset of assets) {
    const cls = ASSET_CLASS_OF[asset.kind]! as AssetClass;
    const entry = mix.get(cls) ?? { value: 0, funds: 0 };
    mix.set(cls, { value: entry.value + asset.value, funds: entry.funds + 1 });
  }
  const otherAssetsValue = assets.reduce((sum, a) => sum + a.value, 0);
  const totalValue = summary.value + otherAssetsValue;
  const allocation = [...mix.entries()].map(([assetClass, { value, funds }]) => ({ assetClass, value, funds, share: totalValue > 0 ? value / totalValue : 0 }));

  const target = getTarget(db);
  const classes = [...new Set([...allocation.map((a) => a.assetClass), ...Object.keys(target ?? {})])] as AssetClass[];
  const drift = target
    ? classes.map((assetClass) => {
        const actual = allocation.find((a) => a.assetClass === assetClass)?.share ?? 0;
        const wanted = (target[assetClass] ?? 0) / 100;
        return { assetClass, actual, target: wanted, difference: actual - wanted, amount: Math.round((actual - wanted) * totalValue) };
      })
    : null;

  const observations: Observation[] = [];
  for (const holding of holdings) {
    const share = summary.value > 0 ? holding.value / summary.value : 0;
    if (holdings.length > 1 && share > CONCENTRATION) {
      observations.push({ key: `concentration:${holding.id}`, level: 'info', text: `${holding.name} is ${Math.round(share * 100)}% of the portfolio.` });
    }
  }
  const unclassified = allocation.find((a) => a.assetClass === 'other');
  if (unclassified && unclassified.share >= 0.1) {
    observations.push({ key: 'unclassified', level: 'info', text: `${Math.round(unclassified.share * 100)}% of the portfolio (${unclassified.funds} holding${unclassified.funds === 1 ? '' : 's'}) could not be classified, so allocation figures are incomplete.` });
  }
  if (summary.asOf) {
    const age = Math.round((Date.parse(today) - Date.parse(summary.asOf)) / 86_400_000);
    if (age > STALE_DAYS) observations.push({ key: 'stale', level: 'attention', text: `Values are ${age} days old. Update prices or import a newer statement.` });
  }
  const regular = holdings.filter((h) => /\bregular\b/i.test(h.name) && !/\bdirect\b/i.test(h.name));
  if (regular.length > 0) {
    observations.push({ key: 'regular_plans', level: 'info', text: `${regular.length} fund${regular.length === 1 ? ' appears' : 's appear'} to be Regular plans, going by the name. Regular plans carry a higher annual cost than the Direct plan of the same fund.` });
  }

  return {
    hasPortfolio: true as const,
    today,
    value: summary.value,
    // Funds plus the other assets that are part of the mix.
    totalValue,
    otherAssetsValue,
    otherAssets: assets.map((a) => ({ kind: a.kind, value: a.value })),
    invested: summary.invested,
    gainRatio: summary.gainRatio,
    asOf: summary.asOf,
    allocation: allocation.map((a) => ({ assetClass: a.assetClass, share: a.share, value: a.value, funds: a.funds })),
    target,
    drift,
    holdings: holdings.map((h) => ({
      name: h.name,
      assetClass: h.assetClass,
      value: h.value,
      share: summary.value > 0 ? h.value / summary.value : 0,
      gainRatio: h.gainRatio,
      xirr: h.xirrBps === null ? null : h.xirrBps / 10_000,
      xirrSource: h.xirrSource,
    })),
    observations,
  };
}

export type PortfolioReview = ReturnType<typeof portfolioReview>;
