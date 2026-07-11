/* AUTO-GENERATED from src/App.jsx by scratchpad/gen-engine.py — DO NOT EDIT BY HAND.
   Regenerate after engine changes; claude/tests/api.mjs asserts parity with the app. */
"use strict";
const zoneEst=(o,d)=>{const a=parseInt(String(o).slice(0,3)||"840",10);const b=parseInt(String(d).slice(0,3)||"840",10);return Math.min(8,Math.max(2,2+Math.round(Math.abs(a-b)/90)));};
const RATE_ZONES=["2","3","4","5","6","7","8"];
const DIM=139;
let DIM_CFG={express:DIM,ground:DIM,ground_economy:DIM};
const setDimCfg=(d)=>{DIM_CFG={express:+(d&&d.express)||DIM,ground:+(d&&d.ground)||DIM,ground_economy:+(d&&d.ground_economy)||DIM};};
const dimFor=(svc)=>{const t=String(svc||"").toLowerCase();return /econom|smart\s*post/.test(t)?DIM_CFG.ground_economy:/ground|home/.test(t)?DIM_CFG.ground:DIM_CFG.express;};
const billable=(L,W,H,a,div)=>Math.max(Math.ceil((L*W*H)/(+div||DIM_CFG.ground||DIM)),Math.ceil(a||0),1);
const ruleWeightFor=(pieces,label)=>{const div=dimFor(label);return (pieces||[]).reduce((a,p)=>{const L=+p.L||+p.length||0,W=+p.W||+p.width||0,H=+p.H||+p.height||0;const act=Math.ceil(+p.weight||0);return a+((L>0&&W>0&&H>0)?billable(L,W,H,act,div):Math.max(act,1));},0);};
const OR_RATE_SVCS=[["first_overnight","First Overnight"],["priority_overnight","Priority Overnight"],["standard_overnight","Standard Overnight"],["2day_am","2Day A.M."],["2day","2Day"],["express_saver","Express Saver"]];
const OR_RATE_PKGS=[["envelope","Envelope"],["pak","Pak"],["xs_box","Extra Small Box"],["small_box","Small Box"],["medium_box","Medium Box"],["large_box","Large Box"],["xl_box","Extra Large Box"],["tube","Tube"]];
const DEFAULT_RATE_RULES={profiles:[{id:"default",name:"Default",services:{},surcharges:{}}],assign:{},baseCosts:{}};
const FEDEX_SURCHARGES=[
  /* Delivery & signature */
  {id:"SIG-D",desc:"Direct Signature Required",seg:"Express & Ground",charge:"fixed",app:1,def:6.55,g:"Delivery & signature",aka:"Direct Signature Required"},
  {id:"SIG-I",desc:"Indirect Signature Required",seg:"Express & Ground",charge:"fixed",app:1,def:6.55,g:"Delivery & signature",aka:"Indirect Signature Required"},
  {id:"SIG-A",desc:"Adult Signature Required",seg:"Express & Ground",charge:"fixed",app:1,def:8.05,g:"Delivery & signature",aka:"Adult Signature Required"},
  {id:"SAT",desc:"Saturday Delivery",seg:"Express",charge:"fixed",app:1,def:16.00,g:"Delivery & signature",aka:"Saturday Delivery"},
  {id:"SATP",desc:"Saturday Pickup",seg:"Express",charge:"fixed",g:"Delivery & signature"},
  {id:"RES",desc:"Residential Delivery",seg:"Express",charge:"fixed",g:"Delivery & signature",aka:"Residential Surcharge"},
  {id:"RES-G",desc:"Residential Delivery",seg:"Ground",charge:"fixed",g:"Delivery & signature",aka:"Residential Surcharge"},
  {id:"RES-HD",desc:"Home Delivery Charge",seg:"Home Delivery",charge:"fixed",g:"Delivery & signature",aka:"Residential Surcharge"},
  {id:"HAL",desc:"Hold at Location",seg:"All",charge:"fixed",g:"Delivery & signature",aka:"Hold at Location"},
  {id:"HD-APPT",desc:"Home Delivery — Appointment",seg:"Home Delivery",charge:"fixed",g:"Delivery & signature"},
  {id:"HD-EVE",desc:"Home Delivery — Evening",seg:"Home Delivery",charge:"fixed",g:"Delivery & signature"},
  {id:"HD-DATE",desc:"Home Delivery — Date Certain",seg:"Home Delivery",charge:"fixed",g:"Delivery & signature"},
  {id:"REATT",desc:"Delivery Reattempt",seg:"Express",charge:"fixed",g:"Delivery & signature"},
  {id:"REROUTE",desc:"Reroute / Redirect (address change in transit)",seg:"Express & Ground",charge:"fixed",g:"Delivery & signature"},
  /* Coverage, corrections & billing */
  {id:"INS",desc:"Declared Value (per $100 over $100)",seg:"Express & Ground",charge:"per $100",app:1,def:1.15,g:"Coverage & corrections",aka:"Declared Value Surcharge / Insured Value"},
  {id:"ADDR",desc:"Address Correction",seg:"Express & Ground",charge:"fixed",g:"Coverage & corrections"},
  {id:"RW",desc:"Shipping Charge Correction (reweigh / re-dim audit)",seg:"Express & Ground",charge:"fixed",g:"Coverage & corrections"},
  {id:"3PB",desc:"Third Party Billing Surcharge",seg:"Express & Ground",charge:"percent of base",g:"Coverage & corrections",aka:"Third Party Billing Surcharge"},
  {id:"FUEL",desc:"Fuel Surcharge",seg:"Express",charge:"percent of base",g:"Coverage & corrections",aka:"Fuel Surcharge"},
  {id:"FUEL-G",desc:"Fuel Surcharge",seg:"Ground",charge:"percent of base",g:"Coverage & corrections",aka:"Fuel Surcharge"},
  /* Delivery area */
  {id:"DAS",desc:"DAS — Commercial",seg:"Express",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge"},
  {id:"DAS-G",desc:"DAS — Commercial",seg:"Ground",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge"},
  {id:"DAS-EC",desc:"DAS — Extended Commercial",seg:"Express",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge Extended"},
  {id:"DAS-EC-G",desc:"DAS — Extended Commercial",seg:"Ground",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge Extended"},
  {id:"DAS-R",desc:"DAS — Residential",seg:"Express",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge Residential"},
  {id:"DAS-R-HD",desc:"DAS — Residential",seg:"Home Delivery",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge Residential"},
  {id:"DAS-ER",desc:"DAS — Extended Residential",seg:"Express",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge Extended Residential"},
  {id:"DAS-ER-HD",desc:"DAS — Extended Residential",seg:"Home Delivery",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge Extended Residential"},
  {id:"DAS-RM",desc:"DAS — Remote",seg:"Express",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge Remote"},
  {id:"DAS-RM-G",desc:"DAS — Remote",seg:"Ground & Home Delivery",charge:"fixed",g:"Delivery area",aka:"Delivery Area Surcharge Remote"},
  {id:"DAS-AK",desc:"DAS — Alaska Commercial",seg:"Express",charge:"fixed",g:"Delivery area"},
  {id:"DAS-AK-G",desc:"DAS — Alaska Commercial",seg:"Ground",charge:"fixed",g:"Delivery area"},
  {id:"DAS-AK-R",desc:"DAS — Alaska Residential",seg:"Express",charge:"fixed",g:"Delivery area"},
  {id:"DAS-AK-R-HD",desc:"DAS — Alaska Residential",seg:"Home Delivery",charge:"fixed",g:"Delivery area"},
  {id:"DAS-HI",desc:"DAS — Hawaii Commercial",seg:"Express",charge:"fixed",g:"Delivery area"},
  {id:"DAS-HI-G",desc:"DAS — Hawaii Commercial",seg:"Ground",charge:"fixed",g:"Delivery area"},
  {id:"DAS-HI-R",desc:"DAS — Hawaii Residential",seg:"Express",charge:"fixed",g:"Delivery area"},
  {id:"DAS-HI-R-HD",desc:"DAS — Hawaii Residential",seg:"Home Delivery",charge:"fixed",g:"Delivery area"},
  /* Handling & size */
  {id:"AH-D",desc:"Additional Handling — Dimensions",seg:"Express",charge:"fixed (zoned)",g:"Handling & size",aka:"Additional Handling Surcharge - Dimensions"},
  {id:"AH-D-G",desc:"Additional Handling — Dimensions",seg:"Ground",charge:"fixed (zoned)",g:"Handling & size",aka:"Additional Handling Surcharge - Dimensions"},
  {id:"AH-W",desc:"Additional Handling — Weight",seg:"Express",charge:"fixed (zoned)",g:"Handling & size",aka:"Additional Handling Surcharge - Weight"},
  {id:"AH-W-G",desc:"Additional Handling — Weight",seg:"Ground",charge:"fixed (zoned)",g:"Handling & size",aka:"Additional Handling Surcharge - Weight"},
  {id:"AH-P",desc:"Additional Handling — Packaging",seg:"Express",charge:"fixed (zoned)",g:"Handling & size",aka:"Additional Handling Surcharge - Packaging"},
  {id:"AH-P-G",desc:"Additional Handling — Packaging",seg:"Ground",charge:"fixed (zoned)",g:"Handling & size",aka:"Additional Handling Surcharge - Packaging"},
  {id:"AH-NS",desc:"Additional Handling — Non-Stackable (freight)",seg:"Express Freight",charge:"fixed",g:"Handling & size"},
  {id:"OVR",desc:"Oversize Charge",seg:"Express",charge:"fixed (zoned)",g:"Handling & size",aka:"Oversize Charge"},
  {id:"OVR-G",desc:"Oversize Charge",seg:"Ground",charge:"fixed (zoned)",g:"Handling & size",aka:"Oversize Charge"},
  {id:"UNAUTH",desc:"Unauthorized Package Charge",seg:"Ground",charge:"fixed",g:"Handling & size",aka:"Unauthorized Package Charge"},
  /* Peak / demand */
  {id:"PEAK-R",desc:"Demand Surcharge — Residential (peak)",seg:"Express",charge:"fixed",g:"Peak / demand",aka:"Demand Surcharge - Residential"},
  {id:"PEAK-R-G",desc:"Demand Surcharge — Residential (peak)",seg:"Ground & Home Delivery",charge:"fixed",g:"Peak / demand",aka:"Demand Surcharge - Residential"},
  {id:"PEAK-AH",desc:"Demand Surcharge — Additional Handling (peak)",seg:"Express",charge:"fixed",g:"Peak / demand",aka:"Demand Surcharge - Additional Handling"},
  {id:"PEAK-AH-G",desc:"Demand Surcharge — Additional Handling (peak)",seg:"Ground",charge:"fixed",g:"Peak / demand",aka:"Demand Surcharge - Additional Handling"},
  {id:"PEAK-OS",desc:"Demand Surcharge — Oversize (peak)",seg:"Express",charge:"fixed",g:"Peak / demand",aka:"Demand Surcharge - Oversize"},
  {id:"PEAK-OS-G",desc:"Demand Surcharge — Oversize (peak)",seg:"Ground",charge:"fixed",g:"Peak / demand",aka:"Demand Surcharge - Oversize"},
  {id:"PEAK-UNAUTH",desc:"Demand Surcharge — Unauthorized Package (peak)",seg:"Ground",charge:"fixed",g:"Peak / demand"},
  {id:"PEAK-GE",desc:"Demand Surcharge — Ground Economy (peak)",seg:"Ground Economy",charge:"fixed",g:"Peak / demand",aka:"Demand Surcharge"},
  {id:"PEAK-INTL",desc:"Demand Surcharge — International (per lane, peak)",seg:"Express",charge:"fixed",g:"Peak / demand",aka:"Demand Surcharge - International"},
  /* Pickup & returns */
  {id:"PU-EXP",desc:"On-Call Pickup (per package)",seg:"Express",charge:"fixed",def:16.25,g:"Pickup & returns"},
  {id:"PU-GRD-OC",desc:"On-Call Pickup (per package)",seg:"Ground",charge:"fixed",def:16.25,g:"Pickup & returns"},
  {id:"PU-GRD",desc:"Scheduled / Alternate-Day Pickup (weekly)",seg:"Ground",charge:"fixed",def:35.50,g:"Pickup & returns"},
  {id:"RTN",desc:"Print Return Label",seg:"Express & Ground",charge:"fixed",g:"Pickup & returns"},
  {id:"RTN-E",desc:"Email Return Label",seg:"Express & Ground",charge:"fixed",g:"Pickup & returns"},
  {id:"RETAG",desc:"Ground Call Tag / Express Tag (pickup return)",seg:"Express & Ground",charge:"fixed",g:"Pickup & returns"},
  /* Dangerous goods */
  {id:"DRY",desc:"Dry Ice",seg:"Express",charge:"fixed",g:"Dangerous goods"},
  {id:"DG-A",desc:"Dangerous Goods — Accessible",seg:"Express",charge:"fixed",g:"Dangerous goods"},
  {id:"DG-I",desc:"Dangerous Goods — Inaccessible",seg:"Express",charge:"fixed",g:"Dangerous goods"},
  {id:"HAZ",desc:"Hazardous Materials",seg:"Ground",charge:"fixed",g:"Dangerous goods"},
  {id:"LTDQ",desc:"Limited Quantity / ORM-D",seg:"Ground",charge:"fixed",g:"Dangerous goods"},
  /* International & clearance */
  {id:"BSO",desc:"Broker Select Option (intl)",seg:"Express & Ground",charge:"fixed",g:"International & clearance"},
  {id:"DTF",desc:"Duty & Tax Forwarding (intl)",seg:"Express & Ground",charge:"fixed",g:"International & clearance"},
  {id:"ODA",desc:"Out of Delivery Area (intl)",seg:"Express",charge:"fixed",g:"International & clearance"},
  {id:"OPA",desc:"Out of Pickup Area (intl)",seg:"Express",charge:"fixed",g:"International & clearance"},
  {id:"ICE",desc:"International Controlled Export (ICE)",seg:"Express",charge:"fixed",g:"International & clearance"},
  {id:"CEF",desc:"Clearance Entry Fee (intl / Ground to Canada)",seg:"Ground",charge:"fixed",g:"International & clearance"},
  {id:"DISB",desc:"Disbursement / Duty & Tax Advancement Fee (intl)",seg:"Express & Ground",charge:"percent or min",g:"International & clearance"},
  {id:"ANC",desc:"Ancillary Clearance Service Fees (intl)",seg:"Express & Ground",charge:"fixed",g:"International & clearance"},
  {id:"TPC",desc:"Third Party Consignee (intl)",seg:"Express & Ground",charge:"fixed",g:"International & clearance"},
  /* Ground Economy */
  {id:"GE-DR",desc:"Ground Economy Delivery & Return Charge (per package)",seg:"Ground Economy",charge:"fixed",g:"Ground Economy",aka:"Delivery and Returns Charge"},
  {id:"GE-PS",desc:"Ground Economy Pickup Charge",seg:"Ground Economy",charge:"fixed",g:"Ground Economy"}
];
const RATE_SERVICES={
  fedex:[
    {k:"ground",l:"FedEx Ground",g:"Domestic",z:1},
    {k:"home",l:"FedEx Home Delivery",g:"Domestic",z:1},
    {k:"ground_economy",l:"FedEx Ground Economy (SmartPost)",g:"Domestic",z:1},
    {k:"express_saver",l:"FedEx Express Saver",g:"Domestic",z:1},
    {k:"2day",l:"FedEx 2Day",g:"Domestic",z:1},
    {k:"2day_am",l:"FedEx 2Day A.M.",g:"Domestic",z:1},
    {k:"standard_overnight",l:"FedEx Standard Overnight",g:"Domestic",z:1},
    {k:"priority_overnight",l:"FedEx Priority Overnight",g:"Domestic",z:1},
    {k:"first_overnight",l:"FedEx First Overnight",g:"Domestic",z:1},
    {k:"intl_ground_ca",l:"FedEx International Ground (Canada)",g:"International"},
    {k:"intl_connect_plus",l:"FedEx International Connect Plus",g:"International"},
    {k:"intl_economy",l:"FedEx International Economy",g:"International"},
    {k:"intl_priority",l:"FedEx International Priority",g:"International"},
    {k:"intl_priority_express",l:"FedEx International Priority Express",g:"International"},
    {k:"intl_first",l:"FedEx International First",g:"International"},
    {k:"first_overnight_freight",l:"FedEx First Overnight Freight",g:"Freight"},
    {k:"1day_freight",l:"FedEx 1Day Freight",g:"Freight"},
    {k:"2day_freight",l:"FedEx 2Day Freight",g:"Freight"},
    {k:"3day_freight",l:"FedEx 3Day Freight",g:"Freight"},
    {k:"intl_priority_freight",l:"FedEx International Priority Freight",g:"Freight"},
    {k:"intl_economy_freight",l:"FedEx International Economy Freight",g:"Freight"},
  ].concat(OR_RATE_SVCS.reduce((acc,sv)=>acc.concat(OR_RATE_PKGS.map(pk=>({k:"or_"+sv[0]+"_"+pk[0],l:"One Rate "+sv[1]+" "+pk[1],g:"One Rate",or:true}))),[])),
  dhl:[
    {k:"dhl_worldwide",l:"DHL Express Worldwide",g:"International"},
    {k:"dhl_1200",l:"DHL Express 12:00",g:"International"},
    {k:"dhl_1030",l:"DHL Express 10:30",g:"International"},
    {k:"dhl_900",l:"DHL Express 9:00",g:"International"},
    {k:"dhl_economy_select",l:"DHL Economy Select",g:"International"}
  ]
};
function canonSvc(s){
  /* Canonical toggle/lock/alias key for a service label. Delegates to rateSvcKey so the
     key vocabulary is IDENTICAL to the Customize services list, the admin lock list, and
     the Rate Database — the old inline patterns collapsed "Ground Economy"→ground,
     "2Day A.M."→2day, every Freight service and most International services onto the
     wrong base key, so hiding, admin-locking, or aliasing those services never matched a
     live quote. OneRate keys are reduced to the box-less or_<svc> form the toggle lists
     use (rateSvcKey's or_<svc>_<box> keys stay for per-box rate rules). */
  const t=String(s||"").replace(/[_\-]+/g," ");
  const k=rateSvcKey(t);
  return k.replace(/^(or_[a-z0-9_]+?)_(pak|envelope|xs_box|small_box|medium_box|large_box|xl_box|tube)$/,"$1");
}
function rateSvcKey(label){
  /* ®/™ stripped first — "FedEx 2Day® A.M." otherwise fails the A.M. pattern (the ® sits
     between "day" and "a.m." where \s* can't match) and keys to plain 2day, silently
     applying the 2Day rate rule to A.M. shipments. */
  const t=String(label||"").toLowerCase().replace(/[®™]/g,"");
  if(/one\s*rate/.test(t)){
    let svc="2day";
    if(/first\s*overnight/.test(t))svc="first_overnight";
    else if(/priority\s*overnight/.test(t))svc="priority_overnight";
    else if(/standard\s*overnight/.test(t))svc="standard_overnight";
    else if(/2\s*day\s*a\.?\s*m/.test(t))svc="2day_am";
    else if(/express\s*saver/.test(t))svc="express_saver";
    let pkg="pak";
    if(/envelope/.test(t))pkg="envelope";
    else if(/extra\s*small/.test(t))pkg="xs_box";
    else if(/small/.test(t))pkg="small_box";
    else if(/medium/.test(t))pkg="medium_box";
    else if(/extra\s*large/.test(t))pkg="xl_box";
    else if(/large/.test(t))pkg="large_box";
    else if(/tube/.test(t))pkg="tube";
    return "or_"+svc+"_"+pkg;
  }
  if(/dhl/.test(t)){
    if(/12:?00/.test(t))return "dhl_1200";
    if(/10:?30/.test(t))return "dhl_1030";
    if(/9:?00/.test(t))return "dhl_900";
    if(/economy\s*select/.test(t))return "dhl_economy_select";
    return "dhl_worldwide";
  }
  const freight=/freight/.test(t);
  if(/first\s*overnight/.test(t))return freight?"first_overnight_freight":"first_overnight";
  if(/priority\s*overnight/.test(t))return "priority_overnight";
  if(/standard\s*overnight/.test(t))return "standard_overnight";
  if(/2\s*day\s*a\.?\s*m/.test(t))return "2day_am";
  if(/(2|two)\s*.?\s*day/.test(t))return freight?"2day_freight":"2day";
  if(/1\s*day/.test(t)&&freight)return "1day_freight";
  if(/3\s*day/.test(t)&&freight)return "3day_freight";
  if(/express\s*saver|3\s*day/.test(t))return "express_saver";
  if(/home/.test(t))return "home";
  if(/smart\s*post|ground\s*economy/.test(t))return "ground_economy";
  if(/ground/.test(t))return /canada|international/.test(t)?"intl_ground_ca":"ground";
  if(/international\s*first|intl\s*first/.test(t))return "intl_first";
  if(/connect\s*plus/.test(t))return "intl_connect_plus";
  if(/(international|intl).*(priority).*(express)/.test(t))return "intl_priority_express";
  if(/(international|intl).*(priority)/.test(t))return freight?"intl_priority_freight":"intl_priority";
  if(/(international|intl).*(economy)/.test(t))return freight?"intl_economy_freight":"intl_economy";
  if(/priority/.test(t))return "intl_priority";
  if(/economy/.test(t))return "intl_economy";
  return t.replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
}
function fedexSurchargeIdFor(lineLabel,svcLabel){
  const t=String(lineLabel||"").toLowerCase(); if(!t)return null;
  const k=rateSvcKey(svcLabel||"");
  const ge=k==="ground_economy",home=k==="home",grd=ge||home||k==="ground"||k==="intl_ground_ca";
  const G=(ex,g)=>grd?g:ex;
  if(/fuel/.test(t))return G("FUEL","FUEL-G");
  if(/declared value|insured value|insurance/.test(t))return "INS";
  if(/adult signature/.test(t))return "SIG-A";
  if(/indirect signature/.test(t))return "SIG-I";
  if(/signature/.test(t))return "SIG-D";
  if(/saturday.*pickup/.test(t))return "SATP";
  if(/saturday/.test(t))return "SAT";
  if(/peak|demand/.test(t)){
    if(/additional handling|addl handling/.test(t))return G("PEAK-AH","PEAK-AH-G");
    if(/oversize/.test(t))return G("PEAK-OS","PEAK-OS-G");
    if(/unauthorized/.test(t))return "PEAK-UNAUTH";
    if(ge)return "PEAK-GE";
    if(/international/.test(t)||k.indexOf("intl")===0)return "PEAK-INTL";
    return G("PEAK-R","PEAK-R-G");
  }
  if(/additional handling|addl handling/.test(t)){
    if(/weight/.test(t))return G("AH-W","AH-W-G");
    if(/packag/.test(t))return G("AH-P","AH-P-G");
    if(/non.?stack/.test(t))return "AH-NS";
    return G("AH-D","AH-D-G");
  }
  if(/oversize/.test(t))return G("OVR","OVR-G");
  if(/unauthorized/.test(t))return "UNAUTH";
  if(/delivery (and|&) returns?/.test(t))return "GE-DR";
  if(/delivery area|\bdas\b/.test(t)){
    const resi=/residential/.test(t);
    if(/alaska/.test(t))return resi?(home?"DAS-AK-R-HD":"DAS-AK-R"):G("DAS-AK","DAS-AK-G");
    if(/hawaii/.test(t))return resi?(home?"DAS-HI-R-HD":"DAS-HI-R"):G("DAS-HI","DAS-HI-G");
    if(/remote/.test(t))return G("DAS-RM","DAS-RM-G");
    if(/extended/.test(t))return resi?(home?"DAS-ER-HD":"DAS-ER"):G("DAS-EC","DAS-EC-G");
    if(resi)return home?"DAS-R-HD":"DAS-R";
    return G("DAS","DAS-G");
  }
  if(/home delivery/.test(t))return "RES-HD";
  if(/residential/.test(t))return home?"RES-HD":G("RES","RES-G");
  if(/address correction/.test(t))return "ADDR";
  if(/third party billing/.test(t))return "3PB";
  if(/hold at location/.test(t))return "HAL";
  if(/reroute|redirect/.test(t))return "REROUTE";
  if(/dry ice/.test(t))return "DRY";
  if(/dangerous goods.*inaccessible|inaccessible.*dangerous/.test(t))return "DG-I";
  if(/dangerous goods/.test(t))return "DG-A";
  if(/hazardous/.test(t))return "HAZ";
  if(/limited quantity|orm.?d/.test(t))return "LTDQ";
  if(/broker select/.test(t))return "BSO";
  if(/duty.*tax.*forward/.test(t))return "DTF";
  if(/out of pickup/.test(t))return "OPA";
  if(/out of delivery/.test(t))return "ODA";
  if(/controlled export/.test(t))return "ICE";
  if(/clearance entry/.test(t))return "CEF";
  if(/disbursement|advancement/.test(t))return "DISB";
  if(/third party consignee/.test(t))return "TPC";
  if(/on.?call pickup/.test(t))return G("PU-EXP","PU-GRD-OC");
  return null;
}
function rateProfileFor(rules,clientId){
  const profs=(rules&&rules.profiles&&rules.profiles.length)?rules.profiles:DEFAULT_RATE_RULES.profiles;
  const pid=(rules&&rules.assign&&clientId&&rules.assign[clientId])||"default";
  return profs.find(p=>p.id===pid)||profs.find(p=>p.id==="default")||profs[0];
}
function baseCostLookup(rules,key,weight,zone){
  const t=rules&&rules.baseCosts&&rules.baseCosts[key];
  if(!t||!Array.isArray(t.rows)||!t.rows.length||!Array.isArray(t.zones))return null;
  const ci=t.zones.indexOf(String(zone)); if(ci<0)return null;
  const w=+weight||1;
  let row=t.rows.find(r=>+r[0]>=w)||t.rows[t.rows.length-1];
  const v=row&&row[ci+1];
  return (v==null||v==="")?null:+v;
}
const list2025Lookup=()=>null;   /* the 2025 book dataset stays app-side; listYear 2025 rules fall back honestly */
function rateSellFor(cost,label,ctx){
  const c=ctx||{};
  /* LIVE quotes split BASE from FEES (the spec): the service rule — % / Fixed / Flat / List−% —
     and its Min $ price the BASE freight ONLY. Every itemized fee line (fuel, residential, DAS,
     additional handling, peak, declared value…) is priced by its own accessorial rule; a fee
     with no rule takes the account-wide markup if one is set, else passes through at the billed
     amount. Total = priced base + priced fees. Min $ = a floor on the BASE. The account
     "Min $ profit / label" still floors profit against the TRUE total carrier cost. */
  if(cost!=null&&c.rules&&Array.isArray(c.surcharges)&&!c._noSurAdj){
    const prof=c.prof||rateProfileFor(c.rules,c.client&&c.client.id);
    const sc=(prof&&prof.surcharges)||{};
    const aPctF=(c.client&&c.client.markup!=null&&c.client.markup!==""&&!isNaN(+c.client.markup)&&+c.client.markup!==0)?+c.client.markup:null;
    let feeCost=0,feeSell=0;const feeParts=[];
    for(const ln of c.surcharges){
      const amt=+(ln&&ln.amount)||0; if(!amt)continue;
      feeCost+=amt;
      const id=fedexSurchargeIdFor(ln.label,label);
      const row=(id&&typeof FEDEX_SURCHARGES!=="undefined")?FEDEX_SURCHARGES.find(x=>x&&x.id===id):null;
      const r=id?sc[id]:null;
      const a=(r&&r.amount!=null&&r.amount!==""&&!isNaN(+r.amount))?+r.amount:null;
      /* a rule saved WITHOUT a type takes the same default the editor DISPLAYS — percent for
         normal fees, flat for app-priced ones. Falling through to flat here turned "25% over
         cost" into a $25 fuel charge when only the amount box was touched. */
      const rtype=(r&&r.type)||((row&&row.app)?"fixed":"percent");
      const priced=a==null
        ?(aPctF!=null?amt*(1+aPctF/100):amt)
        :(rtype==="percent"?amt*(1+a/100):rtype==="add"?amt+a:rtype==="listpct"?((+ln.list||amt)*(1-a/100)):a);
      feeSell+=priced;
      /* display the ADMIN ROW's exact name for matched fees so the portal breakdown and the
         Rates tab always show the identical string — no two wordings for one fee */
      feeParts.push({label:row?(row.aka||row.desc):ln.label,amount:Math.round(priced*100)/100});
    }
    const baseCost=Math.max(0,Math.round((cost-feeCost)*100)/100);
    /* the base prices off the LIST BASE when the quote provides it — never list-total */
    const baseSell=rateSellFor(baseCost,label,{...c,prof,list:(c.listBase!=null?c.listBase:(c.list!=null?c.list:null)),_noSurAdj:true});
    if(baseSell==null)return null;
    let out=Math.round((baseSell+feeSell)*100)/100;
    const aMin2=(c.client&&c.client.markupMin!=null&&c.client.markupMin!==""&&!isNaN(+c.client.markupMin)&&+c.client.markupMin>0)?+c.client.markupMin:null;
    /* Flat-priced services are EXEMPT from the account profit floor: "flat $15.30" must sell
       and display exactly $15.30 — flat means the sell never moves, whatever the margin. */
    const svcRule2=prof&&prof.services&&prof.services[rateSvcKey(label)];
    const isFlat2=!!(svcRule2&&svcRule2.basis==="flat"&&svcRule2.pct!=null&&svcRule2.pct!==""&&!isNaN(+svcRule2.pct));
    if(!isFlat2&&aMin2!=null&&out<cost+aMin2)out=Math.round((cost+aMin2)*100)/100;
    if(c._parts){c._parts.base=Math.round(baseSell*100)/100;c._parts.fees=feeParts;}
    return out;
  }
  if(cost==null){
    /* Flat-priced services sell at exactly their flat price even when the carrier cost is
       unknown (e.g. One Rate with no imported table) — the whole point of flat is that the
       sell never depends on cost. Everything else still needs a cost to price. */
    if(c.rules){
      const prof0=c.prof||rateProfileFor(c.rules,c.client&&c.client.id);
      const r0=prof0&&prof0.services&&prof0.services[rateSvcKey(label)];
      if(r0&&r0.basis==="flat"&&r0.pct!=null&&r0.pct!==""&&!isNaN(+r0.pct))return Math.round(+r0.pct*100)/100;
    }
    return null;
  }
  /* No platform-wide default markup — each account sells at its own account-wide
     markup, or per-service rules, or raw cost if nothing is set. Nothing applies
     to an account that hasn’t been explicitly priced. */
  const aPct=(c.client&&c.client.markup!=null&&c.client.markup!==""&&!isNaN(+c.client.markup)&&+c.client.markup!==0)?+c.client.markup:null;
  const aMin=(c.client&&c.client.markupMin!=null&&c.client.markupMin!==""&&!isNaN(+c.client.markupMin)&&+c.client.markupMin>0)?+c.client.markupMin:null;
  const num=(v)=>(v==null||v==="")?null:+v;
  const rules=c.rules;
  const prof=rules?(c.prof||rateProfileFor(rules,c.client&&c.client.id)):null;
  const key=rateSvcKey(label);
  const rule=prof&&prof.services&&prof.services[key];
  /* The rule's Min $ floor applies to EVERY path out of this function — including the fallbacks
     (blank %, missing list table, no zone). It used to vanish on fallback, so "Min $ 15 and no
     percent" priced with no floor at all: the exact "minimums not honored" bug. */
  const ruleMin=rule?num(rule.min):null;
  const fallback=()=>{
    let s;
    if(aPct!=null||aMin!=null){s=cost*(1+((aPct||0))/100);if(aMin!=null&&s<cost+aMin)s=cost+aMin;}
    else s=cost;
    if(ruleMin!=null&&s<ruleMin)s=ruleMin;
    return Math.round(s*100)/100;
  };
  if(!rules)return fallback();
  if(!rule)return fallback();
  let sell=null;
  let skipSvcMin=false;   // a break-range Min $ overrides the service Min $ (floor below still applies)
  if(rule.basis==="list"){
    const dom=c.fromZip&&c.toZip&&/^\d/.test(String(c.toZip));
    const zone=dom?String(zoneEst(c.fromZip,c.toZip)):null;
    const yr=String((prof&&prof.listYear)||"2026");
    const live=(c.list!=null&&c.list!==""&&!isNaN(+c.list))?+c.list:null;   // live FedEx LIST from the quote (current year)
    /* listYear 2025: never uses the live (current-year) list — prices off the Jan 2025 book
       (imported "list2025:" table first, then the built-in LIST_2025 dataset). */
    const list=yr==="2025"
      ?(zone!=null?(baseCostLookup(rules,"list2025:"+key,c.weight,zone)??list2025Lookup(key,c.weight,zone)):null)
      :(live!=null?live:(zone!=null?baseCostLookup(rules,"list:"+key,c.weight,zone):null));
    /* Weight breaks apply to list pricing too: the range's zone cell beats the range %,
       which beats the service % — all read as the DISCOUNT off list for that range. */
    let disc=num(rule.pct);
    let brkL=null;
    if(rule.breaks&&rule.breaks.length&&c.weight!=null){
      const sortedL=rule.breaks.filter(x=>x.upTo!=null&&x.upTo!=="").sort((a,b)=>+a.upTo-+b.upTo);
      brkL=sortedL.find(x=>+c.weight<=+x.upTo)||sortedL[sortedL.length-1]||null;
      if(brkL&&num(brkL.pct)!=null)disc=num(brkL.pct);
      if(brkL&&brkL.zones&&zone!=null){const bz=num(brkL.zones[String(zone)]);if(bz!=null)disc=bz;}
    }
    if(list==null||disc==null)return fallback();          // no live list and no table → honest fallback
    sell=list*(1-disc/100);
    const bmnL=brkL?num(brkL.min):null;
    if(bmnL!=null){ if(sell<bmnL)sell=bmnL; skipSvcMin=true; }   // per-range Min $ overrides the service Min $
  } else if(rule.basis==="fixed"){
    const amt=num(rule.pct); if(amt==null)return fallback();
    sell=cost+amt;
  } else if(rule.basis==="flat"){
    /* Always sells at exactly this price — cost only moves the margin, never the sell. */
    const amt=num(rule.pct); if(amt==null)return fallback();
    return Math.round(amt*100)/100;
  } else {
    /* Weight-break × zone matrix. Resolution, most specific wins:
       break's zone cell → rule-level zone % → break % → service %.
       Rule-level zones still beat a break's plain % (pre-existing behavior, unchanged). */
    let pct=num(rule.pct);
    const zn=(c.fromZip&&c.toZip&&/^\d/.test(String(c.toZip)))?String(zoneEst(c.fromZip,c.toZip)):null;
    let brk=null;
    if(rule.breaks&&rule.breaks.length&&c.weight!=null){
      const sorted=rule.breaks.filter(x=>x.upTo!=null&&x.upTo!=="").sort((a,b)=>+a.upTo-+b.upTo);
      brk=sorted.find(x=>+c.weight<=+x.upTo)||sorted[sorted.length-1]||null;
      if(brk&&num(brk.pct)!=null)pct=num(brk.pct);
    }
    if(rule.zones&&zn!=null){
      const zp=num(rule.zones[zn]);
      if(zp!=null)pct=zp;
    }
    if(brk&&brk.zones&&zn!=null){const bz=num(brk.zones[zn]);if(bz!=null)pct=bz;}
    if(pct==null)return fallback();
    sell=cost*(1+pct/100);
    const bmn=brk?num(brk.min):null;
    if(bmn!=null){ if(sell<bmn)sell=bmn; skipSvcMin=true; }   // per-range Min $ overrides the service Min $
  }
  const min=num(rule.min);
  if(!skipSvcMin&&min!=null&&sell<min)sell=min;
  /* Account "Min $ profit / label" floors EVERY rule path (it used to vanish whenever a rule
     priced a quote with no itemized fee lines — One Rate rows, local estimates — so the same
     account got the floor or not depending on whether FedEx happened to itemize a fee).
     Skipped on inner base-only calls: the wrapper floors the TOTAL against full carrier cost,
     and flooring the base separately would stack the floor on top of fee margin. */
  if(!c._noSurAdj&&aMin!=null&&sell<cost+aMin)sell=cost+aMin;
  return Math.round(sell*100)/100;
}
module.exports={zoneEst,RATE_ZONES,setDimCfg,dimFor,billable,ruleWeightFor,DEFAULT_RATE_RULES,FEDEX_SURCHARGES,RATE_SERVICES,canonSvc,rateSvcKey,fedexSurchargeIdFor,rateProfileFor,baseCostLookup,rateSellFor};
