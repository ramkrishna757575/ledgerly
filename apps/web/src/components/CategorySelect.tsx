import { isMoneyAccount, type Account } from '../api.ts';

// Spending and income categories, plus the other accounts for a transfer.
export function CategorySelect({
  value,
  accounts,
  ownAccountId,
  disabled,
  allowEmpty = true,
  onChange,
}: {
  value: number | null;
  accounts: Account[];
  // The account a transaction already belongs to is never the other side of it.
  ownAccountId: number | null;
  disabled: boolean;
  allowEmpty?: boolean;
  onChange: (categoryId: number | null) => void;
}) {
  const usable = accounts.filter((a) => !a.isArchived && a.type !== 'equity' && a.id !== ownAccountId);
  const group = (label: string, items: Account[]) =>
    items.length > 0 && (
      <optgroup label={label}>
        {items.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </optgroup>
    );

  return (
    <select
      className="field"
      aria-label="Category"
      disabled={disabled}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      {allowEmpty && <option value="">Not set</option>}
      {group('Spending', usable.filter((a) => a.type === 'expense'))}
      {group('Income', usable.filter((a) => a.type === 'income'))}
      {group('Transfer to account', usable.filter(isMoneyAccount))}
    </select>
  );
}
