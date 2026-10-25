import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

function config(env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {default:c}=await import("./next.config.ts"); console.log(JSON.stringify({rewrites:await c.rewrites(),headers:await c.headers(),output:c.output}));'],
    { cwd: process.cwd(), env: { ...process.env, VERCEL: '', API_INTERNAL_URL: '', ...env }, encoding: 'utf8' });
}

test('local API routing retains relative paths and standalone Docker output', () => {
  const result = config({});
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.output, 'standalone');
  assert.deepEqual(actual.rewrites, [{source:'/api/:path*',destination:'http://127.0.0.1:8000/api/:path*'}]);
});

test('Vercel routes directly to the configured origin without shared API caching', () => {
  const result = config({ VERCEL:'1', API_INTERNAL_URL:'https://api.example.com/' });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.output, undefined);
  assert.equal(actual.rewrites[0].destination, 'https://api.example.com/api/:path*');
  const headers = actual.headers.find(rule => rule.source === '/api/:path*').headers;
  assert.ok(headers.some(header => header.key === 'x-vercel-enable-rewrite-caching' && header.value === '0'));
  assert.ok(headers.some(header => header.key === 'Cache-Control' && header.value.includes('no-store')));
});

test('Vercel rejects missing, insecure, credential-bearing and path-bearing origins', () => {
  for (const origin of ['', 'http://api.example.com', 'https://user:secret@api.example.com', 'https://api.example.com/api', 'https://api.example.com?token=secret', 'ftp://api.example.com']) {
    const result = config({ VERCEL:'1', API_INTERNAL_URL:origin });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_INTERNAL_URL/);
    assert.ok(!result.stderr.includes('user:secret'));
  }
});
