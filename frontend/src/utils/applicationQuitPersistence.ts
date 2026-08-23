export type ApplicationQuitPersistenceTasks = {
  captureWindowState: () => Promise<void>;
  flushDrafts: () => void;
  flushAppState: () => Promise<void>;
};

export const prepareApplicationQuitPersistence = async ({
  captureWindowState,
  flushDrafts,
  flushAppState,
}: ApplicationQuitPersistenceTasks): Promise<void> => {
  await captureWindowState();
  flushDrafts();
  await flushAppState();
};
