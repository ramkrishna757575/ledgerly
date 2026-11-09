import { useEffect, useState } from 'react';

// Waits for typing to pause before a value is used, so a preview is not
// requested on every keystroke.
export function useDebounced<T>(value: T, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
