// graph.mjs — read a just-shared post back through the Graph API (production account, page token; never printed).
// bob/แบงค์ 1/10: DreamBank's first real Share must be confirmed by Graph readback, not by the web UI.
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { shortcodeFromUrl } from './lib.mjs';

const V = 'v21.0';
const TOKEN_FILE = process.env.IG_BRIDGE_GRAPH_TOKEN_FILE || path.join(os.homedir(), '.oracle/security/dreambank/page-token.long');
const TYPE = { IMAGE: 1, VIDEO: 2, CAROUSEL_ALBUM: 8 };   // → the web media_type codes classifyReadback compares against

export const graphAvailable = () => { try { fs.accessSync(TOKEN_FILE, fs.constants.R_OK); return true; } catch { return false; } };
const token = () => fs.readFileSync(TOKEN_FILE, 'utf8').trim();

// IPv6 is unreachable here and the IPv4 handshake to graph.facebook.com often takes >250 ms — Node's default
// per-address happy-eyeballs budget — so ~1 in 8 fetches died with ETIMEDOUT after ~430 ms (measured 2/10, T2461).
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

async function get(p, params = {}) {
  const u = new URL(`https://graph.facebook.com/${V}/${p}`);
  for (const [k, v] of Object.entries({ ...params, access_token: token() })) u.searchParams.set(k, v);
  let r;
  for (let i = 0; ; i++) {   // retry network failures only (no HTTP response); an API error is never retried
    try { r = await fetch(u); break; } catch (e) { if (i >= 2) throw new Error(`graph ${p}: network ${e.cause?.code || e.message}`); await new Promise(res => setTimeout(res, 1500)); }
  }
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

// ---------- Facebook page stories (T2461) ----------
let page = null;
/** The page the token belongs to: {id, name} — the MBS story composer is opened on this asset and must show this name. */
export async function pageIdentity() {
  if (!page) { const me = await get('me', { fields: 'id,name' }); page = { id: me.id, name: me.name }; }
  return page;
}

/** Facebook page stories created at/after sinceSec (−60s skew). Graph exposes no link field on a story — the link
 *  itself is read back in the story viewer (mbs-web.storyLinks); this only proves a story was published. */
export async function graphPageStories(sinceSec) {
  const { id } = await pageIdentity();
  const j = await get(`${id}/stories`, { fields: 'post_id,status,creation_time,media_type,url,media_id', limit: '10' });
  const items = j.data || [];
  const fresh = items.filter((x) => Number(x.creation_time) >= sinceSec - 60);
  return { total: items.length, fresh: fresh.length, newest: fresh[0] ? { post_id: fresh[0].post_id, status: fresh[0].status, created: Number(fresh[0].creation_time), media_type: fresh[0].media_type, url: fresh[0].url } : null, via: 'graph' };
}
