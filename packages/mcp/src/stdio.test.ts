import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const entry = join(import.meta.dirname, 'stdio.ts');
let dir: string;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function launch(extra: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'ledgerly-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH ?? '', DATA_DIR: dir, ...extra },
    stderr: 'ignore',
  });
  const problems: Error[] = [];
  client = new Client({ name: 'test', version: '1.0.0' });
  client.onerror = (error) => problems.push(error);
  await client.connect(transport);
  return { client, problems };
}

describe('stdio server', () => {
  it('runs as a separate process and keeps stdout for the protocol alone', async () => {
    const { client: connected, problems } = await launch();
    const tools = (await connected.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['get_accounts', 'propose_rule']));

    const result = await connected.callTool({ name: 'get_accounts', arguments: {} });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).accounts).toEqual([]);
    // Anything else written to stdout would have shown up here as a parse error.
    expect(problems).toEqual([]);
  }, 30_000);

  it('can be limited to reading', async () => {
    const { client: connected } = await launch({ LEDGERLY_MCP_SCOPE: 'read' });
    const tools = (await connected.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('search_transactions');
    expect(tools.some((name) => name.startsWith('propose_'))).toBe(false);
  }, 30_000);
});
