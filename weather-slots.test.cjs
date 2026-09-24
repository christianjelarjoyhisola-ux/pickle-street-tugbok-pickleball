const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const w={};vm.runInNewContext(fs.readFileSync('weather-interruption.js','utf8'),{window:w});
const {toggleSlot,at}=w.PBWeatherSlots;
const slot=(court,start,end)=>({courtId:court,start:at('2026-09-24',start),end:at('2026-09-24',end)});
test('adjacent selected hours merge without changing other courts',()=>{
 let r=toggleSlot([],slot('a',14,15));r=toggleSlot(r,slot('a',15,16));r=toggleSlot(r,slot('b',14,15));
 assert.equal(r.length,2);assert.equal(r[0].end,at('2026-09-24',16));
});
test('deselecting an hour splits a range and preserves partial hours',()=>{
 const r=toggleSlot([slot('a',13.5,16.5)],slot('a',14,15),true);
 assert.equal(r.length,2);assert.equal(r[0].start,at('2026-09-24',13.5));assert.equal(r[0].end,at('2026-09-24',14));assert.equal(r[1].start,at('2026-09-24',15));
});
test('selecting a partially affected hour replaces overlap without double counting',()=>{
 const r=toggleSlot([slot('a',14.5,15.5)],slot('a',14,15));
 assert.equal(r.length,1);assert.equal((new Date(r[0].end)-new Date(r[0].start))/3600000,1.5);
});
test('midnight ends at the following Philippine day and source ranges are immutable',()=>{
 assert.equal(at('2026-09-24',24),'2026-09-24T16:00:00.000Z');
 const original=[slot('a',14,15)],before=JSON.stringify(original);toggleSlot(original,slot('a',15,16));assert.equal(JSON.stringify(original),before);
});
