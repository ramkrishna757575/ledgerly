import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './index.ts';

describe('the record of which migrations ran', () => {
  it('is written back if it was emptied while the tables are still there', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledgerly-db-')), 'ledgerly.db');
    const first = openDb(path);
    first.$client.prepare('DELETE FROM __drizzle_migrations').run();
    first.close();

    const again = openDb(path);
    const rows = again.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);
    again.close();
  });
});
