import {rejectionEmail} from './duplicate-rejection.ts';
Deno.test('Rejection email asks the customer to book again without disclosing the internal reason',()=>{
 const m=rejectionEmail('PB-TEST','<Player>');
 for(const text of ['PB-TEST','was rejected','Please book again','https://picklestreetcourt.com'])if(!m.plainText.includes(text))throw Error(text);
 if(m.html.includes('<Player>')||!m.html.includes('&lt;Player&gt;'))throw Error('HTML escaping');
 if(/duplicate|already been used|payment reference|fraud|refund issued/i.test(m.subject+m.plainText+m.html))throw Error('Internal reason or incorrect claim');
});
