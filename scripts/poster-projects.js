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

const GID_RE = /^g-p-[0-9a-f]{32}$/;
const MAX_PER_UPLOAD = 10;      // researcher playbook @ed1a7fc: max 10 files per upload
const SIDEBAR_PAGE = 20;        // limit=100 → HTTP 422 (probe 7); the UI itself asks for 20
const SIDEBAR_MAX_PAGES = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pure ──

/** argv after `node poster.js` → { cmd, sub, project, title, rest }. --brand/--force/--dry-run are left to poster.js. */
function parseArgs(args) {
  const out = { cmd: args[0], sub: null, project: null, title: null, rest: [] };
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
    if (a === '--brand') { i++; continue; }
    if (a === '--force' || a === '--dry-run') continue;
    if (out.cmd !== 'new-chat' && out.sub === null) { out.sub = a; continue; }
    out.rest.push(a);
  }
  return out;
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

async function projectFilesCmd(page, a, { browserPath, dryRun }) {
  if (!['add', 'list', 'remove'].includes(a.sub)) return refuse('usage: project-files add|list|remove --project <name|g-p-id> <files…>');
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

async function projectInstructionsCmd(page, a, { dryRun }) {
  if (!['get', 'set'].includes(a.sub)) return refuse('usage: project-instructions get|set --project <name|g-p-id> [file]');
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

module.exports = {
  GID_RE, MAX_PER_UPLOAD, CAP, parseArgs, matchProject, planAdd, planRemove,
  listProjects, resolveProject, readProject, addFiles, removeFiles, setInstructions, gotoProject,
  projectFilesCmd, projectInstructionsCmd, newProjectChat,
};
