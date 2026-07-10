/* Rate-engine tests: per-surcharge live-quote adjustments (fuel, peak, DAS, GE fees) and the
   surcharge-line → catalog matcher. Extracts the REAL functions from src/App.jsx.
   Run: node claude/tests/rates.mjs */
import fs from "fs";
const src=fs.readFileSync("src/App.jsx","utf8");
function fn(name){const re=new RegExp("function "+name+"\\s*\\(");const m=re.exec(src);if(!m)throw new Error("fn "+name);let i=src.indexOf("){",m.index)+1,d=0;const st=m.index;for(;i<src.length;i++){if(src[i]==="{")d++;else if(src[i]==="}"){d--;if(d===0){i++;break;}}}return src.slice(st,i);}
function cn(name){const re=new RegExp("const "+name+"=[^;]*;");const m=re.exec(src);if(!m)throw new Error("const "+name);return m[0];}
const code=[cn("DEFAULT_RATE_RULES"),fn("rateSvcKey"),fn("fedexSurchargeIdFor"),fn("surchargeAdjust"),fn("rateProfileFor"),fn("rateSellFor"),"return {rateSellFor,fedexSurchargeIdFor};"].join("\n");
const {rateSellFor,fedexSurchargeIdFor}=new Function("zoneEst","baseCostLookup","list2025Lookup",code)(()=>4,()=>null,()=>null);
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
console.log(p+" passed, "+f+" failed");
process.exit(f?1:0);
