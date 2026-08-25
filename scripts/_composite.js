#!/usr/bin/env node
// Composite: add canonical iAgencyAIA logo (top-right) + black footer bar to a raw DALL-E poster (1080x1920).
// GPT left top-right blank + bottom ~160px blank per template. We overlay ONLY these two.
const { execSync } = require('child_process');
const fs=require('fs');
const IN=process.argv[2], OUT=process.argv[3], FOOT_ARG=process.argv[4];
if(!IN||!OUT){ console.log('usage: node composite.js <in.png> <out.png> [footer.png]'); process.exit(1); }
const LOGO='/home/curfew/.maw/inbox/chips/designer-iAgencyAIA-logo-with-stroke-7a0e44a6.png';
// The canonical footer carries a BAKED DATE — pass a dated footer built by
// Designer-Oracle/scripts/build-footer-dated.py or the poster ships the wrong date.
const FOOT=FOOT_ARG||'/home/curfew/repos/github.com/BankCurfew/Designer-Oracle/brand/footer-black.png';
if(!fs.existsSync(FOOT)){ console.log('FOOTER MISSING',FOOT); process.exit(1); }
// hash gate
const lh=execSync(`md5sum "${LOGO}"`).toString().split(' ')[0];
if(lh!=='1edd678b8d2b257a770c5f63c970d419'){ console.log('LOGO HASH MISMATCH',lh); process.exit(1); }
// resize raw to 1080x1920, overlay logo top-right (+30+35, w240), append black footer at bottom
// Parameters match provenance-gate.py composite: 240w at (810,35) = NorthEast +30+35
const cmd=`convert "${IN}" -resize 1080x1920! \
  \\( "${LOGO}" -resize 240x \\) -gravity NorthEast -geometry +30+35 -composite \
  "${FOOT}" -gravity South -composite "${OUT}"`;
execSync(cmd);
console.log('COMPOSITED',OUT);
