(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.PBCourtPricing=api;
})(typeof window==='object'?window:null,function(){
  'use strict';
  const optionalAmount=value=>value===''||value===null||value===undefined?null:Number(value);
  const validAmount=value=>Number.isFinite(value)&&value>0&&value<=9999999999.99&&Math.abs(Math.round(value*100)-value*100)<=0.000001;
  function normalize(tier={}){
    const standardRate=Number(tier.standardRate??tier.rate);
    const promoRate=optionalAmount(tier.promoRate);
    const promoEnabled=tier.promoEnabled===true;
    return {from:Number(tier.from),to:Number(tier.to),standardRate,promoRate,promoEnabled,rate:promoEnabled?promoRate:standardRate};
  }
  function validationError(value){
    const tier=normalize(value);
    if(!Number.isInteger(tier.from)||!Number.isInteger(tier.to)||tier.from<0||tier.from>23||tier.to<=tier.from||tier.to>24)return 'Each tier needs a valid start and end time.';
    if(!validAmount(tier.standardRate))return 'Enter a standard hourly rate greater than ₱0, with no more than two decimals.';
    if(tier.promoRate!==null&&!validAmount(tier.promoRate))return 'Enter a promo hourly rate greater than ₱0, with no more than two decimals.';
    if(tier.promoEnabled&&(tier.promoRate===null||tier.promoRate>=tier.standardRate))return 'An enabled promo needs a price lower than the standard hourly rate.';
    return '';
  }
  function fromBand(band={}){
    const clock=value=>/^\d{2}:00$/.test(String(value))?Number(String(value).slice(0,2)):NaN;
    return normalize({from:clock(band.start),to:band.end==='00:00'?24:clock(band.end),
      standardRate:band.standardHourlyRate??band.hourlyRate,promoRate:band.promoHourlyRate,promoEnabled:band.promoEnabled});
  }
  function toBand(value){
    const tier=normalize(value),error=validationError(tier);
    if(error)throw new Error(error);
    return {start:String(tier.from).padStart(2,'0')+':00',end:String(tier.to).padStart(2,'0')+':00',
      hourlyRate:tier.rate,standardHourlyRate:tier.standardRate,promoHourlyRate:tier.promoRate,promoEnabled:tier.promoEnabled};
  }
  function promotion(courts){
    const tiers=(Array.isArray(courts)?courts:[]).filter(court=>court.status==='active'&&!court.blocked)
      .flatMap(court=>Array.isArray(court.rateSchedule)?court.rateSchedule:[]);
    const active=tiers.map(normalize).filter(tier=>tier.promoEnabled&&!validationError(tier));
    if(!active.length)return null;
    const first=[...active].sort((a,b)=>a.rate-b.rate)[0];
    const uniform=active.length===tiers.length&&active.every(tier=>tier.rate===first.rate&&tier.standardRate===first.standardRate);
    return {rate:first.rate,standardRate:first.standardRate,uniform};
  }
  return Object.freeze({normalize,validationError,fromBand,toBand,promotion});
});
