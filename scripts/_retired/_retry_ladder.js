#!/usr/bin/env node
// FINAL retry ladder (BoB): (1) gen, if error click Retry+refire; (2) if still fail, hard-reload tab (NOT logout) + retry once. Report discriminator + shot.
const path = require('path');
const PP = '/home/curfew/.npm/_npx/7d92d9a2d2ccc630/node_modules';
const puppeteer = require(path.join(PP,'puppeteer'));
const cfg = require('/home/curfew/repos/github.com/BankCurfew/gemini-proxy-tools/scripts/poster.config.json');
const fs = require('fs');
const OUT = '/home/curfew/repos/github.com/BankCurfew/Designer-Oracle/output/daily-news/2026-08-17/diag';
fs.mkdirSync(OUT,{recursive:true});

async function send(page, text){
  const box = await page.$('#prompt-textarea, div[contenteditable="true"]');
  if(!box) return false;
  await box.click({clickCount:1}); await new Promise(r=>setTimeout(r,400));
  await page.keyboard.type(text,{delay:6});
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  return true;
}
async function read(page){
  return page.evaluate(()=>{ const m=document.querySelector('main')||document.body; const t=(m.innerText||'').toLowerCase();
    const imgs=[...m.querySelectorAll('img')].filter(i=>(i.src||'').includes('oaiusercontent')).length;
    const quota=/image limit|rate limit|quota|you.?ve reached|hourly|daily limit/i.test(t)?'Q':'';
    const err=/something went wrong|please try again|an error occurred/i.test(t)?'E':'';
    return {imgs,quota,err,txt:t.slice(-200)}; });
}
(async()=>{
  const browser = await puppeteer.connect({browserURL:cfg.cdp_url,defaultViewport:null,protocolTimeout:cfg.cdp_protocol_timeout});
  const page = await browser.newPage();
  let navOk=false;
  for(const wu of ['domcontentloaded','load','commit']){ try{ await page.goto('https://chatgpt.com/?model=gpt-4o',{waitUntil:wu,timeout:20000}); navOk=true; break; }catch(e){} }
  if(!navOk){ console.log('CHAT_DEAD'); try { await page.close(); } catch {} await browser.disconnect(); process.exit(0); }
  await new Promise(r=>setTimeout(r,5000));

  const PROMPT='Generate an image of a plain red circle on white background. Just the image.';
  await send(page,PROMPT);
  let res='pending';
  // poll 50s
  for(let i=0;i<10;i++){ await new Promise(r=>setTimeout(r,5000)); const st=await read(page);
    if(st.imgs>0){res='(img) IMAGE after '+(i+1)*5+'s';break;}
    if(st.quota){res='(a) QUOTA :: '+st.txt;break;}
    if(st.err){res='ERR_FIRST';break;}
    if(i===9)res='SILENT_FIRST'; }
  let shot=path.join(OUT,'retry1-'+Date.now()+'.png'); await page.screenshot({path:shot});

  if(res==='ERR_FIRST' || res==='SILENT_FIRST'){
    // step 1: click Retry + refire
    const clicked = await page.evaluate(()=>{ const b=[...document.querySelectorAll('button')].find(x=>/retry/i.test(x.innerText||'')); if(b){b.click();return true;} return false; });
    // also resend prompt to be safe
    await new Promise(r=>setTimeout(r,2000));
    await send(page,PROMPT);
    let res2='pending';
    for(let i=0;i<10;i++){ await new Promise(r=>setTimeout(r,5000)); const st=await read(page);
      if(st.imgs>0){res2='(img) IMAGE after retry+refire '+(i+1)*5+'s';break;}
      if(st.quota){res2='(a) QUOTA :: '+st.txt;break;}
      if(st.err && i>1){res2='ERR_AFTER_RETRY';break;}
      if(i===9)res2='SILENT_AFTER_RETRY'; }
    shot=path.join(OUT,'retry2-'+Date.now()+'.png'); await page.screenshot({path:shot});
    res = 'STEP1_RETRY: '+res2;
    if(res2==='ERR_AFTER_RETRY' || res2==='SILENT_AFTER_RETRY'){
      // step 2: HARD RELOAD tab (NOT logout) + retry once
      await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});
      await new Promise(r=>setTimeout(r,6000));
      await send(page,PROMPT);
      let res3='pending';
      for(let i=0;i<10;i++){ await new Promise(r=>setTimeout(r,5000)); const st=await read(page);
        if(st.imgs>0){res3='(img) IMAGE after hardreload '+(i+1)*5+'s';break;}
        if(st.quota){res3='(a) QUOTA :: '+st.txt;break;}
        if(st.err && i>1){res3='ERR_AFTER_RELOAD';break;}
        if(i===9)res3='SILENT_AFTER_RELOAD'; }
      shot=path.join(OUT,'retry3-'+Date.now()+'.png'); await page.screenshot({path:shot});
      res = 'STEP2_HARDRELOAD: '+res3;
    }
  }
  console.log('FINAL_DISCRIMINATOR:', res);
  console.log('SHOT:', shot);
  try { await page.close(); } catch {}
  await browser.disconnect();
})().catch(e=>{ console.log('ERR',e.message); process.exit(0); });
