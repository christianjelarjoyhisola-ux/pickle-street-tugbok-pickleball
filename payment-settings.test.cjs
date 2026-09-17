'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync('payment-settings.js','utf8'),context);
const api=context.PBPaymentSettings;
function form(selected,shared,pnb={},maya={}) {
  const row=(code,data)=>({dataset:{code},querySelector(selector){const keys={'.platform-method-account-name':'accountName','.platform-method-account-reference':'accountReference','.platform-method-qr-url':'qrImageUrl','.platform-method-instructions':'instructions'};return {value:data[keys[selector]]||''};}});
  const rows=[row('gcash',shared),row('pnb',pnb),row('maya',maya)];
  return {querySelector(){return rows[0];},querySelectorAll(selector){return selector==='.platform-method-active'?api.definitions.map(m=>({dataset:{code:m.code},checked:selected.includes(m.code)})):rows;}};
}
test('shared GCash edits apply to every source without enabling inactive methods or changing PNB',()=>{
  const original=[{code:'gcash',isActive:true,accountName:'OLD RECIPIENT',accountReference:'09171111111'},
    {code:'gotyme',isActive:false,accountName:'WRONG LEGACY DESTINATION',accountReference:'old-bank'},
    {code:'pnb',isActive:true,accountName:'BANK RECEIVER',accountReference:'111222333'}];
  const updated={accountName:'NEW VENUE RECIPIENT',accountReference:'09172222222',qrImageUrl:'https://example.test/venue.png'};
  const result=api.collect(api.methods(original),form(['gcash','maya','pnb'],updated,original[2],{accountName:'MAYA RECEIVER',accountReference:'09998887777',qrImageUrl:'https://example.test/maya.png'}));
  for(const code of api.sharedCodes){const m=result.find(r=>r.code===code);assert.equal(m.accountName,updated.accountName);assert.equal(m.accountReference,updated.accountReference);assert.equal(m.qrImageUrl,updated.qrImageUrl);}
  assert.equal(result.find(r=>r.code==='gotyme').isActive,false);assert.equal(result.find(r=>r.code==='maya').isActive,true);assert.equal(result.find(r=>r.code==='maya').accountReference,updated.accountReference);assert.equal(result.find(r=>r.code==='maya').qrImageUrl,updated.qrImageUrl);
  assert.equal(result.find(r=>r.code==='pnb').accountReference,'111222333');assert.equal(original[0].accountName,'OLD RECIPIENT');
  assert.equal(result.some(r=>r.code==='cash'),false);
});
test('removing the shared QR clears it for every source while retaining its payment instructions',()=>{
  const items=api.methods([{code:'gcash',instructions:'Venue payment reminder',qrImageUrl:'https://example.test/old.png'}]);
  const result=api.collect(items,form(['gcash'],{accountName:'TEST VENUE',accountReference:'09172222222',qrImageUrl:''}));
  for(const code of api.sharedCodes)assert.equal(result.find(r=>r.code===code).qrImageUrl,'');
  assert.equal(result.find(r=>r.code==='gcash').instructions,'Venue payment reminder');assert.equal(api.sharedCodes.includes('maya'),true);
});
test('BDO aliases restore one canonical option and ambiguous duplicates require repair',()=>{
  assert.equal(api.methods([{code:'bdo',isActive:true}]).find(m=>m.code==='bdo_pay').isActive,true);
  assert.throws(()=>api.methods([{code:'bdo',isActive:true},{code:'bdo_pay',isActive:false}]),/Duplicate/);
});
test('settings render venue values safely without importing reference-account defaults',()=>{
  const html=api.render(api.methods([{code:'gcash',accountName:'<img onerror="alert(1)">',isActive:true}]),{});
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img onerror'));
  assert.match(html,/Shared GCash recipient/);assert.match(html,/Advanced GCash QR receipt verification/);
  assert.match(html,/Maya → GCash/);assert.match(html,/MariBank/);assert.doesNotMatch(html,/Maya receiving account|PaddleRage|09455107667|Jan Kennith|DWQM4TK/);
  assert.match(html,/data-code="cash" disabled/);
});
