// Usage: pnpm restore <backup.tar.gz>   (stop the server first; an encrypted backup needs BACKUP_PASSPHRASE set)
import { loadConfig } from '../config.ts';
import { restoreBackup } from '../restore.ts';

const file = process.argv[2];
if (!file) {
  console.error('Usage: pnpm restore <backup.tar.gz>');
  process.exit(1);
}
const { dataDir, backupPassphrase } = loadConfig();
const { restored, kept } = await restoreBackup(file, dataDir, 'ledgerly.db', backupPassphrase);
console.log(`Restored ${restored}`);
for (const path of kept) console.log(`Previous data kept at ${path}`);
