# ig-bridge — Instagram posting over MQTT (T2445)

`ig-agent.mjs` (pm2 `ig-bridge`) listens on MQTT and drives instagram.com in แบงค์'s Chrome over CDP :9222 with real
input events. `ig-post.sh` is the CLI (like `gemini-gen.sh`). Plan: BoB-Oracle/output/plans/T2445-ig-mqtt-posting-bridge.md

| topic | |
|---|---|
| `claude/browser/ig/command` | `{"id","action",...}` |
| `claude/browser/ig/response` | one reply per command, same `id` |
| `claude/browser/ig/state` | current job (retained) |

Topics live under `claude/browser/` because the broker ACL only lets anonymous clients use that subtree —
`claude/ig/*` publishes "succeed" and are silently dropped. The gemini extension does not answer `claude/browser/ig/*` (probed).

## Accounts and browser contexts
Only the production account (`IG_BRIDGE_DEFAULT_CTX_USERS`, default `dreambankiagencyaia`) runs in แบงค์'s own Chrome
context. **Every other account runs in an isolated browser context** with its own cookie jar
(`~/.oracle/ig-bridge/jar-<user>.json`, 0600) — a test login can never switch or log out DreamBank. No jar = refused.
One-time setup per test account: `ig-post.sh login <user>` opens a login window (isolated context); a human signs in
there (password/2FA never pass through the bridge); the cookies are saved and refreshed after every job.

## Stories
`post_story` uses instagram.com in iPhone emulation (desktop has no Story composer): "+" → Story → file → editor →
READY; `share` taps "Share story" and reads back the account's live story items. `--music` is Phase 1b and
currently STOPs unless the sticker tray shows Music (tray stayed "Loading…" in bob's probe).

## Facebook page story + swipe-up link (T2461)
`post_fb_story` posts a **Facebook page** story with a link, through Meta Business Suite web (own tab, แบงค์'s
session). Instagram stories cannot carry a link from the web — MBS says "This feature is not supported by
Instagram" and the mobile-web IG editor has no Link sticker (probed 2 Oct 2026) — so IG link stories go via the phone.
- Identity: page id/name come from the Graph page token; the page's linked IG username must equal `--user` (production account only).
- PREPARE: composer on that page → upload → **Share to = the page only** (MBS pre-selects the linked IG account too;
  the IG account is unticked and the field is re-read) → Add link → URL typed → Apply → the link dialog is re-opened and read back
  (screenshot `<id>-link.png`) → "Share now" must be the selected option → Share must be enabled (MBS greys it out instead of
  failing, e.g. a video over **30 s** — the Facebook story limit, shown by MBS 2 Oct 2026) → READY. No custom link text: the link dialog has one URL field and no label
  field (what the viewer button says is set by Facebook, not by us).
- SHARE (`share` with confirm): re-checks Share to + link on the live composer, clicks Share, then Graph must show a
  fresh page story AND its viewer must carry an `l.facebook.com/l.php?u=` link equal to the requested URL →
  `SHARED`. Otherwise `SHARED_UNVERIFIED` (no story) / `SHARED_LINK_UNVERIFIED` (story, link not proven). Other
  external anchors in the viewer (a Reader Mode extension injects some) are reported as `other`, never counted.
- On `SHARED_LINK_UNVERIFIED`: the story is live — open the story URL in the state (`ig-post.sh state` →
  `readback.newest.url`), tap the link by hand; if it is missing or wrong, delete the story in MBS and post again.

### Runbook — one FB page story with a link
```bash
cd ~/repos/github.com/BankCurfew/gemini-proxy-tools/ig-bridge
./ig-post.sh fb-story "<video ≤30 s or image>" --user dreambankiagencyaia --link https://journey.iagencyaia.com
#   → READY + two screenshots in ~/.maw/inbox/ig-bridge/: <id>-ready.png (target = page only) and <id>-link.png (URL)
#   → any FAILED: read `error` (e.g. "Share is disabled: … can be up to 30 seconds"); nothing was posted
./ig-post.sh share <id>      # the GO: publishes, then Graph + viewer readback; exit 0 only on SHARED
./ig-post.sh abort           # instead of share: closes the tab, nothing posted
./ig-post.sh state           # readback detail: readback.newest (story) + viewer.links / viewer.rendered
```

## Two-step, always
`post_carousel` / `post_reel` only PREPARE: checks + screenshot, stop before Share. Posting needs a second command
`share` with `confirm:<prepare id>`. READY requires: logged-in user == expectUser · media count == files · crop within 2% ·
caption box text == caption. After share: readback via instagram.com's web API → `SHARED` or `SHARED_WITH_DEFECT`
(one automatic caption repair). Accounts must be in `IG_BRIDGE_ALLOW`.

```bash
ig-post.sh carousel ./slides --user <acct> --caption-file cap.txt --ratio 4:5   # → READY + screenshot path
ig-post.sh share <prepare-id>
ig-post.sh story ./s.png --user <acct>
ig-post.sh fb-story ./s.png --user <acct> --link https://tools.iagencyaia.com/ijourney   # FB page story + link
ig-post.sh login <acct>
ig-post.sh abort
ig-post.sh edit https://www.instagram.com/p/<code>/ --user <acct> --caption-file cap.txt
ig-post.sh state
```
Log: `~/.oracle/ig-bridge/actions.jsonl` · screenshots: `~/.maw/inbox/ig-bridge/` · tests: `node --test ig-bridge/test/*.test.mjs` (the bare directory form runs nothing)
