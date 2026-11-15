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

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
