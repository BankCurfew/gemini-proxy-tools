#!/usr/bin/env node
// T4279 (bob 15 Nov, designer map §4.2): poster.js create-project + move-chat — the pure parts.
//   flags parse · config after create (idempotent, same name other id = refuse) · config after move (unknown brand /
//   unknown project = refuse with a fix line, config untouched) · atomic write keeps every other byte.
//   node test/t4279-project-cmds.test.js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const P = require('../scripts/poster-projects');
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

const WB = 'g-p-' + 'a'.repeat(32), IA = 'g-p-6a548bcae0f481918286e9fb63633e98';
const base = () => ({
  cdp_url: 'http://localhost:9222',
  brands: {
    wealthbanks: { chat_id: '11111111-1111-1111-1111-111111111111', title: 'WB' },
    'iagencyaia-newsad': { chat_id: '22222222-2222-2222-2222-222222222222', project: 'iAgencyAIA' },
    nochat: { title: 'x' },
  },
  projects: { iAgencyAIA: IA },
});

// ── parseArgs ──
let a = P.parseArgs(['create-project', '--name', 'WB · WealthBanks', '--instructions-file', 'i.md']);
check('create-project: --name + --instructions-file, no sub', a.name === 'WB · WealthBanks' && a.instructionsFile === 'i.md' && a.sub === null && !a.rest.length, JSON.stringify(a));
a = P.parseArgs(['create-project', '--name=DB · DreamBank']);
check('create-project: --name=<v>', a.name === 'DB · DreamBank');
a = P.parseArgs(['move-chat', '--brand', 'wealthbanks', '--project', 'WB · WealthBanks']);
check('move-chat: --project, --brand left to poster.js, no sub', a.project === 'WB · WealthBanks' && a.sub === null && !a.rest.length, JSON.stringify(a));
check('--name without a value = refuse', /--name needs a value/.test(throws(() => P.parseArgs(['create-project', '--name']))));
check('create-project with a stray word = refuse', /unexpected argument/.test(throws(() => P.parseArgs(['create-project', '--name', 'X', 'oops']))));
a = P.parseArgs(['project-files', 'add', '--project', 'X', 'f.md']);
check('project-files still takes its sub + files', a.sub === 'add' && a.rest[0] === 'f.md');

// ── configWithProject ──
let r = P.configWithProject(base(), 'WB · WealthBanks', WB);
check('new project → projects.<name> added, changed', r.changed && r.next.projects['WB · WealthBanks'] === WB && r.next.projects.iAgencyAIA === IA);
check('…and the brands are the same object content', JSON.stringify(r.next.brands) === JSON.stringify(base().brands));
r = P.configWithProject(base(), 'iAgencyAIA', IA);
check('same name, same id = no change (idempotent)', !r.changed && JSON.stringify(r.next) === JSON.stringify(base()));
let m = throws(() => P.configWithProject(base(), 'iAgencyAIA', WB));
check('same name, other id = refuse + fix line', /already projects\.iAgencyAIA = g-p-6a54/.test(m) && /fix: /.test(m), m);
check('bad id = refuse', /g-p-<32 hex>/.test(throws(() => P.configWithProject(base(), 'X', 'g-p-123'))));
check('empty name = refuse', /--name/.test(throws(() => P.configWithProject(base(), '  ', WB))));
r = P.configWithProject({ brands: {} }, 'X', WB);
check('config with no projects key → created', r.changed && r.next.projects.X === WB);

// ── configWithBrandProject ──
const withWB = P.configWithProject(base(), 'WB · WealthBanks', WB).next;
r = P.configWithBrandProject(withWB, 'wealthbanks', 'WB · WealthBanks');
check('move → brands.<b>.project set, other brand keys kept', r.changed && r.next.brands.wealthbanks.project === 'WB · WealthBanks' && r.next.brands.wealthbanks.title === 'WB' && r.gid === WB, JSON.stringify(r.next.brands.wealthbanks));
r = P.configWithBrandProject(base(), 'iagencyaia-newsad', 'iAgencyAIA');
check('already there = no change', !r.changed && r.gid === IA);
check('brand is case-folded like --brand', P.configWithBrandProject(withWB, 'WealthBanks', 'WB · WealthBanks').changed);
m = throws(() => P.configWithBrandProject(base(), 'nosuch', 'iAgencyAIA'));
check('unknown brand = refuse + fix line', /brand "nosuch" is not in poster.config.json/.test(m) && /fix: /.test(m), m);
m = throws(() => P.configWithBrandProject(base(), 'nochat', 'iAgencyAIA'));
check('brand without chat_id = refuse + fix line', /no chat_id/.test(m) && /fix: node poster.js new-chat --brand nochat/.test(m), m);
m = throws(() => P.configWithBrandProject(base(), 'wealthbanks', 'WB · WealthBanks'));
check('unknown project = refuse + fix line (create it first)', /no projects\["WB · WealthBanks"\]/.test(m) && /fix: node poster.js create-project --name "WB · WealthBanks"/.test(m), m);
check('empty brand = refuse', /--brand/.test(throws(() => P.configWithBrandProject(base(), '', 'iAgencyAIA'))));

// ── writeConfigAtomic ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't4279-'));
const real = path.join(__dirname, '..', 'scripts', 'poster.config.json');
const f = path.join(dir, 'poster.config.json');
fs.copyFileSync(real, f);
const before = fs.readFileSync(f, 'utf-8');
P.writeConfigAtomic(f, JSON.parse(before));
check('round trip of the real config = byte-identical', fs.readFileSync(f, 'utf-8') === before);
const next = P.configWithProject(JSON.parse(before), 'WB · WealthBanks', WB).next;
P.writeConfigAtomic(f, next);
const after = fs.readFileSync(f, 'utf-8');
const oldLines = before.split('\n'); const newLines = after.split('\n');
const added = newLines.filter((l) => !oldLines.includes(l));
check('adding one project = only that line added (+ the comma on the line before)', added.length <= 2 && added.some((l) => l.includes('"WB · WealthBanks": "' + WB + '"')), JSON.stringify(added));
check('no temp file left behind', fs.readdirSync(dir).length === 1, fs.readdirSync(dir).join(','));
const h = md5(f);
throws(() => P.configWithBrandProject(JSON.parse(after), 'nosuch', 'WB · WealthBanks'));
check('a refusal writes nothing (md5 same)', md5(f) === h);

const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} pass`);
process.exit(fails ? 1 : 0);
