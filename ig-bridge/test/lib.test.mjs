// node --test ig-bridge/test/lib.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortcodeToPk, shortcodeFromUrl, captionExact, ratioOk, validateCommand, classifyReadback, validLink } from '../lib.mjs';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const pkToCode = pk => { let n = BigInt(pk), s = ''; while (n > 0n) { s = ALPHA[Number(n % 64n)] + s; n /= 64n; } return s; };

test('shortcode ↔ pk round-trips and rejects junk', () => {
  for (const pk of ['3456789012345678901', '1', '64', '2929999999999999999']) assert.equal(shortcodeToPk(pkToCode(pk)), pk);
  assert.equal(shortcodeToPk('B'), '1');
  assert.equal(shortcodeToPk('BA'), '64');
  assert.throws(() => shortcodeToPk('ab*c'));
});
test('shortcodeFromUrl handles p / reel / user-prefixed', () => {
  assert.equal(shortcodeFromUrl('https://www.instagram.com/p/DAbc_12-x/'), 'DAbc_12-x');
  assert.equal(shortcodeFromUrl('https://www.instagram.com/dreambank/reel/XYZ/'), 'XYZ');
  assert.equal(shortcodeFromUrl('https://www.instagram.com/dreambank/'), null);
});
test('caption compare: CRLF/nbsp/trailing space equal, any real change not', () => {
  assert.ok(captionExact('a\r\nb \n c', 'a\nb\n c'));
  assert.ok(!captionExact('a\nb', 'a b'));
  assert.ok(!captionExact('', 'x'));            // the 1/10 bug: box looked filled, IG stored nothing
});
test('ratio within 2% only', () => {
  assert.ok(ratioOk(0.80, '4:5').ok);
  assert.ok(ratioOk(0.81, '4:5').ok);
  assert.ok(!ratioOk(0.85, '4:5').ok);
  assert.ok(!ratioOk(0, '4:5').ok, 'unmeasured must fail, not pass');
  assert.ok(ratioOk(0, 'original').ok);
  assert.ok(!ratioOk(1.0, '9:16').ok);
});
const ok = { id: 'x', action: 'post_carousel', files: ['a.png', 'b.jpg'], ratio: '4:5', caption: 'hi', expectUser: 'tester' };
test('validate: allow-list, 20 cap, file types, share confirm', () => {
  assert.deepEqual(validateCommand(ok, { allowUsers: ['Tester'] }), []);
  assert.match(validateCommand(ok, { allowUsers: [] }).join(), /not in IG_BRIDGE_ALLOW/);
  assert.match(validateCommand({ ...ok, expectUser: 'dreambankiagencyaia' }, { allowUsers: ['tester'] }).join(), /not in IG_BRIDGE_ALLOW/);
  assert.match(validateCommand({ ...ok, files: Array(21).fill('a.png') }, { allowUsers: ['tester'] }).join(), /21 > 20/);
  assert.deepEqual(validateCommand({ ...ok, files: Array(20).fill('a.png') }, { allowUsers: ['tester'] }), []);
  assert.match(validateCommand({ ...ok, files: ['a.png', 'b.gif'] }, { allowUsers: ['tester'] }).join(), /not png\/jpg/);
  assert.match(validateCommand({ ...ok, ratio: '16:9' }, { allowUsers: ['tester'] }).join(), /ratio/);
  assert.match(validateCommand({ id: 's', action: 'share' }).join(), /confirm/);
  assert.deepEqual(validateCommand({ id: 's', action: 'share', confirm: 'x' }), []);
});
test('readback: exact = SHARED, caption-only defect flagged for retry, count defect not', () => {
  const exp = { mediaType: 8, count: 16, caption: 'line1\nline2' };
  assert.equal(classifyReadback(exp, { media_type: 8, carousel_media_count: 16, caption: 'line1\nline2' }).state, 'SHARED');
  const c = classifyReadback(exp, { media_type: 8, carousel_media_count: 16, caption: '' });
  assert.equal(c.state, 'SHARED_WITH_DEFECT'); assert.ok(c.captionOnly);
  const n = classifyReadback(exp, { media_type: 8, carousel_media_count: 10, caption: '' });
  assert.equal(n.state, 'SHARED_WITH_DEFECT'); assert.ok(!n.captionOnly);
  assert.equal(classifyReadback(exp, null).state, 'SHARED_UNVERIFIED');
});
test('validate: story + login need an allowed expectUser; music needs a query', () => {
  const a = { allowUsers: ['tester'] };
  assert.deepEqual(validateCommand({ id: 'x', action: 'post_story', file: 'C:\\s.png', expectUser: 'tester' }, a), []);
  assert.deepEqual(validateCommand({ id: 'x', action: 'post_story', file: 'C:\\s.mp4', expectUser: 'tester', music: { query: 'song' } }, a), []);
  assert.match(validateCommand({ id: 'x', action: 'post_story', file: 'C:\\s.gif', expectUser: 'tester' }, a).join(), /png\/jpg\/mp4/);
  assert.match(validateCommand({ id: 'x', action: 'post_story', file: 'C:\\s.png', expectUser: 'tester', music: {} }, a).join(), /music/);
  assert.match(validateCommand({ id: 'x', action: 'post_story', file: 'C:\\s.png', expectUser: 'dreambankiagencyaia' }, a).join(), /not in IG_BRIDGE_ALLOW/);
  assert.match(validateCommand({ id: 'x', action: 'login' }, a).join(), /expectUser required/);
  assert.deepEqual(validateCommand({ id: 'x', action: 'login', expectUser: 'tester' }, a), []);
});

test('post_fb_story: link required, https only, no custom text, allow-list applies (T2461)', () => {
  const ok = { id: 'f', action: 'post_fb_story', file: 'C:\\x\\a.png', link: 'https://tools.iagencyaia.com/ijourney', expectUser: 'dreambankiagencyaia' };
  const A = { allowUsers: ['dreambankiagencyaia'] };
  assert.deepEqual(validateCommand(ok, A), []);
  assert.deepEqual(validateCommand({ ...ok, file: 'C:\\x\\a.mp4' }, A), []);
  assert.match(validateCommand({ ...ok, link: undefined }, A).join(), /link/);
  assert.match(validateCommand({ ...ok, link: 'http://tools.iagencyaia.com/x' }, A).join(), /https/);
  assert.match(validateCommand({ ...ok, link: 'tools.iagencyaia.com/x' }, A).join(), /link/);
  assert.match(validateCommand({ ...ok, link: 'https://a.com/x y' }, A).join(), /link/);
  assert.match(validateCommand({ ...ok, linkText: 'ทำแบบทดสอบ' }, A).join(), /Visit link/);
  assert.match(validateCommand({ ...ok, file: 'a.gif' }, A).join(), /file/);
  assert.match(validateCommand(ok, { allowUsers: [] }).join(), /not in IG_BRIDGE_ALLOW/);
  assert.equal(validLink('https://localhost/x'), false);
  assert.equal(validLink('https://tools.iagencyaia.com/ijourney?src=story'), true);
});
