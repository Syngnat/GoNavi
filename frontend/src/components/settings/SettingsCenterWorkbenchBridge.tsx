import React, { useLayoutEffect, useSyncExternalStore } from 'react';

type SettingsCenterWorkbenchRenderer = (() => React.ReactNode) | null;

let renderer: SettingsCenterWorkbenchRenderer = null;
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((listener) => listener());
};

export const setSettingsCenterWorkbenchRenderer = (
  next: SettingsCenterWorkbenchRenderer,
): void => {
  renderer = next;
  emit();
};

const subscribe = (onStoreChange: () => void): (() => void) => {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
};

const getSnapshot = (): SettingsCenterWorkbenchRenderer => renderer;

export const useSettingsCenterWorkbenchRenderer = (): SettingsCenterWorkbenchRenderer => (
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
);

interface SettingsCenterWorkbenchRegistrarProps {
  children: React.ReactNode;
}

/** App mounts this while the settings-center tab exists; host reads via the bridge. */
export const SettingsCenterWorkbenchRegistrar: React.FC<SettingsCenterWorkbenchRegistrarProps> = ({
  children,
}) => {
  const childrenRef = React.useRef(children);
  childrenRef.current = children;

  useLayoutEffect(() => {
    setSettingsCenterWorkbenchRenderer(() => childrenRef.current);
    return () => {
      setSettingsCenterWorkbenchRenderer(null);
    };
  }, []);

  useLayoutEffect(() => {
    setSettingsCenterWorkbenchRenderer(() => childrenRef.current);
  });

  return null;
};
