import { SqliteEventStore } from '@memnox/core';

/**
 * Seven commands read the ledger and every one of them has to close it. Opening it
 * here means the `finally` is written once rather than remembered seven times.
 */
export async function withEvents<T>(
  home: string,
  read: (store: SqliteEventStore) => Promise<T>,
): Promise<T> {
  const store = SqliteEventStore.forHome(home);
  try {
    return await read(store);
  } finally {
    store.close();
  }
}
