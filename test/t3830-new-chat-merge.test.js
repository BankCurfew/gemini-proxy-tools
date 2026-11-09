#!/usr/bin/env node
// T3830 (designer 9 Nov, 3rd time after ijourney ebf878b + dreambank-carousel 3f2b63c): new-chat must MERGE into the brand
// entry (a dropped base_brand = T599 ABORT on every send) and a brand with a Project must start in that Project.
//   node test/t3830-new-chat-merge.test.js
'use strict';
const { brandEntryAfterNewChat, newChatStartUrl } = require('../scripts/poster');
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const motivation = {   // poster.config.json brands.iagencyaia-motivation before 9 Nov (6ab8d30e)
  chat_id: '6ab8d30e-a934-83ec-a076-8a73da6a5e26', base_brand: 'iagencyaia', title: 'MOTIVATION · Series 2026-09',
  project: 'iAgencyAIA', created: '2026-09-27', set_by: 'designer T2301 (bob chats)', note: 'ONE chat for all MOTIVATION posters',
};
const projects = { iAgencyAIA: 'g-p-6a548bcae0f481918286e9fb63633e98' };

check('functions exported', typeof brandEntryAfterNewChat === 'function' && typeof newChatStartUrl === 'function');
if (typeof brandEntryAfterNewChat === 'function') {
  const e = brandEntryAfterNewChat(motivation, '6af12fbf-35dc-83ec-9c2c-87a7d901bd4d', '2026-11-09T02:28:20.604Z');
  check('every existing field kept', ['base_brand', 'title', 'project', 'set_by', 'note'].every((k) => e[k] === motivation[k]),
    JSON.stringify(Object.keys(e)));
  check('new chat_id + created', e.chat_id === '6af12fbf-35dc-83ec-9c2c-87a7d901bd4d' && e.created === '2026-11-09T02:28:20.604Z');
  check('old chat_id kept as previous_chat_id', e.previous_chat_id === motivation.chat_id);
  check('input not mutated', motivation.chat_id === '6ab8d30e-a934-83ec-a076-8a73da6a5e26' && !('previous_chat_id' in motivation));
  const fresh = brandEntryAfterNewChat(undefined, 'aaaa', 't');   // a brand new-chat creates for the first time
  check('new brand = chat_id + created only', JSON.stringify(fresh) === JSON.stringify({ chat_id: 'aaaa', created: 't' }), JSON.stringify(fresh));
}
if (typeof newChatStartUrl === 'function') {
  check('project brand starts on its Project page',
    newChatStartUrl(motivation, projects) === 'https://chatgpt.com/g/g-p-6a548bcae0f481918286e9fb63633e98/project');
  check('no project = ChatGPT home', newChatStartUrl({ base_brand: 'wealthbanks' }, projects) === 'https://chatgpt.com/');
  check('new brand (no entry) = ChatGPT home', newChatStartUrl(undefined, projects) === 'https://chatgpt.com/');
  let threw = '';
  try { newChatStartUrl({ project: 'Unknown' }, projects); } catch (err) { threw = err.message; }
  check('project named but no id configured = refuse (never silently outside it)', /projects\.Unknown/.test(threw), threw);
  threw = '';
  try { newChatStartUrl({ project: 'Bad' }, { Bad: 'javascript:alert(1)' }); } catch (err) { threw = err.message; }
  check('project id must look like g-p-<hex>', /g-p-/.test(threw), threw);
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
