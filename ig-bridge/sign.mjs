// T2906 S2-B (security, HIGH): ig-agent commands are signed. The broker (claude/browser/#) was open to anonymous
// clients, so a command's presence on the topic proves nothing. Every command now carries
//   ts  = sender clock, ms since epoch (±120 s accepted)
//   sig = hex HMAC-SHA256(key, canonical(cmd without sig))
// canonical = JSON with object keys sorted at every level, so sender and agent hash the same bytes.
// The key lives only in the vault (~/.oracle/security/ig-bridge-hmac.env, 0600), never on the broker; a reader of the
// open response topic learns job ids but cannot sign a share/edit_caption with them.
// Replay: the agent remembers id|ts|sig for 10 min and refuses a repeat.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_SKEW_MS = 120_000;
export const REPLAY_MS = 600_000;
export const KEY_FILE = process.env.IG_BRIDGE_HMAC_FILE || path.join(os.homedir(), '.oracle', 'security', 'ig-bridge-hmac.env');

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

export function loadKey(file = KEY_FILE) {
  const line = fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith('IG_BRIDGE_HMAC_KEY='));
  const key = line?.slice('IG_BRIDGE_HMAC_KEY='.length).trim();
  if (!key || !/^[0-9a-f]{64}$/.test(key)) throw new Error(`IG_BRIDGE_HMAC_KEY missing or not 64 hex in ${file}`);
  return Buffer.from(key, 'hex');
}

const mac = (key, cmd) => { const { sig, ...rest } = cmd; return crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex'); };

export function sign(key, cmd, now = Date.now()) {
  const out = { ...cmd, ts: now };
  delete out.sig;
  return { ...out, sig: mac(key, out) };
}

/** → null when the command may run, else the refusal reason. `seen` is the agent's replay memory (Map key → expiry). */
export function verify(key, cmd, seen, now = Date.now()) {
  if (!key) return 'no_key';
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return 'not_an_object';
  if (typeof cmd.sig !== 'string' || !/^[0-9a-f]{64}$/.test(cmd.sig)) return 'unsigned';
  if (typeof cmd.ts !== 'number' || !Number.isFinite(cmd.ts)) return 'no_ts';
  if (Math.abs(now - cmd.ts) > MAX_SKEW_MS) return 'stale';
  const want = Buffer.from(mac(key, cmd), 'hex'), got = Buffer.from(cmd.sig, 'hex');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return 'bad_sig';
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  const k = `${cmd.id}|${cmd.ts}|${cmd.sig}`;
  if (seen.has(k)) return 'replay';
  seen.set(k, now + REPLAY_MS);
  return null;
}

// CLI for ig-post.sh: `node sign.mjs '<json>'` → prints the signed JSON (key read from the vault, never from argv)
if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(JSON.stringify(sign(loadKey(), JSON.parse(process.argv[2] ?? '')))); }
  catch (e) { console.error(`sign.mjs: ${e.message}\nfix: ask dev/security for ~/.oracle/security/ig-bridge-hmac.env (T2906)`); process.exit(2); }
}
