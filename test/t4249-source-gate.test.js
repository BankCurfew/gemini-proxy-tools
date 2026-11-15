// T4249 F2 (security 15 Nov, #69): what may go up as a ChatGPT Project source. The pre-push scan reads text only
// (binaries are skipped), so every source must be text the scan read, or carry proof that its content was checked.
// Temp git repo + bare origin, no Chrome.
//   OK   md pushed · pdf + text twin pushed (twin = fresh pdftotext) · pdf + public .url pushed · jpg in *-project-sources/ pushed
//   REFUSE md untracked · md committed not pushed · md changed after push · pdf no twin/url · pdf twin stale
//          (pdf changed after twin) · pdf image-only (twin under 100 chars/page) · jpg outside a *-project-sources/ folder
//          · docx anywhere · .url that is not https · one bad file refuses the whole call (all-or-nothing)
//   node test/t4249-source-gate.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkSources } = require('../scripts/project-source-gate.js');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Minimal PDF; `lines` = text lines drawn with Helvetica on one page (none = a page with no text, like a scan),
// or an array of such arrays = one page each.
function pdf(lines) {
  const pages = Array.isArray(lines[0]) ? lines : [lines];
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const stream = (ls) => { const c = ls.length ? `BT /F1 10 Tf 12 TL 40 750 Td ${ls.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET` : ''; return `<< /Length ${Buffer.byteLength(c)} >>\nstream\n${c}\nendstream`; };
  const n = pages.length; const pageObj = (i) => 4 + i * 2; const contentObj = (i) => 5 + i * 2;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((ls, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
    objs.push(stream(ls));
  });
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return out;
}
const TEXT = Array.from({ length: 6 }, (_, i) => `Brand reference line ${i + 1}: campus colours, logo spacing and photo style notes.`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't4249-gate-'));
const origin = path.join(root, 'origin.git'); const repo = path.join(root, 'repo');
execFileSync('git', ['init', '-q', '--bare', origin]);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
git(repo, 'remote', 'add', 'origin', origin);
const w = (rel, data) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const twin = (rel) => execFileSync('pdftotext', ['-layout', path.join(repo, rel), path.join(repo, rel + '.txt')]);
const commit = (msg) => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); };
const push = () => git(repo, 'push', '-q', 'origin', 'main');

// pushed state
const okMd = w('pack/BIBLE.md', '# Bible\nbrand notes\n');
const okPdf = w('pack/brochure.pdf', pdf(TEXT)); twin('pack/brochure.pdf');
const okUrl = w('pack/public.pdf', pdf([])); w('pack/public.pdf.url', 'https://www.aia.co.th/th/brochure.pdf\n');
const okJpg = w('output/t1/acep-project-sources/sheets/01.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
const badJpg = w('output/t1/other/01.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]));
const docx = w('output/t1/acep-project-sources/brief.docx', 'PK\x03\x04fake');
const noTwin = w('pack/no-twin.pdf', pdf(TEXT));
const scan = w('pack/scan.pdf', pdf([])); twin('pack/scan.pdf');
const stale = w('pack/stale.pdf', pdf(TEXT)); twin('pack/stale.pdf');
const httpUrl = w('pack/http.pdf', pdf([])); w('pack/http.pdf.url', 'http://example.com/x.pdf\n');
const changed = w('pack/changed.md', 'v1\n');
// DocCon F1 / security F3: the floor is per page. 1 dense + 2 image-only pages (total over 3 x 100) must be refused.
const mixed = w('pack/mixed.pdf', pdf([TEXT, [], []])); twin('pack/mixed.pdf');
const threeText = w('pack/three-text.pdf', pdf([TEXT, TEXT, TEXT])); twin('pack/three-text.pdf');
// S1 (security probe): tracked + pushed symlinks whose target is an untracked file OUTSIDE the repo
const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.md'), 'untracked, never scanned\n');
fs.writeFileSync(path.join(outside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const lnk = (rel, target) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.symlinkSync(target, f); return f; };
const linkMd = lnk('pack/link.md', path.join(outside, 'secret.md'));
const linkPng = lnk('output/t1/x-project-sources/link.png', path.join(outside, 'secret.png'));
const linkTwinPdf = w('pack/linktwin.pdf', pdf(TEXT));
execFileSync('pdftotext', ['-layout', linkTwinPdf, path.join(outside, 'linktwin.pdf.txt')]);
lnk('pack/linktwin.pdf.txt', path.join(outside, 'linktwin.pdf.txt'));
fs.writeFileSync(path.join(outside, 'linkurl.pdf.url'), 'https://www.aia.co.th/x.pdf\n');
const linkUrlPdf = w('pack/linkurl.pdf', pdf([])); lnk('pack/linkurl.pdf.url', path.join(outside, 'linkurl.pdf.url'));
// S2: ψ/ is pushed in oracle repos, but C1 says no ψ/ files as sources
const psi = w('ψ/memory/note.md', 'oracle brain note\n');
commit('pushed state'); push();
// after the push
w('pack/stale.pdf', pdf(TEXT.concat(['one more line added after the twin was made'])));
commit('stale: pdf changed, twin not regenerated'); push();
const local = w('pack/local.md', 'committed, not pushed\n'); commit('local only');
const untracked = w('pack/untracked.md', 'never added\n');
w('pack/changed.md', 'v2 not committed\n');

let fails = 0; let total = 0;
const check = (ok, name, got) => { total++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${got}`); if (!ok) fails++; };
const one = (f) => checkSources([f]);
const okCase = (name, f) => { const r = one(f); check(r.ok, `OK ${name}`, r.ok ? 'ok' : JSON.stringify(r.refused)); };
const noCase = (name, f, re) => { const r = one(f); const why = r.refused.map((x) => x.reason).join(' | '); check(!r.ok && re.test(why), `REFUSE ${name}`, why || 'NOT refused'); };

okCase('md pushed', okMd);
okCase('pdf + text twin pushed', okPdf);
okCase('pdf + https .url pushed', okUrl);
okCase('jpg in *-project-sources/ pushed', okJpg);
noCase('md untracked', untracked, /not tracked/);
noCase('md committed, not pushed', local, /not pushed/);
noCase('md changed after push', changed, /changed since/);
noCase('pdf without twin or .url', noTwin, /no text twin/);
noCase('pdf twin stale', stale, /twin .*does not match/);
noCase('pdf image-only (floor)', scan, /page 1 image-only/);
noCase('pdf 1 dense + 2 image-only pages, total over the floor (per page, names the pages)', mixed, /pages 2, 3 image-only/);
okCase('pdf 3 text pages + twin pushed', threeText);
const mixedChars = fs.readFileSync(mixed + '.txt', 'utf8').replace(/\s/g, '').length;
check(mixedChars >= 300, 'control: the mixed PDF total is over 3 pages x 100 (an average check would pass it)', `${mixedChars} chars`);
noCase('pdf .url not https', httpUrl, /https/);
noCase('jpg outside a project-sources folder', badJpg, /project-sources/);
noCase('docx', docx, /export it to md/);
noCase('S1 tracked symlink .md → untracked file outside the repo', linkMd, /symlink/);
noCase('S1 symlink .png in a *-project-sources folder', linkPng, /symlink/);
noCase('S1 pdf whose text twin is a symlink', linkTwinPdf, /symlink/);
noCase('S1 pdf whose .url is a symlink', linkUrlPdf, /symlink/);
noCase('S2 pushed file under ψ/', psi, /ψ/);
const all = checkSources([okMd, okPdf, badJpg]);
check(!all.ok && all.refused.length === 1 && all.refused[0].name === '01.jpg', 'REFUSE one bad file refuses the call, names only it', JSON.stringify(all.refused.map((x) => x.name)));
const fresh = execFileSync('pdftotext', ['-layout', okPdf, '-']);
check(fresh.equals(fs.readFileSync(okPdf + '.txt')), 'control: pdftotext to stdout = the twin file the SOP command writes', `${fresh.length} B`);

// wired into project-files add: a refused file stops the command before it touches the page (nothing uploaded)
const { projectFilesCmd } = require('../scripts/poster-projects.js');
let touched = 0;
const page = new Proxy({}, { get: () => { touched++; throw new Error('page touched'); } });
(async () => {
  let rc;
  try { rc = await projectFilesCmd(page, { sub: 'add', project: 'X', rest: [okMd, docx] }, { browserPath: async (_, f) => f, dryRun: true }); } catch (e) { rc = 'threw: ' + e.message; }
  check(rc === 1 && touched === 0, 'REFUSE project-files add with one bad file: rc 1, page never touched', `rc ${rc}, page touches ${touched}`);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`T4249-source-gate ${total - fails}/${total} ${fails ? 'FAIL' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
})();
