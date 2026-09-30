#!/usr/bin/env node
const path=require('path');
const PP='/home/curfew/.npm/_npx/7d92d9a2d2ccc630/node_modules';
const puppeteer=require(path.join(PP,'puppeteer'));
const cfg=require('/home/curfew/repos/github.com/BankCurfew/gemini-proxy-tools/scripts/poster.config.json');
(async()=>{
  const b=await puppeteer.connect({browserURL:cfg.cdp_url,defaultViewport:null,protocolTimeout:cfg.cdp_protocol_timeout});
  const p=await b.newPage();
  await p.goto('https://chatgpt.com/c/'+cfg.brands.iagencyaia.chat_id,{waitUntil:'domcontentloaded',timeout:25000});
  console.log('opened',cfg.brands.iagencyaia.chat_id);
  try { await p.close(); } catch {}
  await b.disconnect();
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
