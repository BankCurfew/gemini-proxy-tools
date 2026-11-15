// T4249 (bob 15 Nov, แบงค์ order via designer): ChatGPT Projects done properly — sources + instructions live on the PROJECT,
// so every new chat in it starts trained (a chat's own history does not carry over).
//   poster.js project-files add|list|remove --project <name|g-p-id> <files…>
//   poster.js project-instructions get|set --project <name|g-p-id> [file]
//   poster.js new-chat --project <name|g-p-id> --title <t>
// There is no public Projects API (researcher playbook @ed1a7fc): every WRITE goes through the UI, like a person would
// (Sources file input, the row's Delete, Project settings → Save). The backend-api calls the UI itself makes are only READ
// here, to prove what landed (dev probes 15 Nov, Dev-Oracle output/t4249/probe-*.mjs):
//   project + files + instructions  GET  /backend-api/gizmos/<g-p-id>?include_file_limits=true
//   project list (paged, cursor)    GET  /backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0&limit=20[&cursor=]
//   upload lands                    POST /backend-api/projects/<g-p-id>/files            (after POST /files + process_upload_stream)
//   remove lands                    DELETE /backend-api/projects/<g-p-id>/files/<file_id>
//   instructions land               PATCH /backend-api/projects/<g-p-id>                  {instructions, name, emoji, theme}
'use strict';
const fs = require('fs');
const path = require('path');
const { checkSources } = require('./project-source-gate');

const GID_RE = /^g-p-[0-9a-f]{32}$/;
const MAX_PER_UPLOAD = 10;      // researcher playbook @ed1a7fc: max 10 files per upload
const SIDEBAR_PAGE = 20;        // limit=100 → HTTP 422 (probe 7); the UI itself asks for 20
const SIDEBAR_MAX_PAGES = 50;
const NO_SUB_CMDS = new Set(['new-chat', 'create-project', 'move-chat']);   // T4279: flags only, no sub-command word
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pure ──

/** argv after `node poster.js` → { cmd, sub, project, title, rest }. --brand/--force/--dry-run are left to poster.js. */
function parseArgs(args) {
  const out = { cmd: args[0], sub: null, project: null, title: null, name: null, instructionsFile: null, rest: [] };
  const noSub = NO_SUB_CMDS.has(out.cmd);
  const take = (flag, i) => {
    const eq = args[i].startsWith(`${flag}=`) ? args[i].slice(flag.length + 1) : null;
    if (eq !== null) return [eq, i];
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return [args[i + 1], i + 1];
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--project' || a.startsWith('--project=')) { [out.project, i] = take('--project', i); continue; }
    if (a === '--title' || a.startsWith('--title=')) { [out.title, i] = take('--title', i); continue; }
    if (a === '--name' || a.startsWith('--name=')) { [out.name, i] = take('--name', i); continue; }
    if (a === '--instructions-file' || a.startsWith('--instructions-file=')) { [out.instructionsFile, i] = take('--instructions-file', i); continue; }
    if (a === '--brand') { i++; continue; }
    if (a === '--force' || a === '--dry-run') continue;
    if (noSub) throw new Error(`${out.cmd}: unexpected argument "${a}" (names with spaces need quotes)`);
    if (out.sub === null) { out.sub = a; continue; }
    out.rest.push(a);
  }
  return out;
}

// ── pure: poster.config.json edits (T4279). Each returns { changed, next } and never touches the file. ──

const fix = (cmd) => ` · fix: ${cmd}`;   // GR#8b: every refusal ends with the command that fixes it

/** projects.<name> = gid. Same name + same id = no change; same name + another id = refuse (never repoint silently). */
function configWithProject(onDisk, name, gid) {
  const n = String(name || '').trim();
  if (!n) throw new Error('create-project needs --name <name>' + fix('node poster.js create-project --name "<name>"'));
  if (!GID_RE.test(gid || '')) throw new Error(`project id must be g-p-<32 hex>, got ${String(gid).slice(0, 40)}` + fix('node poster.js project-files list --project "<name>"'));
  const cur = (onDisk.projects || {})[n];
  if (cur === gid) return { changed: false, next: onDisk };
  if (cur) throw new Error(`poster.config.json already projects.${n} = ${cur}, server says ${gid}: two projects or a stale id` + fix(`edit projects["${n}"] in poster.config.json to the live id, then re-run`));
  return { changed: true, next: { ...onDisk, projects: { ...(onDisk.projects || {}), [n]: gid } } };
}

/** brands.<brand>.project = <name>; the project must already be in projects (create-project writes it). */
function configWithBrandProject(onDisk, brand, name) {
  const b = String(brand || '').trim().toLowerCase();
  const n = String(name || '').trim();
  if (!b) throw new Error('move-chat needs --brand <brand>' + fix('node poster.js move-chat --brand <brand> --project "<name>"'));
  const entry = (onDisk.brands || {})[b];
  if (!entry) throw new Error(`brand "${b}" is not in poster.config.json (brands: ${Object.keys(onDisk.brands || {}).join(', ')})` + fix(`node poster.js move-chat --brand <one of the brands above> --project "${n}"`));
  if (!entry.chat_id) throw new Error(`brands.${b} has no chat_id, nothing to move` + fix(`node poster.js new-chat --brand ${b}`));
  const gid = (onDisk.projects || {})[n];
  if (!gid) throw new Error(`poster.config.json has no projects["${n}"] (projects: ${Object.keys(onDisk.projects || {}).map((k) => `"${k}"`).join(', ')})` + fix(`node poster.js create-project --name "${n}"`));
  if (entry.project === n) return { changed: false, next: onDisk, gid, chatId: entry.chat_id };
  return { changed: true, next: { ...onDisk, brands: { ...onDisk.brands, [b]: { ...entry, project: n } } }, gid, chatId: entry.chat_id };
}

/** 2-space JSON like poster.js, the file's own trailing newline kept (git has one, new-chat drops it), temp file + rename. */
function writeConfigAtomic(file, obj) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const nl = fs.existsSync(file) && fs.readFileSync(file, 'utf-8').endsWith('\n') ? '\n' : '';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + nl, 'utf-8');
  fs.renameSync(tmp, file);
}

/** One project for <name|g-p-id>, or throw. Fails closed on 0 or 2+ matches (never "the first one"). */
function matchProject(list, ref) {
  const want = String(ref || '').trim();
  if (!want) throw new Error('--project <name|g-p-id> is required');
  if (GID_RE.test(want)) {
    const hit = list.find((p) => p.id === want);
    if (!hit) throw new Error(`project ${want} is not in this account's project list (${list.length} projects): deleted, or another account`);
    return hit;
  }
  const hits = list.filter((p) => (p.name || '').trim() === want);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`${hits.length} projects named "${want}" (${hits.map((p) => p.id).join(', ')}): pass the g-p id instead`);
  const near = list.filter((p) => (p.name || '').trim().toLowerCase() === want.toLowerCase()).map((p) => `"${p.name}" ${p.id}`);
  throw new Error(`no project named "${want}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''} · projects: ${list.map((p) => `"${p.name}"`).join(', ')}`);
}

/** Which files may go up. All-or-nothing: any refusal = nothing is uploaded, and the reason names every refused file. */
function planAdd(currentNames, max, files) {
  const refuse = (reason, refused) => ({ ok: false, reason, refused, batches: [] });
  if (!files.length) return refuse('no files given', []);
  const bad = files.filter((f) => { try { return !fs.statSync(f).isFile(); } catch { return true; } });
  if (bad.length) return refuse(`not a readable file: ${bad.map((f) => path.basename(f)).join(', ')}`, bad.map((f) => path.basename(f)));
  const names = files.map((f) => path.basename(f));
  const twice = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (twice.length) return refuse(`same file name twice in one call: ${twice.join(', ')} (the project lists sources by name)`, twice);
  const have = new Set(currentNames);
  const already = names.filter((n) => have.has(n));
  if (already.length) return refuse(`already in the project: ${already.join(', ')} (remove it first, or rename the new file)`, already);
  if (currentNames.length + files.length > max) {
    const room = Math.max(0, max - currentNames.length);
    const over = names.slice(room);
    return refuse(`project cap: ${currentNames.length} + ${files.length} > ${max} files · nothing uploaded · these ${over.length} do not fit: ${over.join(', ')}`, over);
  }
  const batches = [];
  for (let i = 0; i < files.length; i += MAX_PER_UPLOAD) batches.push(files.slice(i, i + MAX_PER_UPLOAD));
  return { ok: true, reason: '', refused: [], batches };
}

/** Sources to delete, by name. All-or-nothing: a name that is missing or held twice = refuse, nothing deleted. */
function planRemove(projectFiles, names) {
  const targets = []; const problems = [];
  for (const raw of names) {
    const n = path.basename(raw);
    const hits = projectFiles.filter((f) => f.name === n);
    if (hits.length === 0) problems.push(`${n} is not in the project`);
    else if (hits.length > 1) problems.push(`${hits.length} files named ${n} (remove it in the UI)`);
    else targets.push(hits[0]);
  }
  if (!names.length) problems.push('no file names given');
  return problems.length ? { ok: false, reason: problems.join(' · '), targets: [] } : { ok: true, reason: '', targets };
}

// ── page: reads (the UI's own backend-api calls, same session) ──

async function api(page, method, p) {
  return page.evaluate(async ([m, url]) => {
    const s = await (await fetch('/api/auth/session')).json();
    if (!s || !s.accessToken) return { status: 0, error: 'no ChatGPT session in this tab (logged out?)' };
    const r = await fetch(url, { method: m, headers: { Authorization: `Bearer ${s.accessToken}` } });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
  }, [method, p]);
}

/** Every project in the account (walks the sidebar cursor: the first page alone holds 5). */
async function listProjects(page) {
  const all = []; let cursor = null; let pages = 0;
  do {
    const q = `conversations_per_gizmo=0&limit=${SIDEBAR_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await api(page, 'GET', `/backend-api/gizmos/snorlax/sidebar?${q}`);
    if (r.status !== 200 || !r.json) throw new Error(`project list: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
    for (const i of r.json.items || []) {
      const g = i.gizmo && i.gizmo.gizmo;
      if (g && GID_RE.test(g.id || '')) all.push({ id: g.id, name: (g.display && g.display.name) || '' });
    }
    cursor = r.json.cursor || null; pages++;
  } while (cursor && pages < SIDEBAR_MAX_PAGES);
  if (cursor) throw new Error(`project list: still more after ${SIDEBAR_MAX_PAGES} pages, refusing to guess`);
  return all;
}

async function resolveProject(page, ref) { return matchProject(await listProjects(page), ref); }

/** { name, files: [{name, size, file_id}], instructions, max } straight from the server. */
async function readProject(page, gid) {
  const r = await api(page, 'GET', `/backend-api/gizmos/${gid}?include_file_limits=true`);
  if (r.status !== 200 || !r.json || !r.json.gizmo) throw new Error(`project ${gid}: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  const g = r.json.gizmo;
  return {
    name: (g.display && g.display.name) || '',
    files: (r.json.files || []).map((f) => ({ name: f.name, size: f.size, file_id: f.file_id })),
    instructions: typeof g.instructions === 'string' ? g.instructions : '',
    max: (r.json.project_file_limits && r.json.project_file_limits.max_file_limit) || CAP,
  };
}

// ── page: writes through the UI ──

async function gotoProject(page, gid, tab) {
  await page.goto(`https://chatgpt.com/g/${gid}/project${tab ? `?tab=${tab}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);
  if (!page.url().includes(gid)) throw new Error(`opening project ${gid} landed at ${page.url().slice(0, 80)}`);
}

/** The Sources file input = the one without an id (the 4 with ids are the composer's; probe 3). */
async function sourcesInput(page, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const h of await page.$$('input[type="file"]')) if (!(await h.evaluate((e) => e.id))) return h;
    await sleep(500);
  }
  return null;
}

/**
 * Upload each file through the Sources input, one per input action (≤10 per batch, page re-opened between batches).
 * A file counts as added only when POST /projects/<gid>/files answered 200 for its name; a non-200 on its POST /files or
 * process_upload_stream, or no answer in 90 s = refused, reported by name. Returns { added, refused }.
 */
async function addFiles(page, gid, batches, browserPath) {
  const added = []; const refused = [];
  const seen = { landed: new Set(), failed: new Map() };
  const onRes = (r) => {
    const q = r.request(); if (q.method() !== 'POST') return;
    const u = r.url(); let body = {}; try { body = JSON.parse(q.postData() || '{}'); } catch {}
    if (u.endsWith(`/backend-api/projects/${gid}/files`) && r.status() === 200) for (const f of body.files || []) seen.landed.add(f.name);
    else if (/\/backend-api\/files(\/process_upload_stream)?$/.test(u) && r.status() !== 200 && body.file_name) seen.failed.set(body.file_name, `HTTP ${r.status()}`);
  };
  page.on('response', onRes);
  try {
    for (const batch of batches) {
      await gotoProject(page, gid, 'sources');
      for (const f of batch) {
        const n = path.basename(f);
        const input = await sourcesInput(page);
        if (!input) { refused.push(`${n} (no Sources file input on the page)`); continue; }
        await input.uploadFile(await browserPath(page, f));
        const end = Date.now() + 90000;
        while (Date.now() < end && !seen.landed.has(n) && !seen.failed.has(n)) await sleep(500);
        if (seen.landed.has(n)) { added.push(n); console.log(`[project-files] added ${n}`); }
        else { const why = seen.failed.get(n) || 'no answer in 90 s'; refused.push(`${n} (${why})`); console.error(`🚫 [project-files] refused ${n}: ${why}`); }
      }
    }
  } finally { page.off('response', onRes); }
  return { added, refused };
}

/** Delete each target via its row menu ("Actions for <name>" → Delete); counts only a 200 on its DELETE. */
async function removeFiles(page, gid, targets) {
  const removed = []; const failed = [];
  const gone = new Set();
  const onRes = (r) => { if (r.request().method() === 'DELETE' && r.status() === 200) { const m = r.url().match(/\/files\/([^/?]+)$/); if (m) gone.add(m[1]); } };
  page.on('response', onRes);
  try {
    await gotoProject(page, gid, 'sources');
    for (const t of targets) {
      // aria-label compared in JS, not in a CSS selector (a name may hold quotes)
      const btn = await page.evaluateHandle((n) => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === `Actions for ${n}`) || null, t.name);
      if (!(await btn.evaluate((b) => !!b))) { failed.push(`${t.name} (row not on the Sources page)`); continue; }
      await btn.click(); await sleep(800);
      let clicked = false;
      for (const item of await page.$$('[role="menuitem"]')) {
        if (/^Delete$/i.test((await item.evaluate((e) => e.textContent || '')).trim())) { await item.click(); clicked = true; break; }
      }
      if (!clicked) { await page.keyboard.press('Escape'); failed.push(`${t.name} (no Delete in its menu)`); continue; }
      const end = Date.now() + 20000;
      while (Date.now() < end && !gone.has(t.file_id)) await sleep(300);
      if (gone.has(t.file_id)) { removed.push(t.name); console.log(`[project-files] removed ${t.name}`); }
      else failed.push(`${t.name} (no DELETE 200 in 20 s)`);
    }
  } finally { page.off('response', onRes); }
  return { removed, failed };
}

/** Project actions → Project settings → instructions textarea → Save; resolves on the PATCH 200. */
async function setInstructions(page, gid, text) {
  let patched = 0;
  const onRes = (r) => { if (r.request().method() === 'PATCH' && r.url().endsWith(`/backend-api/projects/${gid}`)) patched = r.status(); };
  page.on('response', onRes);
  try {
    await gotoProject(page, gid);
    const pa = await page.$('button[aria-label="Project actions"]');
    if (!pa) throw new Error('no "Project actions" button on the project page');
    await pa.click(); await sleep(800);
    let opened = false;
    for (const m of await page.$$('[role="menuitem"]')) if (/Project settings/i.test(await m.evaluate((e) => e.textContent || ''))) { await m.click(); opened = true; break; }
    if (!opened) throw new Error('no "Project settings" in the Project actions menu');
    const ta = await page.waitForSelector('[role="dialog"] textarea[name="project-instructions"]', { timeout: 10000 }).catch(() => null);
    if (!ta) throw new Error('Project settings has no instructions field (textarea[name="project-instructions"])');
    // native setter + input event: React keeps the value (typing Thai + newlines key by key is slow and lossy)
    await ta.evaluate((e, v) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, v);
      e.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await sleep(500);
    let saved = false;
    for (const b of await page.$$('[role="dialog"] button')) if (/^Save$/i.test((await b.evaluate((e) => e.textContent || '')).trim())) { await b.click(); saved = true; break; }
    if (!saved) throw new Error('no Save button in Project settings (instructions unchanged?)');
    const end = Date.now() + 20000;
    while (Date.now() < end && !patched) await sleep(300);
    if (patched !== 200) throw new Error(`instructions PATCH ${patched || 'not sent in 20 s'}`);
  } finally { page.off('response', onRes); }
}

// ── commands (poster.js dispatches here; each returns the exit code: 0 ok, 1 refused / not proven) ──

const CAP = 40;   // bob 15 Nov 12:0x: plan = Pro (แบงค์) → 40 files per project, 10 per upload; refuse past 40 even if the server says more
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const refuse = (msg) => { console.error(`🚫 ${msg}`); return 1; };

async function projectFilesCmd(page, a, { browserPath, dryRun, sourceGate = checkSources }) {   // sourceGate: tests of the other rules pass a stub
  if (!['add', 'list', 'remove'].includes(a.sub)) return refuse('usage: project-files add|list|remove --project <name|g-p-id> <files…>');
  if (a.sub === 'add') {   // T4249 F2: every source must be content the pre-push scan read; checked before the page is touched
    const g = sourceGate(a.rest);
    if (!g.ok) return refuse(`[project-files] nothing uploaded, ${g.refused.length} file(s) refused:\n  ${g.refused.map((r) => r.reason).join('\n  ')}`);
  }
  const p = await resolveProject(page, a.project);
  const cur = await readProject(page, p.id);
  const max = Math.min(cur.max, CAP);
  if (a.sub === 'list') {
    for (const f of cur.files) console.log(`${f.name}\t${fmtSize(f.size)}`);
    console.log(`[project-files] ${cur.files.length}/${max} files in "${cur.name}" ${p.id}`);
    return 0;
  }
  if (a.sub === 'add') {
    const plan = planAdd(cur.files.map((f) => f.name), max, a.rest);
    if (!plan.ok) return refuse(`[project-files] nothing uploaded: ${plan.reason}`);
    console.log(`[project-files] "${cur.name}" ${p.id}: ${cur.files.length} + ${a.rest.length} → ${cur.files.length + a.rest.length}/${max}, ${plan.batches.length} batch(es) of ≤${MAX_PER_UPLOAD}`);
    if (dryRun) { plan.batches.forEach((b, i) => console.log(`  batch ${i + 1}: ${b.map((f) => path.basename(f)).join(', ')}`)); return 0; }
    const r = await addFiles(page, p.id, plan.batches, browserPath);
    const after = new Set((await readProject(page, p.id)).files.map((f) => f.name));
    const missing = r.added.filter((n) => !after.has(n));   // the response said 200 but the project does not list it
    console.log(`[project-files] added ${r.added.length}/${a.rest.length} · project now lists ${after.size}`);
    if (missing.length) return refuse(`[project-files] answered 200 but not in the project list: ${missing.join(', ')}`);
    if (r.refused.length) return refuse(`[project-files] refused: ${r.refused.join(' · ')}`);
    return 0;
  }
  const plan = planRemove(cur.files, a.rest);
  if (!plan.ok) return refuse(`[project-files] nothing removed: ${plan.reason}`);
  if (dryRun) { console.log(`[project-files] would remove from "${cur.name}": ${plan.targets.map((t) => t.name).join(', ')}`); return 0; }
  const r = await removeFiles(page, p.id, plan.targets);
  const after = new Set((await readProject(page, p.id)).files.map((f) => f.file_id));
  const still = plan.targets.filter((t) => after.has(t.file_id)).map((t) => t.name);
  console.log(`[project-files] removed ${r.removed.length}/${plan.targets.length} · project now lists ${after.size}`);
  if (still.length) return refuse(`[project-files] still in the project after remove: ${still.join(', ')}`);
  if (r.failed.length) return refuse(`[project-files] not removed: ${r.failed.join(' · ')}`);
  return 0;
}

async function projectInstructionsCmd(page, a, { dryRun, sourceGate = checkSources }) {   // sourceGate: as projectFilesCmd (tests stub it)
  if (!['get', 'set'].includes(a.sub)) return refuse('usage: project-instructions get|set --project <name|g-p-id> [file]');
  if (a.sub === 'set') {   // gate before the browser (security C1 on #73)
    if (!a.rest[0]) return refuse('project-instructions set needs a file');
    const g = instructionsGate(a.rest[0], sourceGate); if (g) return refuse(g);
  }
  const p = await resolveProject(page, a.project);
  const cur = await readProject(page, p.id);
  const file = a.rest[0];
  if (a.sub === 'get') {
    if (!file) { process.stdout.write(cur.instructions); if (!cur.instructions.endsWith('\n')) process.stdout.write('\n'); return 0; }
    fs.writeFileSync(file, cur.instructions, 'utf-8');
    console.log(`[project-instructions] "${cur.name}" ${p.id}: wrote ${Buffer.byteLength(cur.instructions)} bytes to ${file}`);
    return 0;
  }
  if (!file) return refuse('project-instructions set needs a file');
  let want;
  try { want = fs.readFileSync(file, 'utf-8'); } catch (e) { return refuse(`cannot read ${file}: ${e.message}`); }
  if (!want.trim()) return refuse(`${file} is empty: refusing to blank the project instructions`);
  if (cur.instructions === want) { console.log(`[project-instructions] "${cur.name}" already holds these ${Buffer.byteLength(want)} bytes: unchanged`); return 0; }
  if (dryRun) { console.log(`[project-instructions] would set "${cur.name}" ${p.id}: ${Buffer.byteLength(cur.instructions)} → ${Buffer.byteLength(want)} bytes`); return 0; }
  await setInstructions(page, p.id, want);
  const got = (await readProject(page, p.id)).instructions;
  if (got !== want) return refuse(`[project-instructions] read back ${Buffer.byteLength(got)} bytes ≠ file ${Buffer.byteLength(want)} bytes (first diff at char ${[...want].findIndex((c, i) => c !== got[i])})`);
  console.log(`[project-instructions] "${cur.name}" ${p.id}: set, read back byte-equal (${Buffer.byteLength(want)} bytes)`);
  return 0;
}

/**
 * A chat that opens INSIDE the project (so it starts with the project's sources + instructions), titled, URL printed.
 * Writes nothing to poster.config.json: a brand chat is still `new-chat --brand`. Success = the server has the chat with
 * gizmo_id = this project, a finished reply to the seed, and the title read back.
 */
async function newProjectChat(page, a, { sendAndConfirm }) {
  if (!a.title || !a.title.trim()) return refuse('new-chat --project needs --title <t>');
  const p = await resolveProject(page, a.project);
  await gotoProject(page, p.id);
  const seed = 'Reply only: "Ready."';
  if (!(await sendAndConfirm(page, seed, { label: 'new-chat', timeoutMs: 45000 }))) return refuse('[new-chat] seed did not land (see line above)');
  let chatId = null;
  for (let i = 0; i < 45 && !chatId; i++) {
    await sleep(1000);
    const m = page.url().match(/\/c\/([0-9a-f-]{36})/);
    if (m) chatId = m[1];
  }
  if (!chatId) return refuse(`[new-chat] no chat id in the URL after 45 s (${page.url().slice(0, 100)})`);
  const r = await page.evaluate(async ([id, title]) => {
    try {
      const s = await (await fetch('/api/auth/session')).json();
      const H = { Authorization: 'Bearer ' + s.accessToken, 'Content-Type': 'application/json' };
      const get = async () => { const g = await fetch('/backend-api/conversation/' + id, { headers: H }); return g.ok ? g.json() : { status: g.status }; };
      let j = null; let done = false;
      for (let i = 0; i < 30 && !done; i++) {
        j = await get();
        done = Object.values(j.mapping || {}).some((n) => n.message && n.message.author.role === 'assistant' && n.message.status === 'finished_successfully');
        if (done) break;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      const pr = await fetch('/backend-api/conversation/' + id, { method: 'PATCH', headers: H, body: JSON.stringify({ title }) });
      await new Promise((ok) => setTimeout(ok, 1500));
      const after = await get();
      return { done, gizmo_id: j.gizmo_id || null, temporary: !!j.is_temporary_chat, patch: pr.status, title: after.title };
    } catch (e) { return { error: e.message }; }
  }, [chatId, a.title.trim()]);
  if (r.error) return refuse(`[new-chat] ${r.error}`);
  if (!r.done) return refuse(`[new-chat] chat ${chatId}: no finished reply to the seed on the server after 30 s`);
  if (r.temporary) return refuse(`[new-chat] ${chatId} is a temporary chat`);
  if (r.gizmo_id !== p.id) return refuse(`[new-chat] chat ${chatId} is in ${r.gizmo_id || 'no project'}, not "${p.name}" ${p.id}`);
  if (r.title !== a.title.trim()) return refuse(`[new-chat] title read back "${r.title}" ≠ "${a.title.trim()}" (PATCH ${r.patch})`);
  console.log(`[new-chat] "${r.title}" in "${p.name}" ${p.id} (server: gizmo_id matches, seed reply finished)`);
  console.log(`https://chatgpt.com/g/${p.id}/c/${chatId}`);
  return 0;
}

// ── T4279: create-project + move-chat ──

const readConfig = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

/** An instructions file goes to OpenAI like a project source (security C1 on #73): md/txt only, then the same F2 gate
 *  (tracked, pushed, unchanged, no symlink, nothing under ψ/). Refusal text with a fix line, or null. No browser. */
function instructionsGate(file, sourceGate = checkSources) {
  if (!/\.(md|txt)$/i.test(file || '')) return `instructions file ${file}: only .md or .txt` + fix('export the instructions to a .md file in a brand repo, commit and push it');
  const g = sourceGate([file]);
  if (!g.ok) return `instructions file refused: ${g.refused.map((r) => r.reason).join('; ')}` + fix('commit + push the .md in a brand repo (not ψ/, not a symlink), then re-run');
  return null;
}

/** Refusal text (with its fix line) for what the config alone can refuse, or null. Runs before the browser is touched. */
function precheck(cmd, a, brand, configPath) {
  try {
    if (cmd === 'create-project') {
      if (!a.name || !a.name.trim()) return 'create-project needs --name <name>' + fix('node poster.js create-project --name "<name>"');
      if (a.instructionsFile) {
        let st = null; try { st = fs.statSync(a.instructionsFile); } catch {}
        if (!st || !st.isFile()) return `--instructions-file ${a.instructionsFile}: not a readable file` + fix('ls -l <file>');
        if (!fs.readFileSync(a.instructionsFile, 'utf-8').trim()) return `--instructions-file ${a.instructionsFile} is empty` + fix('write the instructions into the file first');
        const g = instructionsGate(a.instructionsFile); if (g) return g;
      }
      const cur = (readConfig(configPath).projects || {})[a.name.trim()];
      if (cur && !GID_RE.test(cur)) return `projects["${a.name.trim()}"] = ${String(cur).slice(0, 40)} is not a g-p id` + fix('edit poster.config.json');
    }
    if (cmd === 'move-chat') {
      if (!a.project) return 'move-chat needs --project <name>' + fix('node poster.js move-chat --brand <brand> --project "<name>"');
      configWithBrandProject(readConfig(configPath), brand, a.project);
    }
  } catch (e) { return e.message; }
  return null;
}

/** Slot windows are narrow (~516 px): ChatGPT then hides the sidebar and its project controls. Emulate a desktop
 *  viewport on this tab only for fn (the window itself is never resized, GR#5), cleared after. Probe T4279 15 Nov 21:3x. */
async function withDesktopViewport(page, fn) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  try { return await fn(); } finally { await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {}); await cdp.detach().catch(() => {}); }
}

/** The sidebar "Add new project" → name → Create. Only the UI makes projects (no public API, researcher playbook @ed1a7fc). */
async function createProjectUI(page, name) { return withDesktopViewport(page, () => createProjectUIDesktop(page, name)); }
async function createProjectUIDesktop(page, name) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const NEW_RE = /^(add new project|new project|โปรเจกต์ใหม่|สร้างโปรเจกต์)/i;
  const findNew = () => page.evaluateHandle((re) => [...document.querySelectorAll('nav button, nav a, nav [role="button"], aside button')]
    .find((e) => new RegExp(re, 'i').test((e.getAttribute('aria-label') || e.textContent || '').trim())) || null, NEW_RE.source);
  let btn = null;
  for (let i = 0; i < 15; i++) {   // the sidebar renders late; a collapsed one is opened once (state is per browser profile)
    await sleep(1000);
    btn = await findNew();
    if (await btn.evaluate((e) => !!e)) break;
    if (i === 5) await page.evaluate(() => { const o = [...document.querySelectorAll('button')].find((e) => /^open sidebar$/i.test(e.getAttribute('aria-label') || '')); if (o) o.click(); });
  }
  if (!(await btn.evaluate((e) => !!e))) {
    const seen = await page.evaluate(() => [...document.querySelectorAll('nav button, aside button')].map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30)).filter(Boolean).slice(0, 12).join(' | '));
    throw new Error(`no "Add new project" control in the sidebar (English or Thai label); sidebar buttons seen: ${seen || 'none'}` + fix('open chatgpt.com in the slot window, check the sidebar shows Projects'));
  }
  // DOM click: a mouse click at the button's box opened nothing (the sidebar row is hover-revealed; probe 21:3x)
  await btn.evaluate((e) => { e.scrollIntoView({ block: 'center' }); e.click(); }); await sleep(1500);
  const inp = await page.waitForSelector('[role="dialog"] input', { timeout: 10000 }).catch(() => null);
  if (!inp) throw new Error('"New project" opened no dialog with a name field' + fix('re-run; if it repeats, run Dev-Oracle output/t4279/probe-create-move.mjs'));
  await inp.type(name, { delay: 20 }); await sleep(500);
  let clicked = false;
  for (const b of await page.$$('[role="dialog"] button')) {
    if (/^(create project|สร้างโปรเจกต์|create|สร้าง)$/i.test((await b.evaluate((e) => e.textContent || '')).trim())) { await b.click(); clicked = true; break; }
  }
  if (!clicked) { await page.keyboard.press('Escape'); throw new Error('no "Create project" button in the dialog (English or Thai)' + fix('run Dev-Oracle output/t4279/probe-create-move.mjs')); }
  await sleep(4000);
}

async function createProjectCmd(page, a, { configPath, dryRun }) {
  const name = a.name.trim();
  const named = async () => (await listProjects(page)).filter((p) => (p.name || '').trim() === name);
  let hits = await named();
  if (hits.length > 1) return refuse(`${hits.length} projects named "${name}" (${hits.map((p) => p.id).join(', ')}): delete the extra in the UI` + fix(`node poster.js project-files list --project <g-p id>`));
  let made = false;
  if (!hits.length) {
    if (dryRun) { console.log(`[create-project] would create "${name}" (not in the project list)`); return 0; }
    await createProjectUI(page, name);
    for (let i = 0; i < 10 && !hits.length; i++) { hits = await named(); if (!hits.length) await sleep(2000); }
    if (hits.length !== 1) return refuse(`[create-project] after Create the list holds ${hits.length} project(s) named "${name}"` + fix(`node poster.js create-project --name "${name}"   (re-run = idempotent)`));
    made = true;
  }
  const gid = hits[0].id;
  if (a.instructionsFile) {
    const text = fs.readFileSync(a.instructionsFile, 'utf-8');
    if ((await readProject(page, gid)).instructions !== text) {
      if (dryRun) console.log(`[create-project] would set instructions from ${a.instructionsFile}`);
      else {
        await setInstructions(page, gid, text);
        if ((await readProject(page, gid)).instructions !== text) return refuse(`[create-project] instructions read back ≠ ${a.instructionsFile}` + fix(`node poster.js project-instructions set --project ${gid} ${a.instructionsFile}`));
      }
    }
  }
  const c = configWithProject(readConfig(configPath), name, gid);
  if (c.changed && !dryRun) writeConfigAtomic(configPath, c.next);
  console.log(`[create-project] "${name}" ${made ? 'created' : 'already exists (nothing created)'} · projects["${name}"] ${c.changed ? (dryRun ? 'would be added' : 'added') : 'unchanged'}`);
  console.log(gid);
  return 0;
}

/** { gizmo_id, title, busy } of a chat from the server; busy = the newest assistant message is not finished. */
async function readChat(page, chatId) {
  const r = await api(page, 'GET', `/backend-api/conversation/${chatId}`);
  if (r.status !== 200 || !r.json) throw new Error(`chat ${chatId}: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}` + fix('open the chat in the browser; deleted or another account?'));
  const msgs = Object.values(r.json.mapping || {}).map((n) => n.message).filter((m) => m && m.author && m.author.role === 'assistant');
  const last = msgs.sort((x, y) => (x.create_time || 0) - (y.create_time || 0)).pop();
  return { gizmo_id: r.json.gizmo_id || null, title: r.json.title || '', busy: !!last && last.status === 'in_progress' };
}

/** Does the project's own chat list (sidebar, conversations per project) hold this chat? Walks the cursor like the UI. */
async function projectHasChat(page, gid, chatId) {
  let cursor = null; let pages = 0;
  do {
    const q = `conversations_per_gizmo=20&limit=${SIDEBAR_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await api(page, 'GET', `/backend-api/gizmos/snorlax/sidebar?${q}`);
    if (r.status !== 200 || !r.json) return null;
    for (const i of r.json.items || []) {
      const g = i.gizmo && i.gizmo.gizmo;
      if (g && g.id === gid) return ((i.conversations && i.conversations.items) || []).some((c) => c.id === chatId);
    }
    cursor = r.json.cursor || null; pages++;
  } while (cursor && pages < SIDEBAR_MAX_PAGES);
  return null;
}

/** Chat options menu → "Move to project" → the project, by exact name (English or Thai labels; fail closed on neither). */
async function moveChatUI(page, chatId, name) { return withDesktopViewport(page, () => moveChatUIDesktop(page, chatId, name)); }
async function moveChatUIDesktop(page, chatId, name) {
  const { title } = await readChat(page, chatId);
  await page.goto(`https://chatgpt.com/c/${chatId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // the chat menu = the header button whose label (aria-label, else its text: no aria-label 21:5x) is the chat title (probe 21:3x); the old testid kept as a fallback.
  // The header renders late (5 s fixed wait missed it on the scratch chat 21:4x): poll up to 20 s.
  const findOpt = () => page.evaluateHandle((t) => [...document.querySelectorAll('header button')].find((e) => e.offsetParent !== null && (e.getAttribute('aria-label') || e.textContent || '').trim() === t)
    || document.querySelector('[data-testid="conversation-options-button"]') || null, title.trim());
  let opt = null;
  for (let i = 0; i < 20; i++) { await sleep(1000); opt = await findOpt(); if (await opt.evaluate((e) => !!e)) break; }
  if (!(await opt.evaluate((e) => !!e))) throw new Error(`no chat menu button (header button "${title}") on the chat page; ${await page.evaluate(() => `innerWidth=${innerWidth} url=${location.pathname} header buttons: ${[...document.querySelectorAll('header button')].map((e) => `${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30)}${e.offsetParent === null ? '(hidden)' : ''}`).join(' | ') || 'none'}`)}` + fix('run Dev-Oracle output/t4279/probe-dump.mjs <chat id>'));
  await opt.click(); await sleep(1200);
  const mv = await page.evaluateHandle(() => [...document.querySelectorAll('[role="menuitem"]')].find((e) => /move to project|ย้ายไป/i.test(e.textContent || '')) || null);
  if (!(await mv.evaluate((e) => !!e))) { await page.keyboard.press('Escape'); throw new Error('no "Move to project" in the chat menu (English or Thai)' + fix('run Dev-Oracle output/t4279/probe-create-move.mjs')); }
  await mv.hover(); await sleep(1200);
  const pick = () => page.evaluateHandle((n) => [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],[role="dialog"] button')]
    .filter((e) => (e.textContent || '').trim() === n), name);
  let found = await pick();
  if (!(await found.evaluate((l) => l.length))) { await mv.click(); await sleep(1500); found = await pick(); }   // a dialog instead of a submenu
  const n = await found.evaluate((l) => l.length);
  if (n !== 1) { await page.keyboard.press('Escape'); throw new Error(`"Move to project" lists ${n} entries named "${name}" (lazy list: scroll/search not reached it?)` + fix('run Dev-Oracle output/t4279/probe-create-move.mjs')); }
  await found.evaluate((l) => l[0].click());
  await sleep(3000);
}

async function moveChatCmd(page, a, { brand, configPath, dryRun }) {
  const pre = configWithBrandProject(readConfig(configPath), brand, a.project);
  const name = a.project.trim();
  const live = (await listProjects(page)).find((p) => p.id === pre.gid);
  if (!live) return refuse(`projects["${name}"] = ${pre.gid} is not in this account's project list (deleted?)` + fix(`node poster.js create-project --name "${name}"`));
  let chat = await readChat(page, pre.chatId);
  const before = chat.gizmo_id;
  if (chat.gizmo_id !== pre.gid) {
    if (chat.busy) return EXIT_TAB_BUSY;
    if (dryRun) { console.log(`[move-chat] would move ${brand} ${pre.chatId} "${chat.title}" from ${before || 'no project'} → "${name}" ${pre.gid}`); return 0; }
    await moveChatUI(page, pre.chatId, live.name);
    for (let i = 0; i < 8 && chat.gizmo_id !== pre.gid; i++) { await sleep(2000); chat = await readChat(page, pre.chatId); }
    if (chat.gizmo_id !== pre.gid) return refuse(`[move-chat] server says chat ${pre.chatId} is in ${chat.gizmo_id || 'no project'}, not "${name}" ${pre.gid} · config not changed` + fix(`node poster.js move-chat --brand ${brand} --project "${name}"`));
  }
  const listed = await projectHasChat(page, pre.gid, pre.chatId);
  if (listed === false) return refuse(`[move-chat] chat's project = ${pre.gid} but the project's chat list does not hold ${pre.chatId} · config not changed` + fix(`node poster.js move-chat --brand ${brand} --project "${name}"`));
  if (!dryRun && pre.changed) writeConfigAtomic(configPath, pre.next);
  console.log(`[move-chat] ${brand} ${pre.chatId} "${chat.title}": ${before === pre.gid ? 'already in' : `${before || 'no project'} →`} "${name}" ${pre.gid} · project list ${listed === null ? 'not readable (chat-side read-back only)' : 'holds it'} · brands.${brand}.project ${pre.changed ? (dryRun ? 'would be set' : 'set') : 'unchanged'}`);
  console.log(`https://chatgpt.com/c/${pre.chatId}`);
  return 0;
}

const EXIT_TAB_BUSY = 75;

module.exports = {
  precheck, instructionsGate, createProjectCmd, moveChatCmd, readChat,
  GID_RE, MAX_PER_UPLOAD, CAP, parseArgs, matchProject, planAdd, planRemove,
  configWithProject, configWithBrandProject, writeConfigAtomic,
  listProjects, resolveProject, readProject, addFiles, removeFiles, setInstructions, gotoProject,
  projectFilesCmd, projectInstructionsCmd, newProjectChat,
};
