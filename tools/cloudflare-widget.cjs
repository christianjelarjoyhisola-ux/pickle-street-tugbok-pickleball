'use strict';
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const account='9de0a7bfb3751bdbffd5b7ad0b305aa6';
const sitekey='0x4AAAAAAD4f_jPZuqET5eVD';
const endpoint=`https://api.cloudflare.com/client/v4/accounts/${account}/challenges/widgets/${sitekey}`;
const hosts=['picklestreet.pages.dev'];
async function main(){
  // Credentials stay in memory; no token or widget secret is printed or saved.
  const credentials=JSON.parse(execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','auth','token','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  if(!credentials.token)throw Error('A scoped Cloudflare token is required.');
  async function api(method,body){
    const response=await fetch(endpoint,{method,headers:{Authorization:'Bearer '+credentials.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    const json=await response.json();if(!response.ok||!json.success)throw Error(`Widget request failed (${response.status}): ${JSON.stringify(json.errors)}`);
    return json.result;
  }
  const before=await api('GET');
  const safe=widget=>({sitekey:widget.sitekey,name:widget.name,mode:widget.mode,domains:widget.domains,clearance_level:widget.clearance_level,bot_fight_mode:widget.bot_fight_mode,ephemeral_id:widget.ephemeral_id,offlabel:widget.offlabel});
  if(process.argv.includes('--add-pages-host') && hosts.some(host=>!before.domains.includes(host))){
    const body={...safe(before),domains:[...before.domains,...hosts.filter(host=>!before.domains.includes(host))]};delete body.sitekey;
    const after=await api('PUT',body);
    if(!before.domains.every(host=>after.domains.includes(host)) || !hosts.every(host=>after.domains.includes(host)))throw Error('Domain preservation verification failed.');
    for(const key of ['name','mode','clearance_level','bot_fight_mode','ephemeral_id','offlabel'])if(before[key]!==after[key])throw Error('Unexpected widget setting change: '+key);
    fs.writeFileSync('operations/cloudflare-security.json',JSON.stringify({checkedAt:new Date().toISOString(),addedHosts:hosts,before:safe(before),after:safe(after)},null,2)+'\n');
    console.log(JSON.stringify({updated:true,...safe(after)},null,2));
  }else console.log(JSON.stringify({updated:false,...safe(before)},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
