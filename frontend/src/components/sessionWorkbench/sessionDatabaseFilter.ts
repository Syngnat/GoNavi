import type { DatabaseSession } from './sessionWorkbenchModel';

/**
 * Databases the picker offers, sorted. The server's catalog is preferred: a
 * list derived from the rows on screen changes with every refresh, so a
 * moment of quiet would hide the database the user is looking for. The row
 * databases are a fallback for engines whose catalog is unavailable or empty.
 */
export const sessionDatabaseOptions = (
  sessions: readonly DatabaseSession[],
  serverDatabases: readonly string[] = [],
): string[] => {
  const names = new Set<string>();
  const add = (value: unknown): void => {
    const name = String(value ?? '').trim();
    if (name) names.add(name);
  };
  serverDatabases.forEach(add);
  // Rows can carry a database the catalog call did not report (a session in a
  // database this user cannot list), so the rows still contribute.
  sessions.forEach((session) => add(session.databaseOrTenant));
  return Array.from(names)
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
};

export const filterSessionsByDatabase = (
  sessions: DatabaseSession[],
  databaseName: string,
): DatabaseSession[] => {
  const name = databaseName.trim();
  if (!name) return sessions;
  return sessions.filter((session) => String(session.databaseOrTenant ?? '').trim() === name);
};
