'use strict';
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'wrangler.jsonc'),'utf8'));
if(config.name!=='picklestreet'||config.pages_build_output_dir!=='./dist')throw Error('Unexpected deployment target.');
execFileSync(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'pages','deploy','dist','--project-name','picklestreet','--branch','main','--commit-dirty=true'],{
  cwd:root,stdio:'inherit',env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'9de0a7bfb3751bdbffd5b7ad0b305aa6'},
});
