export type ThemeChoice = 'auto' | 'light' | 'dark';

const KEY = 'ledgerly-theme';

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

// Storage can be blocked or empty, so the page must work without it.
export function getTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

export function setTheme(choice: ThemeChoice) {
  apply(choice);
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // The choice still applies until the page is closed.
  }
}
