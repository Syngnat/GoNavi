import { useEffect, useState } from 'react';

export const useDismissibleError = (value: string) => {
  const [dismissedValue, setDismissedValue] = useState('');

  useEffect(() => {
    if (!value) setDismissedValue('');
  }, [value]);

  return {
    visible: Boolean(value) && dismissedValue !== value,
    dismiss: () => setDismissedValue(value),
    resetDismissal: () => setDismissedValue(''),
  };
};
