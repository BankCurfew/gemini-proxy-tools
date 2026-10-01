// graph.mjs — read a just-shared post back through the Graph API (production account, page token; never printed).
// bob/แบงค์ 1/10: DreamBank's first real Share must be confirmed by Graph readback, not by the web UI.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shortcodeFromUrl } from './lib.mjs';

const V = 'v21.0';
const TOKEN_FILE = process.env.IG_BRIDGE_GRAPH_TOKEN_FILE || path.join(os.homedir(), '.oracle/security/dreambank/page-token.long');
const TYPE = { IMAGE: 1, VIDEO: 2, CAROUSEL_ALBUM: 8 };   // → the web media_type codes classifyReadback compares against

export const graphAvailable = () => { try { fs.accessSync(TOKEN_FILE, fs.constants.R_OK); return true; } catch { return false; } };
const token = () => fs.readFileSync(TOKEN_FILE, 'utf8').trim();

async function get(p, params = {}) {
  const u = new URL(`https://graph.facebook.com/${V}/${p}`);
  for (const [k, v] of Object.entries({ ...params, access_token: token() })) u.searchParams.set(k, v);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`graph ${p}: ${j.error?.message || 'HTTP ' + r.status}`);   // message only, never the URL (holds the token)
  return j;
}

let igId = null;
export async function igUser() {
  if (!igId) {
    const me = await get('me', { fields: 'instagram_business_account{id,username}' });
    igId = me.instagram_business_account;
    if (!igId) throw new Error('page token has no instagram_business_account');
  }
  return igId;   // {id, username}
}

const norm = (m) => ({
  id: m.id, code: shortcodeFromUrl(m.permalink), permalink: m.permalink, media_type: TYPE[m.media_type] ?? m.media_type,
  carousel_media_count: m.children?.data?.length ?? null, caption: m.caption ?? '', taken_at: Math.floor(Date.parse(m.timestamp) / 1000), via: 'graph',
});

/** Newest feed post published at/after sinceSec (−60s skew), or null. */
export async function graphFindNew(sinceSec) {
  const { id } = await igUser();
  const j = await get(`${id}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,children{id}', limit: '5' });
  const m = (j.data || []).find((x) => Date.parse(x.timestamp) / 1000 >= sinceSec - 60);
  return m ? norm(m) : null;
}

export async function graphMedia(mediaId) {
  return norm(await get(mediaId, { fields: 'id,caption,media_type,timestamp,permalink,children{id}' }));
}

/** Live story items published at/after sinceSec. */
export async function graphStories(sinceSec) {
  const { id } = await igUser();
  const j = await get(`${id}/stories`, { fields: 'id,media_type,timestamp,permalink' });
  const items = j.data || [];
  const fresh = items.filter((x) => Date.parse(x.timestamp) / 1000 >= sinceSec - 60);
  return { total: items.length, fresh: fresh.length, newest: fresh[0] ? { id: fresh[0].id, media_type: fresh[0].media_type, taken_at: fresh[0].timestamp } : null, via: 'graph' };
}

/** A recent post by its shortcode (edit_caption readback); looks at the last 25 posts. */
export async function graphFindByCode(code) {
  const { id } = await igUser();
  const j = await get(`${id}/media`, { fields: 'id,caption,media_type,timestamp,permalink,children{id}', limit: '25' });
  const m = (j.data || []).find((x) => shortcodeFromUrl(x.permalink) === code);
  if (!m) throw new Error(`post ${code} not in the last 25`);
  return norm(m);
}
