// Local UI fixture only. No production requests and no real customer emails.
const http=require('node:http'),fs=require('node:fs');
http.createServer((req,res)=>{
 const file=req.url?.split('?')[0].slice(1);
 if(['weather-credit.css','weather-credit.js','weather-interruption.js'].includes(file)){res.setHeader('Content-Type',file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');res.end(fs.readFileSync(file));return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/weather-credit.css"><style>body{font:14px system-ui;background:#eef3f4;padding:30px}button{cursor:pointer}</style><h1>Weather interruption · Test preview</h1><p>Mock bookings only. No customer data or emails.</p><button onclick="PBWeatherInterruption.open()">Weather Interruption</button><button onclick="PBWeatherCredit.openManager('TEST-BOOKING')">Individual credit</button><script>
 const courts=[{id:'11111111-1111-4111-8111-111111111111',name:'Court 1'},{id:'22222222-2222-4222-8222-222222222222',name:'Court 2'},{id:'33333333-3333-4333-8333-333333333333',name:'Court 3'}];let rows=[],saved=null,attempts=0;
 window.DB={getCourts:async()=>courts,weatherCredit:async(action,p)=>{
 if(action==='preview-batch'){rows=[{reference:'TEST-ONE',name:'Alex Rivera',email:'alex@example.invalid',minutes:90,eligible:!saved,sessions:[{court:'Court 1',start:p.windows[0].start,end:p.windows[0].end}],exclusion:saved?'Credit already issued':null},{reference:'TEST-TWO',name:'Sam Cruz',email:'sam@example.invalid',minutes:60,eligible:!saved,sessions:[{court:'Court 2',start:p.windows[0].start,end:p.windows[0].end}],exclusion:saved?'Credit already issued':null},{reference:'TEST-THREE',name:'Taylor Santos',email:'taylor@example.invalid',minutes:120,eligible:false,exclusion:'Payment not confirmed',sessions:[{court:'Court 1',start:p.windows[0].start,end:p.windows[0].end}]}];return {ok:true,snapshot:'mock-snapshot',bookings:rows};}
 if(action==='issue-batch'){if(p.references.includes('TEST-THREE'))throw Error('Unpaid booking selected');saved=saved||{ok:true,bookings:rows.filter(r=>p.references.includes(r.reference)).map(r=>({...r,credit:{code:'PS-RAIN-123456789012345678901234',emailSent:false}}))};return saved;}
 if(action==='email'){attempts++;return {ok:true,credit:{emailSent:attempts>2}};}
 if(action==='issue')return {ok:true,email:'test@example.invalid',credit:{code:'PS-RAIN-123456789012345678901234',minutes:p.minutes,balanceMinutes:p.minutes,emailSent:true}};
 return {ok:true,eligible:true,maximumMinutes:120,email:'test@example.invalid',credit:null};}};
 </script><script src="/weather-credit.js"></script><script src="/weather-interruption.js"></script></html>`);
}).listen(8792,'127.0.0.1',()=>console.log('Mock weather preview: http://127.0.0.1:8792'));
