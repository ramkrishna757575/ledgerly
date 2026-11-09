import { useState, type ReactNode } from 'react';
import { getTheme, setTheme, type ThemeChoice } from '../theme.ts';

const icon = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const OPTIONS: { id: ThemeChoice; label: string; hint: string; icon: ReactNode }[] = [
  // A screen with a half-filled disc: follows the device.
  { id: 'auto', label: 'Auto', hint: 'Match your device', icon: icon(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /><path d="M12 7v6a3 3 0 0 0 0-6z" fill="currentColor" /></>) },
  { id: 'light', label: 'Light', hint: 'Always light', icon: icon(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>) },
  { id: 'dark', label: 'Dark', hint: 'Always dark', icon: icon(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />) },
];

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(getTheme);

  return (
    <div role="group" aria-label="Theme" className="flex overflow-hidden rounded-md border border-line text-xs">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          title={option.hint}
          aria-label={option.label}
          aria-pressed={choice === option.id}
          onClick={() => {
            setTheme(option.id);
            setChoice(option.id);
          }}
          className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-2 ${choice === option.id ? 'bg-surface font-medium text-ink' : 'text-muted hover:text-ink'}`}
        >
          {option.icon}
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
