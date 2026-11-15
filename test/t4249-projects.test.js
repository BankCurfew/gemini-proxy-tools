#!/usr/bin/env node
// T4249 (bob 15 Nov, แบงค์ order via designer): GPT Projects commands — the pure parts.
//   name → id fails closed on 0 or 2+ · add refuses past the project cap (25) and batches by 10 (researcher playbook @ed1a7fc)
//   · remove fails closed on a missing / duplicated name · flags parse.
//   node test/t4249-projects.test.js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const P = require('../scripts/poster-projects');
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const A = 'g-p-6af8481020708191a9d884f1e0322701', B = 'g-p-6af92d70e3388191bd839e95b113ead5', C = 'g-p-6a548bcae0f481918286e9fb63633e98';
const list = [{ id: A, name: 'ACEP Living Campus style' }, { id: B, name: 'T4249 scratch' }, { id: C, name: 'iAgencyAIA' }];

// ── matchProject ──
check('name → its id', P.matchProject(list, 'T4249 scratch').id === B);
check('name is trimmed', P.matchProject(list, '  iAgencyAIA ').id === C);
check('g-p id → that project', P.matchProject(list, A).name === 'ACEP Living Campus style');
let m = throws(() => P.matchProject(list, 'acep living campus style'));
check('0 exact matches = refuse, and says the near name', /no project named/.test(m) && /ACEP Living Campus style/.test(m), m);
m = throws(() => P.matchProject([...list, { id: 'g-p-' + 'a'.repeat(32), name: 'iAgencyAIA' }], 'iAgencyAIA'));
check('2+ matches = refuse, lists both ids', /2 projects named/.test(m) && m.includes(C) && m.includes('g-p-' + 'a'.repeat(32)), m);
m = throws(() => P.matchProject(list, 'g-p-' + 'f'.repeat(32)));
check('unknown g-p id = refuse', /not in this account's project list/.test(m), m);
check('empty ref = refuse', /--project/.test(throws(() => P.matchProject(list, ''))));

// ── planAdd ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't4249-'));
const mk = (n, bytes = 10) => { const f = path.join(dir, n); fs.writeFileSync(f, Buffer.alloc(bytes, 65)); return f; };
const files12 = Array.from({ length: 12 }, (_, i) => mk(`f${String(i).padStart(2, '0')}.txt`));
let p = P.planAdd([], 25, files12);
check('12 files into an empty project = ok, batches 10 + 2', p.ok && p.batches.length === 2 && p.batches[0].length === 10 && p.batches[1].length === 2, JSON.stringify(p.batches.map((b) => b.length)));
const have20 = Array.from({ length: 20 }, (_, i) => `old${i}.png`);
p = P.planAdd(have20, 25, files12);
check('20 + 12 > 25 = refuse ALL (nothing uploaded)', !p.ok && p.batches.length === 0, p.reason);
check('cap message names the 7 that do not fit + the numbers', /20 \+ 12 > 25/.test(p.reason) && p.refused.length === 7 && p.refused[0] === 'f05.txt', JSON.stringify(p.refused));
p = P.planAdd(have20, 25, files12.slice(0, 5));
check('20 + 5 = 25 exactly = ok', p.ok && p.batches.flat().length === 5);
p = P.planAdd(['f00.txt'], 25, files12.slice(0, 2));
check('name already in the project = refuse that name', !p.ok && p.refused.includes('f00.txt') && /already in the project/.test(p.reason), p.reason);
const dupe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't4249b-')), 'f01.txt'); fs.writeFileSync(dupe, 'x');
p = P.planAdd([], 25, [files12[1], dupe]);
check('same name twice in one call = refuse', !p.ok && p.refused.includes('f01.txt') && /twice/.test(p.reason), p.reason);
p = P.planAdd([], 25, [files12[0], path.join(dir, 'missing.pdf')]);
check('missing file = refuse it by name', !p.ok && p.refused.includes('missing.pdf') && /not a readable file/.test(p.reason), p.reason);
p = P.planAdd([], 25, [dir]);
check('a directory = refuse', !p.ok && /not a readable file/.test(p.reason));
p = P.planAdd([], 25, []);
check('no files = refuse', !p.ok && /no files/.test(p.reason));

// ── planRemove ──
const pf = [{ name: 'a.txt', file_id: 'file_1' }, { name: 'b.png', file_id: 'file_2' }, { name: 'b.png', file_id: 'file_3' }];
let r = P.planRemove(pf, ['a.txt']);
check('remove by name → its file_id', r.ok && r.targets.length === 1 && r.targets[0].file_id === 'file_1');
r = P.planRemove(pf, ['zzz.txt', 'a.txt']);
check('a name not in the project = refuse all', !r.ok && r.targets.length === 0 && /zzz\.txt/.test(r.reason), r.reason);
r = P.planRemove(pf, ['b.png']);
check('a name held twice = refuse (which one?)', !r.ok && /2 files named b\.png/.test(r.reason), r.reason);
r = P.planRemove(pf, ['/home/x/a.txt']);
check('a path is matched by its basename', r.ok && r.targets[0].name === 'a.txt');

// ── parseArgs ──
let a = P.parseArgs(['project-files', 'add', '--project', 'T4249 scratch', 'x.txt', 'y.png']);
check('flags parse', a.cmd === 'project-files' && a.sub === 'add' && a.project === 'T4249 scratch' && a.rest.join(',') === 'x.txt,y.png', JSON.stringify(a));
a = P.parseArgs(['new-chat', '--project', B, '--title', 'ACEP round 3']);
check('new-chat title', a.project === B && a.title === 'ACEP round 3' && a.rest.length === 0, JSON.stringify(a));
a = P.parseArgs(['project-instructions', 'get', '--project=iAgencyAIA', 'out.md']);
check('--project=<v> form', a.project === 'iAgencyAIA' && a.rest[0] === 'out.md', JSON.stringify(a));
check('--project with no value = refuse', /--project needs a value/.test(throws(() => P.parseArgs(['project-files', 'list', '--project']))));

// ── commands on a fake page: refusals must stop BEFORE any UI write (the fake page has no goto/$$ — a write throws) ──
// The fake answers only the two READ calls (sidebar list + project gizmo), the same shapes the probes recorded.
function fakePage(files, instructions = '', max = 40) {
  const reads = [];
  return {
    reads,
    evaluate: async (_fn, [method, url]) => {
      reads.push(`${method} ${url.split('?')[0]}`);
      if (url.startsWith('/backend-api/gizmos/snorlax/sidebar')) return { status: 200, json: { items: list.map((p) => ({ gizmo: { gizmo: { id: p.id, display: { name: p.name } } } })), cursor: null } };
      if (url.startsWith(`/backend-api/gizmos/${B}`)) return { status: 200, json: { gizmo: { display: { name: 'T4249 scratch' }, instructions }, files, project_file_limits: { max_file_limit: max } } };
      return { status: 404, json: null };
    },
  };
}
const quiet = async (fn) => {   // run a command, capture its console lines
  const out = []; const ol = console.log; const oe = console.error;
  console.log = (...x) => out.push(x.join(' ')); console.error = (...x) => out.push(x.join(' '));
  try { return { code: await fn(), out: out.join('\n') }; } finally { console.log = ol; console.error = oe; }
};
const files3 = [1, 2, 3].map((i) => ({ name: `s${i}.txt`, size: 2048 * i, file_id: `file_${i}` }));
const deps = { browserPath: async (_p, f) => f, dryRun: false, sourceGate: () => ({ ok: true, refused: [] }) };   // T4249 F2 gate has its own test (t4249-source-gate)

(async () => {
  let pg = fakePage(files3);
  let r2 = await quiet(() => P.projectFilesCmd(pg, P.parseArgs(['project-files', 'list', '--project', 'T4249 scratch']), deps));
  check('list = names + sizes + count, exit 0', r2.code === 0 && /s1\.txt\t2 KB/.test(r2.out) && /3\/40 files in "T4249 scratch"/.test(r2.out), r2.out);

  const many = Array.from({ length: 38 }, (_, i) => mk(`many-${i}.txt`));
  pg = fakePage(files3);
  r2 = await quiet(() => P.projectFilesCmd(pg, P.parseArgs(['project-files', 'add', '--project', B, ...many]), deps));
  check('add past 40 = exit 1, nothing uploaded (reads only)', r2.code === 1 && /nothing uploaded/.test(r2.out) && pg.reads.every((x) => x.startsWith('GET')), r2.out);

  pg = fakePage(files3, '', 60);
  r2 = await quiet(() => P.projectFilesCmd(pg, P.parseArgs(['project-files', 'add', '--project', B, ...many]), deps));
  check('server limit 60 is still capped at 40 (Pro, bob 15 Nov)', r2.code === 1 && /> 40 files/.test(r2.out), r2.out);

  pg = fakePage(files3);
  r2 = await quiet(() => P.projectFilesCmd(pg, P.parseArgs(['project-files', 'add', '--project', B, mk('s2.txt')]), deps));
  check('add a name already there = exit 1', r2.code === 1 && /already in the project: s2\.txt/.test(r2.out), r2.out);

  pg = fakePage(files3);
  r2 = await quiet(() => P.projectFilesCmd(pg, P.parseArgs(['project-files', 'add', '--project', B, mk('new-a.txt'), mk('new-b.txt'), '--dry-run']), { ...deps, dryRun: true }));
  check('add --dry-run = plan printed, exit 0, no write', r2.code === 0 && /batch 1: new-a\.txt, new-b\.txt/.test(r2.out), r2.out);

  pg = fakePage(files3);
  r2 = await quiet(() => P.projectFilesCmd(pg, P.parseArgs(['project-files', 'remove', '--project', B, 'nope.txt']), deps));
  check('remove a missing name = exit 1, nothing removed', r2.code === 1 && /nothing removed: nope\.txt is not in the project/.test(r2.out), r2.out);

  pg = fakePage(files3);
  r2 = await quiet(() => P.projectFilesCmd(pg, P.parseArgs(['project-files', 'add', '--project', 'no such project', mk('z.txt')]), deps).catch((e) => { throw e; }).then((c) => c, (e) => e.message));
  check('unknown project name = refused before any write', typeof r2.code === 'string' ? /no project named/.test(r2.code) : false, String(r2.code));

  pg = fakePage(files3);
  r2 = await quiet(() => P.projectFilesCmd(pg, P.parseArgs(['project-files', 'wipe', '--project', B]), deps));
  check('unknown sub = usage, exit 1, no read', r2.code === 1 && pg.reads.length === 0, r2.out);

  const instr = mk('instr.md'); fs.writeFileSync(instr, 'ทดสอบ\nline 2\n');
  pg = fakePage(files3, 'ทดสอบ\nline 2\n');
  r2 = await quiet(() => P.projectInstructionsCmd(pg, P.parseArgs(['project-instructions', 'set', '--project', B, instr]), deps));
  check('set to the same text = unchanged, exit 0, no write', r2.code === 0 && /unchanged/.test(r2.out), r2.out);

  const empty = mk('empty.md', 0);
  pg = fakePage(files3, 'old');
  r2 = await quiet(() => P.projectInstructionsCmd(pg, P.parseArgs(['project-instructions', 'set', '--project', B, empty]), deps));
  check('set from an empty file = refuse (never blank them)', r2.code === 1 && /empty/.test(r2.out), r2.out);

  const outF = path.join(dir, 'got.md');
  pg = fakePage(files3, 'ทดสอบ\n"q" & <a>\n');
  r2 = await quiet(() => P.projectInstructionsCmd(pg, P.parseArgs(['project-instructions', 'get', '--project', B, outF]), deps));
  check('get → file byte-equal', r2.code === 0 && fs.readFileSync(outF, 'utf-8') === 'ทดสอบ\n"q" & <a>\n', r2.out);

  r2 = await quiet(() => P.newProjectChat(fakePage(files3), P.parseArgs(['new-chat', '--project', B]), { sendAndConfirm: async () => { throw new Error('sent'); } }));
  check('new-chat --project without --title = exit 1, nothing sent', r2.code === 1 && /--title/.test(r2.out), r2.out);

  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`${results.length - failed}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
})();
