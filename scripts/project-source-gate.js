// T4249 F2 (security 15 Nov 2569, on gemini-proxy-tools#69): what may go up as a ChatGPT Project source.
// Sources upload to OpenAI and stay there, so each one must be content the pre-push secret/PII scan has read.
// That scan reads text only (it skips binaries), so:
//   md / txt  → tracked, unchanged since its last commit, and that commit is on a remote (pushed)
//   pdf       → same, plus ONE of: a text twin `X.pdf.txt` (pushed, = fresh `pdftotext -layout X.pdf`, and
//               ≥ 100 non-space chars on EVERY page: less = a scanned page whose text the scanner can't read) · or a public
//               source `X.pdf.url` (pushed, one https URL)
//   png/jpg/jpeg/webp/gif → same, and only from a brand-asset folder named `project-sources` or `*-project-sources`
//   anything else (docx, xlsx, zip …) → refused: export it to md
// Every path (source, twin, .url) must be its own real path: no symlink anywhere in it, and nothing under ψ/.
// All-or-nothing: the caller uploads nothing when any file is refused. git/pdftotext/pdfinfo run with argv, no shell.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TEXT_EXT = new Set(['.md', '.txt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MIN_CHARS_PER_PAGE = 100;
const BRAND_DIR_RE = /^(.+-)?project-sources$/;

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
const isLink = (f) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** S1/S2 (security on #70): git tracks a symlink's link text, the upload reads its target, so a tracked + pushed
 *  link can carry an untracked file from anywhere. Refuse any link in the path; refuse anything under ψ/ (C1). */
function realProblem(file) {
  const base = path.basename(file);
  let real;
  try { real = fs.realpathSync(file); } catch { return `${base}: cannot resolve the path (missing file or broken link)`; }
  if (real !== file) return `${base}: is or sits under a symlink (${file} → ${real}); use the real file`;
  if (real.split(path.sep).includes('ψ')) return `${base}: is under ψ/ (oracle brain files never go up as sources)`;
  return null;
}

/** null when the file is tracked, unchanged since its last commit, and that commit is on a remote; else the reason. */
function pushedProblem(file) {
  const dir = path.dirname(file); const base = path.basename(file);
  let top;
  try { top = run('git', ['rev-parse', '--show-toplevel'], dir).toString().trim(); } catch { return 'not in a git repo'; }
  const rel = path.relative(top, file);
  try { run('git', ['ls-files', '--error-unmatch', '--', rel], top); } catch { return `${base} is not tracked in git`; }
  try { run('git', ['diff', '--quiet', 'HEAD', '--', rel], top); } catch { return `${base} changed since its last commit`; }
  const c = run('git', ['log', '-1', '--format=%H', '--', rel], top).toString().trim();
  const remotes = run('git', ['for-each-ref', '--contains', c, '--format=%(refname)', 'refs/remotes'], top).toString().trim();
  if (!remotes) return `${base} is not pushed (its commit ${c.slice(0, 8)} is on no remote)`;
  return null;
}

function pdfProblem(file) {
  const base = path.basename(file);
  const url = file + '.url'; const twin = file + '.txt';
  if (fs.existsSync(url) || isLink(url)) {
    const p = realProblem(url) || pushedProblem(url); if (p) return `public source: ${p}`;
    if (!/^https:\/\/\S+\s*$/.test(fs.readFileSync(url, 'utf8'))) return `${base}.url must hold one https URL`;
    return null;
  }
  if (!fs.existsSync(twin) && !isLink(twin)) return `${base}: no text twin (${base}.txt from pdftotext -layout) and no public ${base}.url`;
  const p = realProblem(twin) || pushedProblem(twin); if (p) return `text twin: ${p}`;
  let fresh;
  try { fresh = run('pdftotext', ['-layout', file, '-']); } catch { return `${base}: pdftotext could not read it`; }
  const saved = fs.readFileSync(twin);
  if (sha256(fresh) !== sha256(saved)) return `${base}: text twin ${base}.txt does not match the PDF now (regenerate it with pdftotext -layout and push both)`;
  let pages;
  try { pages = Number((run('pdfinfo', [file]).toString().match(/^Pages:\s+(\d+)/m) || [])[1]); } catch { pages = NaN; }
  if (!(pages > 0)) return `${base}: pdfinfo could not count the pages`;
  // EVERY page, not the average (DocCon F1 on #70): pdftotext ends each page with \f, so one text page cannot carry
  // image-only pages the scanner never reads. A page missing from the twin counts as 0.
  const perPage = saved.toString('utf8').split('\f');
  const thin = [];
  for (let i = 0; i < pages; i++) { const n = (perPage[i] || '').replace(/\s/g, '').length; if (n < MIN_CHARS_PER_PAGE) thin.push(`page ${i + 1}: ${n}`); }
  if (thin.length) return `${base}: ${thin.length} of ${pages} page(s) under ${MIN_CHARS_PER_PAGE} chars (${thin.slice(0, 5).join(', ')}${thin.length > 5 ? ' …' : ''}): image-only pages can't be scanned`;
  return null;
}

/** files → { ok, refused: [{ name, reason }] }. Every file is checked; any refusal = ok false. */
function checkSources(files) {
  const refused = [];
  for (const f0 of files) {
    const file = path.resolve(f0); const name = path.basename(file); const ext = path.extname(file).toLowerCase();
    let why = realProblem(file);
    if (why) { refused.push({ name, reason: why }); continue; }
    if (TEXT_EXT.has(ext)) why = pushedProblem(file);
    else if (ext === '.pdf') why = pushedProblem(file) || pdfProblem(file);
    else if (IMAGE_EXT.has(ext)) {
      const dirs = path.dirname(file).split(path.sep);
      why = dirs.some((d) => BRAND_DIR_RE.test(d)) ? pushedProblem(file)
        : `${name}: images only from a brand-asset folder named project-sources or *-project-sources`;
    } else why = `${name}: ${ext || 'no extension'} is not a source type (md, txt, pdf, images): export it to md`;
    if (why) refused.push({ name, reason: why });
  }
  return { ok: refused.length === 0, refused };
}

module.exports = { checkSources, MIN_CHARS_PER_PAGE, BRAND_DIR_RE };
