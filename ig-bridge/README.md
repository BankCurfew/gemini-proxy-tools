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

## Two-step, always
`post_carousel` / `post_reel` only PREPARE: checks + screenshot, stop before Share. Posting needs a second command
`share` with `confirm:<prepare id>`. READY requires: logged-in user == expectUser · media count == files · crop within 2% ·
caption box text == caption. After share: readback via instagram.com's web API → `SHARED` or `SHARED_WITH_DEFECT`
(one automatic caption repair). Accounts must be in `IG_BRIDGE_ALLOW`.

```bash
ig-post.sh carousel ./slides --user <acct> --caption-file cap.txt --ratio 4:5   # → READY + screenshot path
ig-post.sh share <prepare-id>
ig-post.sh story ./s.png --user <acct>
ig-post.sh login <acct>
ig-post.sh abort
ig-post.sh edit https://www.instagram.com/p/<code>/ --user <acct> --caption-file cap.txt
ig-post.sh state
```
Log: `~/.oracle/ig-bridge/actions.jsonl` · screenshots: `~/.maw/inbox/ig-bridge/` · tests: `node --test ig-bridge/test/`
