/* Rate-engine tests: per-surcharge live-quote adjustments (fuel, peak, DAS, GE fees) and the
   surcharge-line → catalog matcher. Extracts the REAL functions from src/App.jsx.
   Run: node claude/tests/rates.mjs */
import fs from "fs";
const src=fs.readFileSync("src/App.jsx","utf8");
function fn(name){const re=new RegExp("function "+name+"\\s*\\(");const m=re.exec(src);if(!m)throw new Error("fn "+name);let i=src.indexOf("){",m.index)+1,d=0;const st=m.index;for(;i<src.length;i++){if(src[i]==="{")d++;else if(src[i]==="}"){d--;if(d===0){i++;break;}}}return src.slice(st,i);}
function cn(name){const re=new RegExp("const "+name+"=[^;]*;");const m=re.exec(src);if(!m)throw new Error("const "+name);return m[0];}
const code=[cn("DEFAULT_RATE_RULES"),fn("rateSvcKey"),fn("fedexSurchargeIdFor"),fn("rateProfileFor"),fn("rateSellFor"),"return {rateSellFor,fedexSurchargeIdFor,rateSvcKey};"].join("\n");
const {rateSellFor,fedexSurchargeIdFor,rateSvcKey}=new Function("zoneEst","baseCostLookup","list2025Lookup",code)(()=>4,()=>null,()=>null);
let p=0,f=0;const ok=(c,l)=>{c?p++:(f++,console.log("  ✗ FAIL:",l));};
ok(fedexSurchargeIdFor("Fuel Surcharge","FedEx Home Delivery®")==="FUEL-G","fuel ground variant");
ok(fedexSurchargeIdFor("Fuel Surcharge","FedEx 2Day®")==="FUEL","fuel express variant");
ok(fedexSurchargeIdFor("Peak - Residential Delivery Charge","FedEx Home Delivery®")==="PEAK-R-G","peak residential ground");
ok(fedexSurchargeIdFor("Demand Surcharge","FedEx Ground Economy")==="PEAK-GE","peak GE");
ok(fedexSurchargeIdFor("Delivery And Return Charge","FedEx Ground Economy")==="GE-DR","GE delivery+return charge");
ok(fedexSurchargeIdFor("Delivery Area Surcharge Extended Residential","FedEx Home Delivery®")==="DAS-ER-HD","DAS ext resi HD");
ok(fedexSurchargeIdFor("Residential Delivery Surcharge","FedEx Priority Overnight®")==="RES","residential express");
ok(fedexSurchargeIdFor("Declared Value","FedEx 2Day®")==="INS","declared value");
ok(fedexSurchargeIdFor("Additional Handling Surcharge - Weight","FedEx Ground")==="AH-W-G","AH weight ground");
ok(fedexSurchargeIdFor("Totally Unknown Fee","FedEx Ground")===null,"unknown line → null (stays in service markup)");
const R={profiles:[{id:"default",name:"D",services:{},surcharges:{FUEL:{type:"percent",amount:50},"PEAK-R-G":{type:"fixed",amount:2},"FUEL-G":{type:"percent",amount:-100},"RES-HD":{type:"add",amount:1.5}}}],assign:{},baseCosts:{}};
const lines=[{label:"Fuel Surcharge",amount:2},{label:"Peak - Residential Delivery Charge",amount:1.5}];
ok(rateSellFor(20,"FedEx 2Day®",{rules:R,surcharges:lines})===21,"fuel +50% on express (peak line untouched)");
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:R,surcharges:lines})===18.5,"fuel waived (-100%) + peak flat $2 on ground");
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:R,surcharges:[...lines,{label:"Residential Delivery Surcharge",amount:4}]})===20,"$-over-cost adds exactly $1.50 on the $4 residential fee");
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:R,client:{id:"cX",markup:10},surcharges:lines})===20.15,"adjusted fees ride OUTSIDE the account markup");
const R2=JSON.parse(JSON.stringify(R));R2.profiles[0].services["2day"]={basis:"flat",pct:25,on:true};
ok(rateSellFor(20,"FedEx 2Day®",{rules:R2,surcharges:lines})===29.5,"flat prices the BASE; fees add on top (25 + fuel 3 + peak 1.5)");
ok(rateSellFor(20,"FedEx 2Day®",{rules:R})===20,"no surcharge lines → unchanged pricing");
// ── BASE-ONLY spec: service rules + Min $ price the base freight; fees priced separately ──
const R5={profiles:[{id:"default",name:"D",services:{
  "home":{basis:"percent",pct:"",min:8.92,on:true},
  "or_2day_small_box":{basis:"flat",pct:15.30,on:true},
  "ground":{basis:"list",pct:52,min:8.92,on:true},
},surcharges:{}}],assign:{},baseCosts:{}};
const hdLines=[{label:"Fuel Surcharge",amount:1.33},{label:"Residential Surcharge",amount:1.78}];
ok(rateSellFor(8.92,"FedEx Home Delivery®",{rules:R5,surcharges:hdLines})===12.03,"Min $ floors the BASE (5.81→8.92), fees pass through on top");
ok(rateSellFor(14.30,"FedEx 2Day® OneRate - Small Box",{rules:R5})===15.30,"OneRate flat $15.30 displays as exactly $15.30");
ok(rateSellFor(8.92,"FedEx Ground",{rules:R5,listBase:12.50,surcharges:hdLines})===12.03,"52% off LIST BASE (12.50→6.00) floored to Min $8.92 + fees 3.11");
ok(rateSellFor(8.92,"FedEx Ground",{rules:R5,listBase:25,surcharges:hdLines})===15.11,"above the floor: 48% of list base 25 = 12.00 + fees 3.11");
// % off LIST: fee billed $8 at account, $10 at list; 10% off list → sells $9 (removed 8, add 9 → +1 net)
const RL={profiles:[{id:"default",name:"D",services:{},surcharges:{"FUEL-G":{type:"listpct",amount:10}}}],assign:{},baseCosts:{}};
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:RL,surcharges:[{label:"Fuel Surcharge",amount:8,list:10}]})===21,"% off LIST prices the fee from its list amount");
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:RL,surcharges:[{label:"Fuel Surcharge",amount:8}]})===19.2,"% off LIST falls back to the billed amount when no list line");
// ── Min $ floors (the "minimums not honored" bug) ──
const R3={profiles:[{id:"default",name:"D",services:{
  "2day":{basis:"percent",pct:"",min:30,on:true},          // Min $ set, % left blank
  "ground":{basis:"list",pct:"",min:12,on:true},           // list basis with no table loaded
},surcharges:{"FUEL-G":{type:"percent",amount:-100}}}],assign:{},baseCosts:{}};
ok(rateSellFor(20,"FedEx 2Day®",{rules:R3})===30,"Min $ floors even with a blank percent");
ok(rateSellFor(8,"FedEx Ground",{rules:R3})===12,"Min $ floors the list-basis fallback (no table)");
ok(rateSellFor(50,"FedEx 2Day®",{rules:R3})===50,"above the floor, cost passes through untouched");
// account Min-$-profit floor must hold against the TRUE cost even when fees are discounted away
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:R3,client:{id:"cY",markupMin:10},surcharges:[{label:"Fuel Surcharge",amount:2}]})===30,"Min $ profit holds vs TRUE cost when a fee is waived");
// flat $0 on a fee: FedEx bills $5.55 residential on Home Delivery; customer pays $0 for it
const R6={profiles:[{id:"default",name:"D",services:{},surcharges:{"RES-HD":{type:"fixed",amount:0}}}],assign:{},baseCosts:{}};
const p6={};
ok(rateSellFor(15,"FedEx Home Delivery®",{rules:R6,surcharges:[{label:"Residential Surcharge",amount:5.55}],_parts:p6})===9.45,"flat $0 fee: total = base only (15 - 5.55 billed fee + 0 charged)");
ok(p6.fees&&p6.fees.length===1&&p6.fees[0].amount===0,"breakdown shows the fee line at exactly $0.00");
ok(p6.base===9.45,"breakdown base = the unmarked base");
// THE $25-fuel blunder: amount saved with NO type (editor displayed "% over cost") must price as PERCENT
const R7={profiles:[{id:"default",name:"D",services:{},surcharges:{"FUEL-G":{amount:25}}}],assign:{},baseCosts:{}};
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:R7,surcharges:[{label:"Fuel Surcharge",amount:1.33}]})===20.33,"typeless rule = percent: fuel $1.33 +25% → $1.66, NEVER $25 flat");
// every explicit mode on the same $2 fee (base 18 passes through, no service rule / markup)
const mk7=(t,amt)=>({profiles:[{id:"default",name:"D",services:{},surcharges:{"FUEL-G":{type:t,amount:amt}}}],assign:{},baseCosts:{}});
const l7=[{label:"Fuel Surcharge",amount:2,list:2.5}];
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:mk7("percent",25),surcharges:l7})===20.5,"percent 25 → fee $2.50");
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:mk7("percent",-50),surcharges:l7})===19,"percent -50 → fee $1.00 (discount)");
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:mk7("add",0.75),surcharges:l7})===20.75,"$ over cost 0.75 → fee $2.75");
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:mk7("listpct",10),surcharges:l7})===20.25,"% off list 10 → fee $2.25 (list 2.50)");
ok(rateSellFor(20,"FedEx Home Delivery®",{rules:mk7("fixed",5),surcharges:l7})===23,"flat $5 → fee exactly $5");
// ── audit F21/F22: profit floor + list-base pricing hold when FedEx itemizes NO fees ──
const R8={profiles:[{id:"default",name:"D",services:{"ground":{basis:"percent",pct:3},"or_2day_small_box":{basis:"flat",pct:15.30}},surcharges:{}}],assign:{},baseCosts:{}};
ok(rateSellFor(20,"FedEx Ground",{rules:R8,client:{id:"c2",markupMin:5}})===25,"profit floor holds on a rule path with NO fee lines (was skipped: $20.60)");
ok(rateSellFor(20,"FedEx Ground",{rules:R8,client:{id:"c2",markupMin:5},surcharges:[]})===25,"profit floor holds on a LIVE quote with zero itemized fees");
ok(rateSellFor(200,"FedEx Ground",{rules:R8,client:{id:"c2",markupMin:5}})===206,"above the floor the rule % stands (200\u00d71.03)");
ok(rateSellFor(14,"FedEx One Rate\u00ae 2Day - Small Box",{rules:R8,client:{id:"c2",markupMin:5},surcharges:[]})===15.3,"flat is EXEMPT from the profit floor: displays exactly $15.30 (live)");
ok(rateSellFor(14,"FedEx One Rate\u00ae 2Day - Small Box",{rules:R8,client:{id:"c2",markupMin:5}})===15.3,"flat exempt from the floor on the estimate path too");
// F22: empty account fee list + LIST fees present \u2192 base prices off LIST BASE, never list-total
const R9={profiles:[{id:"default",name:"D",services:{"ground":{basis:"list",pct:20}},surcharges:{}}],assign:{},baseCosts:{}};
ok(rateSellFor(18,"FedEx Ground",{rules:R9,list:25,listBase:22,surcharges:[]})===17.6,"list \u221220% prices off LIST BASE 22 \u2192 17.60 (not list-total 25 \u2192 20.00)");
ok(rateSellFor(18,"FedEx Ground",{rules:R9,list:25,surcharges:[]})===20,"no listBase on the quote \u2192 falls back to list-total");
// ── Pickup fee follows the Rates-tab accessorial rules ──
const pfCode=[cn("DEFAULT_RATE_RULES"),'const money=(v)=>"$"+(+v).toFixed(2);',fn("rateProfileFor"),fn("pickupFeeFor"),"return {pickupFeeFor};"].join("\n");
const {pickupFeeFor}=new Function(pfCode)();
ok(pickupFeeFor(null,null,"FDXE").fee===16.25,"pickup fee default $16.25 with no rules");
const RP={profiles:[{id:"default",name:"D",services:{},surcharges:{"PU-EXP":{type:"percent",amount:-35},"PU-GRD-OC":{type:"fixed",amount:5}}}],assign:{},baseCosts:{}};
ok(pickupFeeFor(RP,null,"FDXE").fee===10.56,"pickup fee honors a -35% rules-tab discount (16.25 → 10.56)");
ok(pickupFeeFor(RP,null,"FDXG").fee===5,"ground pickup flat $5 rule honored");
ok(pickupFeeFor(null,{id:"c1",markup:20},"FDXE").fee===19.5,"account markup applies when no rule (16.25 → 19.50)");
// ── NAME WIRING: every FedEx API service label keys to the exact Rates-tab service key ──
const qsrc=fs.readFileSync("netlify/functions/quote.js","utf8");
const svcMap=[...qsrc.matchAll(/([A-Z0-9_]+):\s*\{ key: "([a-z0-9_]+)",\s*label: "([^"]+)" \}/g)].map(m=>({api:m[1],key:m[2],label:m[3]}));
ok(svcMap.length>=22,"parsed the quote.js service map ("+svcMap.length+" services)");
for(const sv of svcMap) ok(rateSvcKey(sv.label)===sv.key,"service label → key: "+sv.label+" → "+sv.key);
// ── FEE NAME ROUND-TRIP: each row's on-quote name must match back to a row with the SAME name ──
function xconst(name){const i=src.indexOf("const "+name+"=");const j=src.indexOf("];",i);return src.slice(i,j+2);}
const CAT=new Function(xconst("FEDEX_SURCHARGES")+";return FEDEX_SURCHARGES;")();
const segSvc=(seg)=>seg==="Ground"||seg==="Ground & Home Delivery"?"FedEx Ground":seg==="Home Delivery"?"FedEx Home Delivery":seg==="Ground Economy"?"FedEx Ground Economy":"FedEx 2Day";
let rt=0;
for(const su of CAT){
  if(!su.aka)continue;
  const id=fedexSurchargeIdFor(su.aka,segSvc(su.seg||""));
  const hit=id&&CAT.find(x=>x.id===id);
  ok(hit&&(hit.aka===su.aka||hit.id===su.id),"fee name round-trip: "+su.id+" (“"+su.aka+"” on "+(su.seg||"All")+")");
  rt++;
}
ok(rt>=30,"round-tripped "+rt+" named fees");
// ── billable (dim) weight for rule lookups + Ground/Home exclusivity ──
{
  const ln=(name)=>{const m=new RegExp("const "+name+"=.*").exec(src);if(!m)throw new Error("ln "+name);return m[0];};
  const wcode=['const DIM=139;','let DIM_CFG={express:DIM,ground:DIM,ground_economy:DIM};',ln("dimFor"),ln("billable"),ln("ruleWeightFor"),"return {ruleWeightFor,billable};"].join("\n");
  const {ruleWeightFor,billable}=new Function(wcode)();
  ok(ruleWeightFor([{weight:5,L:20,W:20,H:20}],"FedEx Ground")===58,"5 lb 20x20x20 rates as 58 lb dim (8000/139)");
  ok(ruleWeightFor([{weight:4.75,L:1,W:1,H:1}],"FedEx 2Day")===5,"4 lb 12 oz bills as the next full pound");
  ok(ruleWeightFor([{weight:3}],"FedEx Ground")===3,"no dims → ceil(actual)");
  ok(ruleWeightFor([{weight:2,L:12,W:9,H:4},{weight:2,L:12,W:9,H:4}],"FedEx Ground")===8,"multi-piece sums per-piece billable (432/139→4 each)");
  ok(billable(12,12,12,2)===13,"12x12x12 light box → 13 lb dim");
}
{
  const ccode=[fn("canonSvc"),fn("svcFamilyKey"),fn("isIntlService"),fn("cleanServiceList"),"return {cleanServiceList};"].join("\n");
  const {cleanServiceList}=new Function("rateSvcKey",ccode)(rateSvcKey);
  const rows=[{label:"FedEx Ground",cost:10},{label:"FedEx Home Delivery",cost:11},{label:"FedEx 2Day",cost:20}];
  ok(cleanServiceList(rows,{residential:true}).every(q=>q.label!=="FedEx Ground"),"residential → Ground hidden");
  ok(cleanServiceList(rows,{residential:false}).every(q=>q.label!=="FedEx Home Delivery"),"commercial → Home Delivery hidden");
  ok(cleanServiceList(rows,{residential:null}).length===3,"unknown classification → both shown");
  const dup=[{label:"FedEx Ground®",cost:null},{label:"FedEx Ground",cost:12}];
  ok(cleanServiceList(dup,{residential:false}).length===1&&cleanServiceList(dup,{residential:false})[0].cost===12,"family dedupe keeps the priced row");
}
console.log(p+" passed, "+f+" failed");
process.exit(f?1:0);
