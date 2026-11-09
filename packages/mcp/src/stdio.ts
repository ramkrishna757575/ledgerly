// Runs Ledgerly's MCP server over stdio, for an agent on the same machine.
//   node packages/mcp/src/stdio.ts
// It opens the same database as the app. Set LEDGERLY_MCP_SCOPE=read for an
// agent that may look but not suggest. Everything printed to stdout belongs to
// the protocol, so anything else goes to stderr.
import { join, resolve } from 'node:path';
import { openDb } from '@ledgerly/db';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const dbPath = join(process.env.DATA_DIR ?? join(repoRoot, 'data'), 'ledgerly.db');
const scope = process.env.LEDGERLY_MCP_SCOPE === 'read' ? 'read' : 'propose';
const name = process.env.LEDGERLY_MCP_NAME?.trim() || 'stdio agent';

const db = openDb(dbPath);
const server = createMcpServer(db, { id: null, name, scope });

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
await server.connect(new StdioServerTransport());
console.error(`Ledgerly MCP server ready (${scope} access, ${dbPath})`);
