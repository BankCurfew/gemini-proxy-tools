// node --test ig-bridge/test/sign.test.mjs — T2906 S2-B signed commands (temp key file only, never the vault)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, sign, verify, loadKey, MAX_SKEW_MS } from '../sign.mjs';

const KEY = crypto.randomBytes(32);
const NOW = 1_791_700_000_000;
const cmd = { id: 'job-123', action: 'share', confirm: 'job-120', files: ['a', 'b'], meta: { z: 1, a: [2, { y: 3, b: 4 }] } };

test('canonical is key-order independent at every level', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } }), canonical({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 }));
});

test('a signed command verifies once; a repeat is a replay', () => {
  const seen = new Map();
  const s = sign(KEY, cmd, NOW);
  assert.equal(s.ts, NOW);
  assert.equal(verify(KEY, s, seen, NOW + 1000), null);
  assert.equal(verify(KEY, s, seen, NOW + 2000), 'replay');
});

test('refusals: unsigned, tampered body, tampered action, stale, future, wrong key, no key, junk', () => {
  const s = sign(KEY, cmd, NOW);
  const v = (c, key = KEY, now = NOW) => verify(key, c, new Map(), now);
  assert.equal(v({ ...cmd, ts: NOW }), 'unsigned');
  assert.equal(v({ ...s, confirm: 'job-999' }), 'bad_sig');
  assert.equal(v({ ...s, action: 'edit_caption' }), 'bad_sig');
  assert.equal(v({ ...s, files: ['a', 'b', 'c'] }), 'bad_sig');
  assert.equal(v(s, KEY, NOW + MAX_SKEW_MS + 1), 'stale');
  assert.equal(v(s, KEY, NOW - MAX_SKEW_MS - 1), 'stale');
  assert.equal(v(s, crypto.randomBytes(32)), 'bad_sig');
  assert.equal(v(s, null), 'no_key');
  assert.equal(v({ ...s, ts: 'now' }), 'no_ts');
  assert.equal(v([s]), 'not_an_object');
  assert.equal(v({ ...s, sig: 'abc' }), 'unsigned');
});

test('re-signing replaces an old ts/sig instead of hashing it', () => {
  const s1 = sign(KEY, cmd, NOW), s2 = sign(KEY, s1, NOW + 5);
  assert.equal(verify(KEY, s2, new Map(), NOW + 10), null);
});

test('CLI (what ig-post.sh runs): key from a file, never argv; output verifies; missing key → exit 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-sign-'));
  const file = path.join(dir, 'k.env');
  fs.writeFileSync(file, `IG_BRIDGE_HMAC_KEY=${KEY.toString('hex')}\n`, { mode: 0o600 });
  const out = execFileSync('node', [new URL('../sign.mjs', import.meta.url).pathname, JSON.stringify(cmd)], { env: { ...process.env, IG_BRIDGE_HMAC_FILE: file } }).toString();
  const signed = JSON.parse(out);
  assert.equal(verify(loadKey(file), signed, new Map(), signed.ts), null);
  assert.throws(() => execFileSync('node', [new URL('../sign.mjs', import.meta.url).pathname, '{}'], { env: { ...process.env, IG_BRIDGE_HMAC_FILE: path.join(dir, 'none') }, stdio: 'pipe' }), (e) => e.status === 2);
  fs.writeFileSync(file, 'IG_BRIDGE_HMAC_KEY=short\n');
  assert.throws(() => loadKey(file), /64 hex/);
});
