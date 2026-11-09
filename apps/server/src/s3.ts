import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

// Uploading a file to anything that speaks the S3 protocol (Amazon S3, Backblaze B2,
// Cloudflare R2, MinIO), signed with AWS Signature Version 4, with no library.
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const encode = (segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export type Signing = { method: string; url: URL; region: string; service: string; accessKey: string; secretKey: string; payloadHash: string; headers?: Record<string, string>; now?: Date };

// The headers to send: the ones passed in, x-amz-date, host, and Authorization.
export function signRequest(input: Signing) {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: input.url.host, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const path = input.url.pathname.split('/').map((s) => encode(decodeURIComponent(s))).join('/') || '/';
  const query = [...input.url.searchParams.entries()].map(([k, v]) => [encode(k), encode(v)]).sort((a, b) => (a[0]! === b[0]! ? a[1]!.localeCompare(b[1]!) : a[0]!.localeCompare(b[0]!))).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [input.method, path, query, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

export type S3Target = { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string };

function sha256OfFile(path: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// Puts one file at `key` in the bucket (path-style addresses, which every provider accepts).
export async function putFile(target: S3Target, key: string, path: string) {
  const url = new URL(`${target.endpoint.replace(/\/+$/, '')}/${encode(target.bucket)}/${key.split('/').map(encode).join('/')}`);
  const { size } = await stat(path);
  const payloadHash = await sha256OfFile(path);
  const headers = signRequest({ method: 'PUT', url, region: target.region, service: 's3', accessKey: target.accessKey, secretKey: target.secretKey, payloadHash, headers: { 'x-amz-content-sha256': payloadHash, 'content-length': String(size) } });
  const transport = url.protocol === 'http:' ? http : https;
  await new Promise<void>((resolve, reject) => {
    const request = transport.request(url, { method: 'PUT', headers, timeout: 10 * 60_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (c: Buffer) => chunks.push(c));
      response.on('end', () => {
        if (response.statusCode && response.statusCode < 300) resolve();
        else reject(new Error(`The storage service answered ${response.statusCode}: ${Buffer.concat(chunks).toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('The storage service took too long')));
    request.on('error', reject);
    createReadStream(path).on('error', reject).pipe(request);
  });
}
