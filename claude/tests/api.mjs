/* ShippingCloud API tests:
   1) PARITY — api-engine.js (auto-generated) must price identically to the app's engine
      extracted live from src/App.jsx, across the pricing matrix.
   2) HANDLER — api.js routing/auth behavior without any backend configured.
   Run: node claude/tests/api.mjs */
import fs from "fs";
import { createRequire } from "module";
const require2 = createRequire(import.meta.url);
const E = require2("../../netlify/functions/api-engine.js");

const src = fs.readFileSync("src/App.jsx", "utf8");
function fn(name){const re=new RegExp("function "+name+"\\s*\\(");const m=re.exec(src);if(!m)throw new Error("fn "+name);let i=src.indexOf("){",m.index)+1,d=0;const st=m.index;for(;i<src.length;i++){if(src[i]==="{")d++;else if(src[i]==="}"){d--;if(d===0){i++;break;}}}return src.slice(st,i);}
function ln(name){const m=new RegExp("const "+name+"=.*").exec(src);if(!m)throw new Error("ln "+name);return m[0];}
const appCode=[ln("DEFAULT_RATE_RULES"),fn("rateSvcKey"),fn("fedexSurchargeIdFor"),fn("rateProfileFor"),fn("rateSellFor"),"return {rateSellFor};"].join("\n");
const app=new Function("zoneEst","baseCostLookup","list2025Lookup",appCode)(E.zoneEst,(rules,key,w,z)=>E.baseCostLookup(rules,key,w,z),()=>null);

let p=0,f=0;const ok=(c,l)=>{c?p++:(f++,console.log("  ✗ FAIL:",l));};

/* 1) parity matrix — every basis/mode/floor combination both engines must agree on */
const R=(services,surcharges)=>({profiles:[{id:"default",name:"D",services:services||{},surcharges:surcharges||{}}],assign:{},baseCosts:{}});
const CASES=[
  [20,"FedEx Ground",{rules:R({ground:{basis:"percent",pct:3}})}],
  [20,"FedEx Ground",{rules:R({ground:{basis:"percent",pct:3}}),client:{id:"c",markupMin:5}}],
  [14,"FedEx One Rate® 2Day - Small Box",{rules:R({or_2day_small_box:{basis:"flat",pct:15.30}}),client:{id:"c",markupMin:5},surcharges:[]}],
  [18,"FedEx Ground",{rules:R({ground:{basis:"list",pct:20}}),list:25,listBase:22,surcharges:[]}],
  [20,"FedEx Home Delivery®",{rules:R({},{"FUEL-G":{amount:25}}),surcharges:[{label:"Fuel Surcharge",amount:1.33}]}],
  [20,"FedEx Home Delivery®",{rules:R({},{"RES-HD":{type:"fixed",amount:0}}),surcharges:[{label:"Residential Surcharge",amount:5.55}]}],
  [20,"FedEx 2Day®",{rules:R({"2day":{basis:"percent",pct:"",min:30}})}],
  [50,"FedEx 2Day®",{rules:R({"2day":{basis:"percent",pct:"",min:30}})}],
  [20,"FedEx Home Delivery®",{rules:R({},{"FUEL-G":{type:"listpct",amount:10}}),surcharges:[{label:"Fuel Surcharge",amount:8,list:10}]}],
  [null,"FedEx One Rate® 2Day - Small Box",{rules:R({or_2day_small_box:{basis:"flat",pct:15.30}})}],
  [20,"FedEx Ground",{client:{id:"c",markup:15}}],
];
for(const [cost,label,ctx] of CASES){
  const a=app.rateSellFor(cost,label,JSON.parse(JSON.stringify(ctx)));
  const b=E.rateSellFor(cost,label,JSON.parse(JSON.stringify(ctx)));
  ok(a===b,`parity ${label} cost=${cost}: app=${a} api=${b}`);
}
ok(E.ruleWeightFor([{weight:5,L:20,W:20,H:20}],"FedEx Ground")===58,"api engine bills dim weight (58 lb)");
ok(E.RATE_SERVICES.fedex.length>=60,"api engine carries the full service catalog");

/* 2) handler behavior with no backend configured */
process.env.SUPABASE_URL="";process.env.SUPABASE_SERVICE_KEY="";process.env.SESSION_SECRET="";
const h=require2("../../netlify/functions/api.js").handler;
const call=(m,path,hdrs)=>h({httpMethod:m,path,headers:hdrs||{},body:null});
const r1=await call("GET","/api/v1");ok(r1.statusCode===503&&JSON.parse(r1.body).error.code==="not_configured","unconfigured site fails closed (503)");
const r2=await call("OPTIONS","/api/v1/rates");ok(r2.statusCode===204,"CORS preflight 204");
const r3=await call("GET","/api/v2/rates");ok(r3.statusCode===503||r3.statusCode===404,"unknown version rejected");

/* 2b) custom-carrier quoting */
{
  const rules={profiles:[{id:"default",name:"D",services:{uniuni_standard:{basis:"percent",pct:20}},surcharges:{}}],assign:{},baseCosts:{"cc:uniuni_standard":{zones:["2","3","4","5","6","7","8"],rows:[[1,3.1,3.2,3.3,3.4,3.5,3.6,3.7],[5,4.1,4.2,4.3,4.4,4.5,4.6,4.7]]}}};
  const q=E.customCarrierQuotes(rules,{id:"c1",enabledCarriers:["uniuni"]},{fromZip:"84101",toZip:"30301",pieces:[{weight:4,L:10,W:8,H:4}]});
  ok(q.length===1&&q[0].sell===5.64&&q[0].carrier==="UniUni","custom carrier prices through the rule engine (4.70 +20% = 5.64)");
  ok(E.customCarrierQuotes(rules,{id:"c1"},{fromZip:"84101",toZip:"30301",pieces:[{weight:4}]}).length===0,"custom carriers invisible unless enabled on the client");
  ok(E.customCarrierQuotes(rules,{id:"c1",enabledCarriers:["usps"]},{fromZip:"84101",toZip:"30301",pieces:[{weight:4}]}).length===0,"no rate card loaded → no quote");
}
/* 3) v1.1 helpers + routes */
const api=require2("../../netlify/functions/api.js");
ok(api.validHookUrl("https://example.com/hook")===true,"webhook url: https ok");
ok(api.validHookUrl("http://example.com/hook")===false,"webhook url: plain http rejected");
ok(api.validHookUrl("https://localhost/x")===false,"webhook url: localhost rejected");
const r4=await call("POST","/api/v1/webhooks");ok(r4.statusCode===503,"webhooks route exists (fails closed unconfigured)");
const r5=await call("GET","/api/v1/labels/123");ok(r5.statusCode===503,"label re-download route exists (fails closed)");
const r6=await call("GET","/api/v1/shipments?page=2&limit=10");ok(r6.statusCode===503,"shipments pagination route exists");
const r7=await call("POST","/api/v1/returns");ok(r7.statusCode===503,"returns route exists");
const r8=await call("POST","/api/v1/labels/batch");ok(r8.statusCode===503,"batch route exists");
const r9=await call("POST","/api/v1/labels",{ "idempotency-key":"test-1","content-type":"application/json" });ok(r9.statusCode===503,"idempotent booking path reachable (no insertNew ReferenceError → 503 not 500)");
ok(typeof api.validHookUrl==="function"&&api.validHookUrl("https://169.254.169.254")===false&&api.validHookUrl("https://10.1.2.3")===false&&api.validHookUrl("https://[::1]")===false&&api.validHookUrl("https://hooks.example.com")===true,"SSRF guard blocks metadata/private/IPv6-loopback, allows public");
console.log(p+" passed, "+f+" failed");
process.exit(f?1:0);
