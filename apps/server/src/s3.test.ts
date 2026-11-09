import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { putFile, signRequest } from './s3.ts';

describe('signing a request for an S3 service', () => {
  // The published example from AWS's Signature Version 4 test suite ("get-vanilla").
  it('gives the signature AWS documents for its own example', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      region: 'us-east-1',
      service: 'service',
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('uploading a file', () => {
  it('sends the file with a signature the service can check, to the right place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledgerly-s3-'));
    const file = join(dir, 'backup.tar.gz.enc');
    writeFileSync(file, 'sealed backup bytes');
    const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string } = { headers: {}, body: '' };
    const server = http.createServer((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      req.on('data', (c) => (seen.body += c));
      req.on('end', () => res.writeHead(200).end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      await putFile({ endpoint: `http://127.0.0.1:${port}`, region: 'auto', bucket: 'my-backups', accessKey: 'AK', secretKey: 'SK', prefix: '' }, 'ledgerly/asha/backup.tar.gz.enc', file);
    } finally {
      server.close();
    }
    expect(seen.method).toBe('PUT');
    expect(seen.url).toBe('/my-backups/ledgerly/asha/backup.tar.gz.enc');
    expect(seen.body).toBe('sealed backup bytes');
    expect(seen.headers['x-amz-content-sha256']).toBe(createHash('sha256').update('sealed backup bytes').digest('hex'));
    expect(String(seen.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-length;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it('says what the service answered when it refuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledgerly-s3-'));
    const file = join(dir, 'b.enc');
    writeFileSync(file, 'x');
    const server = http.createServer((_req, res) => res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      await expect(putFile({ endpoint: `http://127.0.0.1:${port}`, region: 'auto', bucket: 'b', accessKey: 'AK', secretKey: 'SK', prefix: '' }, 'k', file)).rejects.toThrow(/403.*AccessDenied/);
    } finally {
      server.close();
    }
  });
});
