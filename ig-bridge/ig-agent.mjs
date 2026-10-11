#!/usr/bin/env node
// ig-agent.mjs — MQTT-driven Instagram web poster (T2445 Phase 1). Runs under pm2 as "ig-bridge".
//
// MQTT (mosquitto on localhost:1883, same broker as gemini-proxy):
//   claude/browser/ig/command   ← {"id","action",...}            one JSON per message
//   claude/browser/ig/response  → {"id","action","ok","state",...} one per command
//   claude/browser/ig/state     → current job state (retained)
//
// Two-step by design: post_* only PREPARES (stops before Share, screenshot + checks). Nothing is posted until a
// second command {"action":"share","confirm":"<prepare id>"} names that exact prepared job.
// Env: IG_BRIDGE_ALLOW=user1,user2 (accounts this agent may act on — empty = refuse everything).
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateCommand, ratioOk, classifyReadback, MEDIA_TYPE } from './lib.mjs';
import * as web from './ig-web.mjs';
import * as graph from './graph.mjs';
import * as mbs from './mbs-web.mjs';
import { loadKey, verify } from './sign.mjs';

// Production account (default context) reads back through Graph (bob/แบงค์ 1/10); isolated test accounts via the web API.
const viaGraph = (user) => web.usesDefaultContext(user) && graph.graphAvailable();

const HOME = os.homedir();
const DATA = process.env.IG_BRIDGE_DATA || path.join(HOME, '.oracle', 'ig-bridge');
const SHOTS = process.env.IG_BRIDGE_SHOTS || path.join(HOME, '.maw', 'inbox', 'ig-bridge');
const STATE_FILE = path.join(DATA, 'state.json');
const LOG_FILE = path.join(DATA, 'actions.jsonl');
// claude/browser/ig/*: the broker ACL lets anonymous clients use claude/browser/# only (claude/ig/* is silently dropped);
// the gemini extension listens on exact topics there and does not answer claude/browser/ig/command (probed 1/10).
const TP = process.env.IG_BRIDGE_TOPIC || 'claude/browser/ig';
const T = { cmd: `${TP}/command`, res: `${TP}/response`, state: `${TP}/state` };
const ALLOW = (process.env.IG_BRIDGE_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });

const now = () => new Date().toISOString();
const log = rec => fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: now(), ...rec }) + '\n');
const pub = (topic, obj, retain = false) => new Promise(res => {
  const p = spawn('mosquitto_pub', ['-h', 'localhost', '-t', topic, ...(retain ? ['-r'] : []), '-m', JSON.stringify(obj)], { stdio: 'ignore' });
  p.on('close', res);
});

let state = { phase: 'IDLE' };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
async function setState(s) {
  state = { ...s, updated: now() };
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  await pub(T.state, state, true);
}

const winToWsl = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
async function shot(pg, id, step) {
  const f = path.join(SHOTS, `${id}-${step}.png`);
  await pg.screenshot({ path: f }).catch(() => {});
  return f;
}

// ---------- actions ----------
async function prepare(cmd) {
  if (['PREPARING', 'READY', 'SHARING'].includes(state.phase))
    return { ok: false, error: `busy: job ${state.id} is ${state.phase} — share or abort it first` };
  if (cmd.action === 'post_story') return prepareStory(cmd);
  if (cmd.action === 'post_fb_story') return prepareFbStory(cmd);
  const reel = cmd.action === 'post_reel';
  const files = reel ? [cmd.file] : cmd.files;
  const missing = files.filter(f => !fs.existsSync(winToWsl(f)));
  if (missing.length) return { ok: false, error: `files not found (Windows paths expected): ${missing.slice(0, 3).join(', ')}` };
  const ratio = reel ? '9:16' : cmd.ratio;
  const job = { id: cmd.id, action: cmd.action, expectUser: cmd.expectUser, ratio, files,
    expected: { mediaType: reel ? MEDIA_TYPE.video : MEDIA_TYPE.carousel, count: reel ? null : files.length, caption: cmd.caption } };
  await setState({ phase: 'PREPARING', ...job });

  const b = await web.connect(); let pg;
  const fail = async (step, why) => {
    const s = pg ? await shot(pg, cmd.id, `fail-${step}`) : null;
    await web.closeOwn(pg, cmd.expectUser);
    await setState({ phase: 'FAILED', ...job, step, why, screenshot: s });
    return { ok: false, error: `${step}: ${why}`, screenshot: s };
  };
  try {
    pg = await web.openOwnTab(b, cmd.expectUser);
    const who = await web.whoami(pg);
    if (!who || who.toLowerCase() !== cmd.expectUser.toLowerCase()) return await fail('account', `logged in as ${who || 'unknown'}, expected ${cmd.expectUser} — nothing posted`);
    let e = await web.openCreatePost(pg); if (e) return await fail('create', e);
    e = await web.upload(pg, files); if (e) return await fail('upload', e);
    e = await web.setCrop(pg, ratio); if (e) return await fail('crop', e);
    const crop = await web.measureCrop(pg);
    const r = ratioOk(crop.ratio, ratio);
    if (!r.ok) return await fail('crop', `${r.why} [${crop.how}]`);
    const checks = { user: who, crop: { ...r, how: crop.how } };
    if (!reel) {
      const m = await web.countMedia(pg);
      checks.media = { ...m, expected: files.length };
      if (m.count !== files.length) return await fail('count', `media count ${m.count} ≠ ${files.length} [${m.how}]`);
    }
    if (!await web.next(pg)) return await fail('next', 'Next (crop→edit) not found');
    if (!await web.next(pg)) return await fail('next', 'Next (edit→caption) not found');
    const typed = await web.typeCaption(pg, cmd.caption);
    checks.caption = typed;
    if (!typed.ok) return await fail('caption', `caption box text ≠ caption (${typed.why || typed.shownChars + ' chars shown'})`);
    const s = await shot(pg, cmd.id, 'ready');
    await setState({ phase: 'READY', ...job, checks, screenshot: s });
    return { ok: true, state: 'READY', checks, screenshot: s, next: `share needs {"action":"share","confirm":"${cmd.id}"}` };
  } catch (err) {
    return await fail('exception', String(err?.message || err));
  } finally { b.disconnect(); }
}

async function readbackAndFix(pg, job, sinceSec) {
  const g = viaGraph(job.expectUser);
  const find = async () => {
    if (!g) return web.findNewPost(pg, job.expectUser, sinceSec);
    for (let i = 0; i < 6; i++) { const m = await graph.graphFindNew(sinceSec); if (m) return m; await new Promise(r => setTimeout(r, 10000)); }   // Graph lags the UI by seconds
    return null;
  };
  const info = await find();
  let rb = classifyReadback(job.expected, info);
  const out = { info: info && { ...info, caption: undefined, captionChars: info.caption.length }, readback: rb };
  if (rb.state === 'SHARED_WITH_DEFECT' && rb.captionOnly && info?.permalink) {     // one automatic caption repair
    const fix = await web.editCaption(pg, info.permalink, job.expected.caption);
    const again = g ? await graph.graphMedia(info.id).catch((e) => ({ error: String(e.message) })) : await web.mediaInfo(pg, info.code);
    rb = classifyReadback(job.expected, again.error ? null : again);
    Object.assign(out, { captionRetry: fix, readback: rb });
  }
  return out;
}

async function share(cmd) {
  if (state.phase !== 'READY') return { ok: false, error: `nothing to share: state is ${state.phase}` };
  if (cmd.confirm !== state.id) return { ok: false, error: `confirm ${cmd.confirm} ≠ prepared job ${state.id}` };
  const job = state;
  const b = await web.connect();
  try {
    const pg = await web.findOwnTab(b);
    if (!pg) { await setState({ ...job, phase: 'FAILED', why: 'prepared tab is gone' }); return { ok: false, error: 'prepared tab is gone — prepare again' }; }
    await setState({ ...job, phase: 'SHARING' });
    const since = Math.floor(Date.now() / 1000);
    if (job.action === 'post_story') return await shareStoryJob(pg, job, since);
    if (job.action === 'post_fb_story') return await shareFbStoryJob(b, pg, job, since);
    const sh = await web.clickShare(pg);
    if (!sh.ok) { const s = await shot(pg, job.id, 'share-fail'); await web.closeOwn(pg, job.expectUser); await setState({ ...job, phase: 'FAILED', why: sh.why, screenshot: s }); return { ok: false, error: sh.why, screenshot: s }; }
    await shot(pg, job.id, 'shared');
    const rb = await readbackAndFix(pg, job, since);
    await web.closeOwn(pg, job.expectUser);
    const phase = rb.readback.state;
    await setState({ ...job, phase, ...rb, permalink: rb.info?.permalink });
    log({ action: 'share', id: job.id, user: job.expectUser, phase, permalink: rb.info?.permalink, code: rb.info?.code, defects: rb.readback.defects });
    return { ok: phase === 'SHARED', state: phase, permalink: rb.info?.permalink, ...rb };
  } finally { b.disconnect(); }
}

async function abort() {
  const b = await web.connect();
  try { const pg = await web.findOwnTab(b); if (pg) await web.closeOwn(pg, state.expectUser); } finally { b.disconnect(); }
  const was = state.phase;
  await setState({ phase: 'ABORTED', id: state.id, was });
  return { ok: true, state: 'ABORTED', was };
}

async function editCaptionCmd(cmd) {
  if (['PREPARING', 'READY', 'SHARING'].includes(state.phase)) return { ok: false, error: `busy: job ${state.id} is ${state.phase}` };
  const b = await web.connect(); let pg;
  try {
    pg = await web.openOwnTab(b, cmd.expectUser);
    const who = await web.whoami(pg);
    if (!who || who.toLowerCase() !== cmd.expectUser.toLowerCase()) return { ok: false, error: `logged in as ${who || 'unknown'}, expected ${cmd.expectUser} — nothing edited` };
    const fix = await web.editCaption(pg, cmd.permalink, cmd.caption);
    if (!fix.ok) return { ok: false, error: fix.why, screenshot: await shot(pg, cmd.id, 'edit-fail') };
    const code = cmd.permalink.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/)[1];
    const info = viaGraph(cmd.expectUser)
      ? await graph.graphFindByCode(code).catch((e) => ({ error: String(e.message) }))
      : await web.mediaInfo(pg, code);
    const rb = classifyReadback({ caption: cmd.caption }, info.error ? null : info);
    log({ action: 'edit_caption', id: cmd.id, user: cmd.expectUser, permalink: cmd.permalink, readback: rb.state });
    return { ok: rb.state === 'SHARED', readback: rb };
  } finally { await web.closeOwn(pg, cmd.expectUser); b.disconnect(); }
}

// Story: prepare in an iPhone-emulated tab, stop at the editor (READY), share only on confirm.
async function prepareStory(cmd) {
  if (!fs.existsSync(winToWsl(cmd.file))) return { ok: false, error: `file not found (Windows path expected): ${cmd.file}` };
  const job = { id: cmd.id, action: 'post_story', expectUser: cmd.expectUser, files: [cmd.file], music: cmd.music || null, expected: {} };
  await setState({ phase: 'PREPARING', ...job });
  const b = await web.connect(); let pg;
  const fail = async (step, why) => {
    const s = pg ? await shot(pg, cmd.id, `fail-${step}`) : null;
    await web.closeOwn(pg, cmd.expectUser);
    await setState({ phase: 'FAILED', ...job, step, why, screenshot: s });
    return { ok: false, error: `${step}: ${why}`, screenshot: s };
  };
  try {
    pg = await web.openOwnTab(b, cmd.expectUser);                     // desktop first: whoami reads the desktop nav
    const who = await web.whoami(pg);
    if (!who || who.toLowerCase() !== cmd.expectUser.toLowerCase()) return await fail('account', `logged in as ${who || 'unknown'}, expected ${cmd.expectUser} — nothing posted`);
    const ed = await web.openStoryEditor(pg, cmd.file);
    if (!ed.ok) return await fail('editor', ed.why);
    const checks = { user: who, editor: true };
    if (cmd.music) {
      checks.music = await web.probeMusicSticker(pg);
      if (!checks.music.music) return await fail('music', `no Music sticker in the tray (loading=${checks.music.loading}) — Phase 1b unproven, use the app path`);
      // TODO(T2445 1b): search cmd.music.query + pick clip, once the tray is proven to load in emulation
      return await fail('music', 'Music sticker present but search/pick not built yet (Phase 1b)');
    }
    const s = await shot(pg, cmd.id, 'ready');
    await setState({ phase: 'READY', ...job, checks, screenshot: s });
    return { ok: true, state: 'READY', checks, screenshot: s, next: `share needs {"action":"share","confirm":"${cmd.id}"}` };
  } catch (err) { return await fail('exception', String(err?.message || err)); }
  finally { b.disconnect(); }
}

async function shareStoryJob(pg, job, since) {
  const sh = await web.shareStory(pg);
  const s = await shot(pg, job.id, sh.ok ? 'shared' : 'share-fail');
  let rb = null;
  if (sh.ok) { await new Promise(r => setTimeout(r, 8000)); rb = viaGraph(job.expectUser) ? await graph.graphStories(since).catch((e) => ({ error: String(e.message) })) : await web.latestStory(pg, since); }
  await web.closeOwn(pg, job.expectUser);
  const phase = !sh.ok ? 'FAILED' : rb?.fresh > 0 ? 'SHARED' : 'SHARED_UNVERIFIED';
  await setState({ ...job, phase, why: sh.why, readback: rb, screenshot: s });
  log({ action: 'share_story', id: job.id, user: job.expectUser, phase, readback: rb });
  return { ok: phase === 'SHARED', state: phase, readback: rb, error: sh.why, screenshot: s };
}

// ---------- Facebook page story + swipe-up link via Business Suite (T2461) ----------
// Prepare stops before Share with: page identity checked against Graph, ONLY the FB page selected (the composer
// pre-selects the linked IG account too, and IG cannot carry the link), link applied and re-read from its dialog.
async function prepareFbStory(cmd) {
  if (!fs.existsSync(winToWsl(cmd.file))) return { ok: false, error: `file not found (Windows path expected): ${cmd.file}` };
  if (!viaGraph(cmd.expectUser)) return { ok: false, error: `post_fb_story needs the production account (default context + Graph token); ${cmd.expectUser} is not` };
  const job = { id: cmd.id, action: 'post_fb_story', expectUser: cmd.expectUser, files: [cmd.file], link: cmd.link, expected: { link: cmd.link } };
  await setState({ phase: 'PREPARING', ...job });
  let page, ig;
  try { page = await graph.pageIdentity(); ig = await graph.igUser(); }
  catch (e) { await setState({ phase: 'FAILED', ...job, step: 'identity', why: String(e.message) }); return { ok: false, error: `identity: ${e.message}` }; }
  if (ig.username.toLowerCase() !== cmd.expectUser.toLowerCase()) {
    const why = `page token belongs to ${page.name} / IG ${ig.username}, not ${cmd.expectUser} — nothing prepared`;
    await setState({ phase: 'FAILED', ...job, step: 'identity', why }); return { ok: false, error: why };
  }
  job.page = page;
  const b = await web.connect(); let pg;
  const fail = async (step, why) => {
    const s = pg ? await shot(pg, cmd.id, `fail-${step}`) : null;
    await web.closeOwn(pg, cmd.expectUser);
    await setState({ phase: 'FAILED', ...job, step, why, screenshot: s });
    return { ok: false, error: `${step}: ${why}`, screenshot: s };
  };
  try {
    const o = await mbs.openComposer(b, page.id); pg = o.pg;
    if (!o.ok) return await fail('composer', o.why);
    const up = await mbs.upload(pg, cmd.file);
    if (!up.ok) return await fail('upload', up.why);
    const sel = await mbs.selectOnlyPage(pg, page.name);
    if (!sel.ok) return await fail('share_to', sel.why);
    const ln = await mbs.addLink(pg, cmd.link);
    if (!ln.ok) return await fail('link', ln.why);
    const linkShot = path.join(SHOTS, `${cmd.id}-link.png`);
    const rl = await mbs.readLink(pg, linkShot);
    if (rl.value !== cmd.link) return await fail('link_readback', `link dialog holds ${rl.value}, expected ${cmd.link}`);
    if (await mbs.shareNowSelected(pg) !== 'true') return await fail('schedule', '"Share now" is not the selected option — refusing to prepare a scheduled post');
    const field = await mbs.shareToText(pg);
    if (field !== page.name) return await fail('share_to', `Share to changed to "${field}"`);
    const bl = await mbs.shareBlockers(pg);
    if (!bl.found || bl.disabled !== false) return await fail('blocked', `Share is ${bl.found ? 'disabled' : 'missing'}: ${bl.messages.join(' · ') || 'no message shown'}`);
    const checks = { page: page.name, shareTo: field, igDeselected: sel.changed, link: rl.value, linkButton: rl.button };
    const s = await shot(pg, cmd.id, 'ready');
    await setState({ phase: 'READY', ...job, checks, screenshot: s, linkScreenshot: linkShot });
    return { ok: true, state: 'READY', checks, screenshot: s, linkScreenshot: linkShot, next: `share needs {"action":"share","confirm":"${cmd.id}"}` };
  } catch (err) { return await fail('exception', String(err?.message || err)); }
  finally { b.disconnect(); }
}

// Share: re-check target + link on the live composer (the tab sat open between prepare and GO), click Share, then
// prove it: Graph shows a fresh page story AND its viewer carries a link equal to the requested one. Anything short
// of that is not SHARED (fail-closed): SHARED_UNVERIFIED (no fresh story) / SHARED_LINK_UNVERIFIED (story, no link).
async function shareFbStoryJob(b, pg, job, since) {
  const field = await mbs.shareToText(pg);
  const rl = await mbs.readLink(pg);
  if (field !== job.page.name || rl.value !== job.link) {
    const why = `composer changed since prepare (share to "${field}", link ${rl.value}) — not shared`;
    const s = await shot(pg, job.id, 'share-refused'); await web.closeOwn(pg, job.expectUser);
    await setState({ ...job, phase: 'FAILED', why, screenshot: s }); return { ok: false, error: why, screenshot: s };
  }
  const bl = await mbs.shareBlockers(pg);
  if (!bl.found || bl.disabled !== false) {
    const why = `Share is ${bl.found ? 'disabled' : 'missing'}: ${bl.messages.join(' · ') || 'no message shown'} — not shared`;
    const s0 = await shot(pg, job.id, 'share-refused'); await web.closeOwn(pg, job.expectUser);
    await setState({ ...job, phase: 'FAILED', why, screenshot: s0 }); return { ok: false, error: why, screenshot: s0 };
  }
  const sh = await mbs.clickShare(pg);
  const s = await shot(pg, job.id, sh.ok ? 'shared' : 'share-fail');
  await web.closeOwn(pg, job.expectUser);
  if (!sh.ok) { await setState({ ...job, phase: 'FAILED', why: sh.why, screenshot: s }); log({ action: 'share_fb_story', id: job.id, phase: 'FAILED', why: sh.why }); return { ok: false, error: sh.why, screenshot: s }; }
  let rb = null, viewer = null;
  for (let i = 0; i < 12 && !(rb?.fresh > 0); i++) {   // a page story can take a while to show up in Graph
    await new Promise(r => setTimeout(r, 10000));
    rb = await graph.graphPageStories(since).catch(e => ({ error: String(e.message) }));
  }
  if (rb?.fresh > 0 && rb.newest?.url) viewer = await mbs.storyLinks(b, rb.newest.url, job.page.name).catch(e => ({ error: String(e.message) }));
  const linkOk = !!viewer?.rendered && (viewer.links || []).some(u => mbs.sameUrl(u, job.link));
  const phase = !(rb?.fresh > 0) ? 'SHARED_UNVERIFIED' : linkOk ? 'SHARED' : 'SHARED_LINK_UNVERIFIED';
  await setState({ ...job, phase, readback: rb, viewer, screenshot: s });
  log({ action: 'share_fb_story', id: job.id, page: job.page.name, phase, story: rb?.newest?.post_id, link: job.link, viewerLinks: viewer?.links, rendered: viewer?.rendered });
  return { ok: phase === 'SHARED', state: phase, readback: rb, viewer, screenshot: s };
}

async function loginCmd(cmd) {
  const b = await web.connect();
  try { const r = await web.login(b, cmd.expectUser); log({ action: 'login', user: cmd.expectUser, ok: r.ok, why: r.why }); return r.ok ? { ok: true, cookies: r.cookies } : { ok: false, error: r.why }; }
  finally { b.disconnect(); }
}

async function handle(cmd) {
  const errs = validateCommand(cmd, { allowUsers: ALLOW });
  if (errs.length) return { ok: false, error: errs.join('; ') };
  switch (cmd.action) {
    case 'post_carousel': case 'post_reel': case 'post_story': case 'post_fb_story': return prepare(cmd);
    case 'login': return loginCmd(cmd);
    case 'share': return share(cmd);
    case 'abort': return abort();
    case 'edit_caption': return editCaptionCmd(cmd);
    case 'state': return { ok: true, state };
    default: return { ok: false, error: `unknown action ${cmd.action}` };
  }
}

// ---------- MQTT loop (serial: one browser job at a time) ----------
let chain = Promise.resolve();
// T2906 S2-B: every command must be signed with the vault key (sign.mjs); no key = nothing runs (fail closed)
let KEY = null;
try { KEY = loadKey(); } catch (e) { console.error(`ig-bridge: ${e.message} — every command will be refused · fix: ~/.oracle/security/ig-bridge-hmac.env (T2906)`); }
const seen = new Map();
function onLine(line) {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  const refused = verify(KEY, cmd, seen);
  if (refused) {
    const id = typeof cmd?.id === 'string' ? cmd.id.slice(0, 64) : null, action = typeof cmd?.action === 'string' ? cmd.action.slice(0, 32) : null;
    log({ rejected: refused, id, action });
    chain = chain.then(() => pub(T.res, { id, action, ok: false, error: `rejected: ${refused}` }));
    return;
  }
  chain = chain.then(async () => {
    const t0 = Date.now();
    let res; try { res = await handle(cmd); } catch (e) { res = { ok: false, error: String(e?.message || e) }; }
    const out = { id: cmd?.id ?? null, action: cmd?.action ?? null, ...res, ms: Date.now() - t0 };
    log({ cmd: { ...cmd, caption: cmd?.caption ? `${cmd.caption.length} chars` : undefined }, res: { ok: out.ok, state: out.state, error: out.error } });
    await pub(T.res, out);
  });
}

let sub = null, stopping = false;
const stop = () => { stopping = true; sub?.kill(); process.exit(0); };   // never leave an orphan mosquitto_sub behind (pm2 restart = SIGINT)
process.on('SIGINT', stop); process.on('SIGTERM', stop);
function subscribe() {
  sub = spawn('mosquitto_sub', ['-h', 'localhost', '-t', T.cmd, '-R'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  sub.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  sub.on('close', code => { if (stopping) return; console.error(`mosquitto_sub exited ${code}, resubscribing in 3s`); setTimeout(subscribe, 3000); });
}

subscribe();
await pub(T.state, state, true);
console.log(`ig-bridge up · allow=${ALLOW.join(',') || '(none)'} · state=${state.phase} · log=${LOG_FILE}`);
