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
ok(rateSellFor(20,"FedEx 2Day®",{rules:R2,surcharges:lines})===25,"flat service rule wins - adjustments skipped");
ok(rateSellFor(20,"FedEx 2Day®",{rules:R})===20,"no surcharge lines → unchanged pricing");
console.log(p+" passed, "+f+" failed");
process.exit(f?1:0);
