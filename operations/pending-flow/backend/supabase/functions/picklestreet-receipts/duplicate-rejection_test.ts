import {rejectionEmail} from './duplicate-rejection.ts';
Deno.test('Cancellation email clearly explains duplicate reference without alleging fraud or promising a refund',()=>{
 const m=rejectionEmail('PB-TEST','<Player>');
 for(const text of ['PB-TEST','already been used','All court slots','reply to this email','do not send another payment'])if(!m.plainText.includes(text))throw Error(text);
 if(m.html.includes('<Player>')||!m.html.includes('&lt;Player&gt;'))throw Error('HTML escaping');
 if(/fraud|refund issued/i.test(m.plainText))throw Error('Incorrect claim');
});
