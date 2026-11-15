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

// ── C1 (security on #73): an instructions file goes to OpenAI like a source → same F2 gate (md/txt, tracked, pushed,
//    no symlink, no ψ/), checked before the browser, for create-project --instructions-file AND project-instructions set ──
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't4279c1-'));
  const cfg = path.join(tmp, 'poster.config.json'); fs.writeFileSync(cfg, JSON.stringify(base()));
  const untracked = path.join(tmp, 'i.md'); fs.writeFileSync(untracked, 'rules\n');
  const envf = path.join(tmp, '.env'); fs.writeFileSync(envf, 'KEY=x\n');
  const tracked = path.join(__dirname, '..', 'docs', 'SOP-IMAGE-GEN-V3.md');   // tracked + pushed in this repo
  const pc = (f) => P.precheck('create-project', { name: 'X', instructionsFile: f }, null, cfg);
  check('C1 create-project: untracked .md refused before the browser', /instructions/i.test(pc(untracked) || ''), pc(untracked));
  check('C1 create-project: .env refused', !!pc(envf), pc(envf));
  check('C1 create-project: positive control, tracked pushed .md passes', pc(tracked) === null, pc(tracked));
  const page = new Proxy({}, { get: () => { throw new Error('browser touched'); } });
  const sub = async (f) => { let out = ''; const e = console.error; console.error = (m) => { out += m; }; try { return [await P.projectInstructionsCmd(page, { sub: 'set', project: 'iAgencyAIA', rest: [f] }, { dryRun: true }), out]; } catch (x) { return ['threw', x.message]; } finally { console.error = e; } };
  const [rc1, m1] = await sub(untracked);
  check('C1 project-instructions set: untracked .md refused, browser untouched', rc1 !== 0 && rc1 !== 'threw', `${rc1} ${m1.slice(0, 120)}`);
  const [rc2, m2] = await sub(envf);
  check('C1 project-instructions set: .env refused, browser untouched', rc2 !== 0 && rc2 !== 'threw', `${rc2} ${m2.slice(0, 120)}`);
  const [rc3, m3] = await sub(tracked);
  check('C1 project-instructions set: positive control, tracked .md reaches the browser', rc3 === 'threw' && /browser touched/.test(m3), `${rc3} ${m3.slice(0, 80)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  // ── stale busy (15 Nov 22:2x live: dreambank-carousel newest reply in_progress for 19144 min → move-chat exit 75 forever) ──
  const NOW = 1_800_000_000;
  const mp = (...ms) => Object.fromEntries(ms.map((m, i) => [String(i), { message: { author: { role: m.role || 'assistant' }, status: m.status, create_time: m.t } }]));
  const cb = (m) => { try { return P.chatBusy(m, NOW); } catch (e) { return 'threw ' + e.message; } };
  check('busy: newest reply in_progress 2 min old = busy', cb(mp({ status: 'finished_successfully', t: NOW - 900 }, { status: 'in_progress', t: NOW - 120 })) === true, String(cb(mp({ status: 'in_progress', t: NOW - 120 }))));
  check('busy: newest reply in_progress 13 days old = stale, NOT busy', cb(mp({ status: 'in_progress', t: NOW - 19144 * 60 })) === false, String(cb(mp({ status: 'in_progress', t: NOW - 19144 * 60 }))));
  check('busy: newest finished = not busy', cb(mp({ status: 'in_progress', t: NOW - 300 }, { status: 'finished_successfully', t: NOW - 60 })) === false);
  check('busy: no assistant reply = not busy', cb(mp({ role: 'user', status: 'finished_successfully', t: NOW })) === false);
  const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} pass`);
process.exit(fails ? 1 : 0);
})();
