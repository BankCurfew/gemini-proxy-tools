// T4249 F2 (security 15 Nov 2569, on gemini-proxy-tools#69): what may go up as a ChatGPT Project source.
// Sources upload to OpenAI and stay there, so each one must be content the pre-push secret/PII scan has read.
// That scan reads text only (it skips binaries), so:
//   md / txt  → tracked, unchanged since its last commit, and that commit is on a remote (pushed)
//   pdf       → same, plus ONE of: a text twin `X.pdf.txt` (pushed, = fresh `pdftotext -layout X.pdf`, and
//               ≥ 100 non-space chars per page: less = a scan whose text the scanner can't read) · or a public
//               source `X.pdf.url` (pushed, one https URL)
//   png/jpg/jpeg/webp/gif → same, and only from a brand-asset folder named `project-sources` or `*-project-sources`
//   anything else (docx, xlsx, zip …) → refused: export it to md
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
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
  if (fs.existsSync(url)) {
    const p = pushedProblem(url); if (p) return `public source: ${p}`;
    if (!/^https:\/\/\S+\s*$/.test(fs.readFileSync(url, 'utf8'))) return `${base}.url must hold one https URL`;
    return null;
  }
  if (!fs.existsSync(twin)) return `${base}: no text twin (${base}.txt from pdftotext -layout) and no public ${base}.url`;
  const p = pushedProblem(twin); if (p) return `text twin: ${p}`;
  let fresh;
  try { fresh = run('pdftotext', ['-layout', file, '-']); } catch { return `${base}: pdftotext could not read it`; }
  const saved = fs.readFileSync(twin);
  if (sha256(fresh) !== sha256(saved)) return `${base}: text twin ${base}.txt does not match the PDF now (regenerate it with pdftotext -layout and push both)`;
  let pages;
  try { pages = Number((run('pdfinfo', [file]).toString().match(/^Pages:\s+(\d+)/m) || [])[1]); } catch { pages = NaN; }
  if (!(pages > 0)) return `${base}: pdfinfo could not count the pages`;
  const chars = saved.toString('utf8').replace(/\s/g, '').length;
  if (chars < MIN_CHARS_PER_PAGE * pages) return `${base}: ${chars} chars over ${pages} page(s) < ${MIN_CHARS_PER_PAGE} chars per page (image-only PDF: its text can't be scanned)`;
  return null;
}

/** files → { ok, refused: [{ name, reason }] }. Every file is checked; any refusal = ok false. */
function checkSources(files) {
  const refused = [];
  for (const f0 of files) {
    const file = path.resolve(f0); const name = path.basename(file); const ext = path.extname(file).toLowerCase();
    let why;
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
