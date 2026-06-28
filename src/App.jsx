import React, { useState, useMemo, useEffect } from "react";
import { Package, Truck, Users, Plug, Plus, Check, X, ChevronRight, ChevronDown, Wifi, WifiOff, Loader2, Trash2, ShoppingBag, ArrowLeftRight, Search, Calendar, Settings as Cog, Calculator, ExternalLink, Edit3, RotateCcw, MapPin, Printer, Building2, CreditCard, BarChart3, Layers, FileText, Undo2, Zap, Download, Boxes, CheckCircle2, AlertTriangle, TrendingUp, ShieldCheck, Mail, Cloud, Receipt, Wallet, Upload, Star, Send, Home, BookUser, DollarSign } from "lucide-react";


/* ════════ RATE ENGINE (demo) ════════ */
const DIM=139;
const billable=(L,W,H,a)=>Math.max(Math.ceil((L*W*H)/DIM),Math.ceil(a||0),1);
const zoneEst=(o,d)=>{const a=parseInt(String(o).slice(0,3)||"840",10);const b=parseInt(String(d).slice(0,3)||"840",10);return Math.min(8,Math.max(2,2+Math.round(Math.abs(a-b)/90)));};
const RATES={
  fedex_first:{carrier:"FedEx",base:62,pz:5.5,pl:3.2,fuel:.16,res:0,days:[1,1],label:"FedEx First Overnight®"},
  fedex_prio:{carrier:"FedEx",base:38,pz:4.2,pl:2.6,fuel:.16,res:0,days:[1,1],label:"FedEx Priority Overnight®"},
  fedex_std:{carrier:"FedEx",base:30,pz:3.6,pl:2.1,fuel:.16,res:0,days:[1,1],label:"FedEx Standard Overnight®"},
  fedex_2dayam:{carrier:"FedEx",base:22,pz:2.5,pl:1.5,fuel:.16,res:0,days:[2,2],label:"FedEx 2Day® A.M."},
  fedex_2day:{carrier:"FedEx",base:18,pz:2.2,pl:1.3,fuel:.16,res:0,days:[2,2],label:"FedEx 2Day®"},
  fedex_saver:{carrier:"FedEx",base:14,pz:1.6,pl:.9,fuel:.16,res:0,days:[3,3],label:"FedEx Express Saver®"},
  fedex_ground:{carrier:"FedEx",base:9.2,pz:.95,pl:.55,fuel:.16,res:4.2,days:[1,5],label:"FedEx Ground®"},
  fedex_home:{carrier:"FedEx",base:8.2,pz:.9,pl:.52,fuel:.16,res:0,days:[1,5],label:"FedEx Home Delivery®"},
  fedex_econ:{carrier:"FedEx",base:7.1,pz:.7,pl:.4,fuel:.12,res:0,days:[2,7],label:"FedEx Ground Economy"},
  ups_nda:{carrier:"UPS",base:40,pz:4.4,pl:2.7,fuel:.16,res:5.3,days:[1,1],label:"UPS Next Day Air®"},
  ups_2day:{carrier:"UPS",base:19,pz:2.3,pl:1.35,fuel:.16,res:5.3,days:[2,2],label:"UPS 2nd Day Air®"},
  ups_3day:{carrier:"UPS",base:15,pz:1.7,pl:1.0,fuel:.16,res:5.3,days:[3,3],label:"UPS 3 Day Select®"},
  ups_ground:{carrier:"UPS",base:8.5,pz:.95,pl:.55,fuel:.16,res:5.3,days:[1,5],label:"UPS® Ground"},
  usps_priority:{carrier:"USPS",base:9.6,pz:1.1,pl:.7,fuel:0,res:0,days:[1,3],label:"USPS Priority Mail®"},
  usps_ga:{carrier:"USPS",base:7.8,pz:.65,pl:.45,fuel:0,res:0,days:[2,5],label:"USPS Ground Advantage®"},
  fedex_intl_first:{carrier:"FedEx",intl:true,base:96,pl:9.5,fuel:.17,days:[1,3],label:"FedEx International First®"},
  fedex_intl_prio:{carrier:"FedEx",intl:true,base:78,pl:7.5,fuel:.17,days:[1,3],label:"FedEx International Priority®"},
  fedex_intl_econ:{carrier:"FedEx",intl:true,base:58,pl:5.5,fuel:.17,days:[2,5],label:"FedEx International Economy®"},
  fedex_intl_connect:{carrier:"FedEx",intl:true,base:42,pl:4.2,fuel:.15,days:[2,6],label:"FedEx International Connect Plus®"},
  dhl_express:{carrier:"DHL",intl:true,base:72,pl:7.0,fuel:.16,days:[1,3],label:"DHL Express Worldwide"},
  dhl_econ:{carrier:"DHL",intl:true,base:50,pl:4.8,fuel:.14,days:[2,5],label:"DHL Economy Select"},
};
const SERVICES=Object.keys(RATES);
function quoteRates(s){
  const zone=zoneEst(s.fromZip,s.toZip);
  const pieces=(s.pieces&&s.pieces.length)?s.pieces:[{weight:s.weight,L:s.L,W:s.W,H:s.H}];
  const bw=pieces.reduce((a,p)=>a+billable(p.L,p.W,p.H,p.weight),0);
  const n=pieces.length;
  const intl=!!s.intl;
  return SERVICES.filter(k=>!!RATES[k].intl===intl).map(k=>{
    const r=RATES[k];
    let c=r.intl?(r.base+r.pl*bw):(r.base+r.pz*(zone-2)+r.pl*Math.max(0,bw-1));
    c+=c*r.fuel;
    if(s.residential&&r.res)c+=r.res;
    if(s.signature)c+=6.15;
    if(n>1)c+=(n-1)*(r.intl?3.5:1.25);
    return{key:k,carrier:r.carrier,label:r.label,cost:Math.round(c*100)/100,minDays:r.days[0],maxDays:r.days[1]};
  });
}
const CARRIER_TINT={FedEx:"text-violet-600",UPS:"text-amber-700",USPS:"text-sky-600",DHL:"text-red-600"};
const CARRIER_ORDER=["FedEx","UPS","USPS","DHL"];
const TRACK_URL={FedEx:n=>`https://www.fedex.com/fedextrack/?trknbr=${n}`,UPS:n=>`https://www.ups.com/track?tracknum=${n}`,USPS:n=>`https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,DHL:n=>`https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`};
const carrierOf=l=>l.startsWith("UPS")?"UPS":l.startsWith("USPS")?"USPS":l.startsWith("DHL")?"DHL":"FedEx";
const money=n=>`$${Number(n).toFixed(2)}`;
const rnd=(n)=>Math.random().toString().slice(2,2+n);
const newTracking=carrier=>carrier==="UPS"?"1Z"+Math.random().toString(36).slice(2,10).toUpperCase():carrier==="USPS"?"9400"+rnd(18):carrier==="DHL"?rnd(10):rnd(12);

/* Live rates: calls the Netlify function that proxies England Logistics.
   Returns {live:true,rates:[...]} on success, or null so callers fall back
   to the local estimate. Works on the deployed Netlify site; in the chat
   preview there's no backend so it simply returns null (estimate is used). */
const RATES_ENDPOINT="/.netlify/functions/quote";
async function getLiveRates(s,england){
  if(!england||!england.enabled) return null;
  const body={fromZip:s.fromZip,toZip:s.toZip,fromCountry:s.fromCountry||"US",toCountry:s.toCountry||"US",residential:!!s.residential,pieces:(s.pieces||[]).map(p=>({weight:+p.weight||1,length:+p.L||12,width:+p.W||9,height:+p.H||4})),account:{base:england.base,apiKey:england.apiKey,customerId:england.customerId}};
  try{
    const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),12000);
    const r=await fetch(RATES_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:ctrl.signal});
    clearTimeout(t);
    if(!r.ok) return {live:false,error:`Server ${r.status}`,rates:[]};
    const data=await r.json();
    return data;
  }catch(e){ return {live:false,error:(e&&e.message)||"Network error",rates:[]}; }
}

/* ════════ SEED ════════ */
const SEED_CLIENTS=[{id:"c1",name:"Sparkle in Pink",markup:18,origin:"84003"},{id:"c2",name:"House accounts",markup:12,origin:"84057"}];
const SEED_ACCOUNTS=[{id:"a1",label:"England Logistics",provider:"england",account:"20601652",status:"connected",mode:"demo"}];
const SEED_ORDERS=[
  {id:1042,name:"#1042",customer:"Jenna Reyes",company:"",zip:"90210",city:"Beverly Hills",state:"CA",address1:"412 Canon Dr",phone:"310-555-0142",email:"jenna@example.com",total:"48.00",weight:2,items:"2× Ruffle Leggings",sku:"SIP-LEG-RUF",product:"Ruffle Leggings",status:"unfulfilled",date:"6/24"},
  {id:1043,name:"#1043",customer:"Marcus Lee",company:"",zip:"10001",city:"New York",state:"NY",address1:"88 W 28th St",phone:"212-555-0119",email:"marcus@example.com",total:"112.50",weight:5,items:"1× Tutu Set, 3× Hair Bows",sku:"SIP-TUTU-SET",product:"Tutu Set",status:"unfulfilled",date:"6/24"},
  {id:1044,name:"#1044",customer:"Priya Shah",company:"",zip:"60614",city:"Chicago",state:"IL",address1:"2210 N Halsted St",phone:"312-555-0173",email:"priya@example.com",total:"29.99",weight:1,items:"1× Onesie",sku:"SIP-ONESIE",product:"Onesie",status:"unfulfilled",date:"6/25"},
  {id:1045,name:"#1045",customer:"Dana Cole",company:"",zip:"33101",city:"Miami",state:"FL",address1:"701 Brickell Ave",phone:"305-555-0188",email:"dana@example.com",total:"76.20",weight:3,items:"1× Swim Set, 2× Sandals",sku:"SIP-SWIM-SET",product:"Swim Set",status:"unfulfilled",date:"6/25"},
];
const SCAN_CITIES=["Memphis, TN hub","Indianapolis, IN hub","Ontario, CA","Newark, NJ","Atlanta, GA hub","Local facility","Out for delivery"];
const seedShip=(dayAgo,carrier,service,name,city,state,zip,cost,weight,status,lastScan,onTime=true)=>({id:Math.floor(Math.random()*1e9),date:new Date(Date.now()-dayAgo*864e5).toLocaleDateString(),dayAgo,tracking:newTracking(carrier),carrier,service,recipient:{name,city,state,zip},sender:{},fromZip:"84003",toZip:zip,weight,dims:{L:12,W:9,H:4},pieces:[{weight,L:12,W:9,H:4}],cost,sell:Math.round(cost*1.18*100)/100,billTo:"sender",thirdAcct:"",status:status||(dayAgo>3?"Delivered":dayAgo>0?"In transit":"Label created"),lastScan:lastScan||"Origin scan",eta:new Date(Date.now()+Math.max(0,3-dayAgo)*864e5).toLocaleDateString(),onTime,reference:"",client:"Sparkle in Pink",intl:false});
const SEED_SHIPMENTS=[
  seedShip(0,"FedEx","FedEx Ground®","Avery Kim","Austin","TX","73301",9.4,3,"Label created","Label created"),
  seedShip(0,"UPS","UPS® Ground","Liam Ford","Reno","NV","89501",8.9,2,"In transit","Salt Lake City, UT"),
  seedShip(1,"FedEx","FedEx Home Delivery®","Mia Chen","Portland","OR","97201",10.2,4,"Out for delivery","Out for delivery — Portland, OR"),
  seedShip(1,"USPS","USPS Ground Advantage®","Noah Diaz","Tampa","FL","33601",7.6,1,"In transit","Atlanta, GA hub"),
  seedShip(2,"FedEx","FedEx 2Day®","Ella Brooks","Denver","CO","80201",19.3,3,"Exception","Delivery exception — address issue",false),
  seedShip(2,"DHL","DHL Express Worldwide","Sofia Rossi","Toronto","ON","M5V",41.0,3,"In transit","Cincinnati, OH gateway"),
  seedShip(3,"UPS","UPS® Ground","Owen Gray","Boise","ID","83701",8.1,2,"Delivered","Delivered — front porch"),
  seedShip(4,"FedEx","FedEx Ground®","Zoe Park","Mesa","AZ","85201",9.0,3,"Delivered","Delivered — received"),
  seedShip(5,"USPS","USPS Priority Mail®","Kai Reed","Salt Lake City","UT","84101",9.8,2,"Delivered","Delivered — mailbox",false),
  seedShip(6,"FedEx","FedEx Ground Economy","Ivy Lane","Fresno","CA","93650",7.2,1,"Delivered","Delivered — received"),
];
const SEED_RETURNS=[{id:9001,rma:"RMA-4471",customer:"Jenna Reyes",order:"#1039",reason:"Wrong size",carrier:"FedEx",tracking:newTracking("FedEx"),status:"In transit",date:new Date(Date.now()-864e5).toLocaleDateString()}];
const SEED_RULES=[
  {id:"r1",name:"Heavy → Ground",enabled:true,field:"weight",op:">",value:"10",action:"service",actionValue:"Cheapest Ground"},
  {id:"r2",name:"High-value → Signature",enabled:true,field:"value",op:">",value:"150",action:"signature",actionValue:"Require signature"},
];
const PRESETS=[{name:"Custom",L:12,W:9,H:4},{name:"Poly mailer",L:10,W:7,H:1},{name:"Small box",L:8,W:6,H:4},{name:"Medium box",L:12,W:9,H:6},{name:"Large box",L:16,W:12,H:8}];
const SEED_BOXES=[
  {id:"bx1",name:"Poly mailer S",L:10,W:7,H:1,maxWt:1,empty:0.1},
  {id:"bx2",name:"Poly mailer L",L:14,W:10,H:2,maxWt:3,empty:0.15},
  {id:"bx3",name:"Small box",L:8,W:6,H:4,maxWt:10,empty:0.3},
  {id:"bx4",name:"Medium box",L:12,W:9,H:6,maxWt:20,empty:0.5},
  {id:"bx5",name:"Large box",L:16,W:12,H:8,maxWt:35,empty:0.8},
  {id:"bx6",name:"XL box",L:20,W:16,H:12,maxWt:50,empty:1.2},
];
const boxVol=b=>b.L*b.W*b.H;
/* cartonization: pick the smallest box that fits item volume (+packing slack) and weight */
function pickBox(items,boxes,slack=1.30){
  const totalVol=items.reduce((a,it)=>a+(it.l*it.w*it.h)*(it.qty||1),0);
  const totalWt=items.reduce((a,it)=>a+(it.wt||0)*(it.qty||1),0);
  const need=totalVol*slack;
  const sorted=[...boxes].sort((a,b)=>boxVol(a)-boxVol(b));
  const fit=sorted.find(b=>boxVol(b)>=need&&b.maxWt>=totalWt);
  if(fit)return {box:fit,count:1,itemWt:totalWt,billWt:Math.round((totalWt+fit.empty)*10)/10,reason:"single box"};
  const big=sorted[sorted.length-1];
  const count=Math.max(1,Math.ceil(Math.max(need/boxVol(big),totalWt/big.maxWt)));
  return {box:big,count,itemWt:totalWt,billWt:Math.round((totalWt+big.empty*count)*10)/10,reason:`split into ${count} boxes`};
}
const CART_ITEMS=[
  {name:"Ruffle Leggings",l:8,w:6,h:1,wt:0.4,price:24},
  {name:"Tutu Set",l:10,w:8,h:3,wt:0.9,price:38},
  {name:"Onesie",l:7,w:5,h:1,wt:0.3,price:18},
  {name:"Swim Set",l:9,w:6,h:2,wt:0.5,price:32},
  {name:"Sandals",l:9,w:5,h:4,wt:0.7,price:22},
  {name:"Hair Bow (3pk)",l:5,w:4,h:2,wt:0.15,price:12},
];
const CHECKOUT_DEFAULTS={registered:true,presentation:"named",handling:0,freeThreshold:75,services:{fedex_ground:true,fedex_home:true,fedex_2day:true,fedex_prio:false,usps_ga:true,usps_priority:true,ups_ground:false}};

/* ════════ PLATFORM CARRIER ACCOUNTS ════════ */
const PLATFORM_CARRIERS=[
  {id:"ups",name:"UPS",blurb:"ShippingCloud negotiated UPS rates",tint:"text-amber-700"},
  {id:"usps",name:"USPS",blurb:"Commercial Plus pricing via ShippingCloud",tint:"text-sky-600"},
  {id:"amazon",name:"Amazon Shipping",blurb:"Amazon's ground & next-day network",tint:"text-stone-700"},
  {id:"uniuni",name:"UniUni",blurb:"Last-mile DSP for lightweight e-comm",tint:"text-violet-600"},
];
const PLATFORM_DEFAULTS={ups:true,usps:true,amazon:false,uniuni:false};

/* ════════ SUBSCRIPTION PLANS ════════ */
const PLANS=[
  {id:"free",name:"Free",price:0,tagline:"Kick the tires",limits:"25 labels / mo",features:["1 store integration","Single user","Standard rates","Email support"]},
  {id:"starter",name:"Starter",price:29,tagline:"Solo shippers",limits:"500 labels / mo",features:["3 store integrations","Box logic & presets","Branded tracking page","Batch printing"]},
  {id:"pro",name:"Pro",price:79,tagline:"Growing brands",limits:"2,500 labels / mo",features:["Unlimited integrations","Live checkout rates","Invoice auditing","5 team seats","Custom markup per client"]},
  {id:"scale",name:"Scale",price:199,tagline:"High volume",limits:"Unlimited labels",features:["Everything in Pro","API access","Multi-tenant logins","Dedicated support","SLA & onboarding"]},
];

/* ════════ LEDGER + INVOICE SEEDS ════════ */
const SEED_LEDGER=[
  {id:"l1",date:new Date(Date.now()-6*864e5).toLocaleDateString(),type:"Funds added",ref:"ACH deposit",amount:500},
  {id:"l2",date:new Date(Date.now()-5*864e5).toLocaleDateString(),type:"Shipping charge",ref:"#1039",amount:-11.34},
  {id:"l3",date:new Date(Date.now()-4*864e5).toLocaleDateString(),type:"Shipping charge",ref:"#1037",amount:-9.02},
  {id:"l4",date:new Date(Date.now()-3*864e5).toLocaleDateString(),type:"Adjustment",ref:"FedEx audit refund",amount:4.18},
  {id:"l5",date:new Date(Date.now()-2*864e5).toLocaleDateString(),type:"Adjustment",ref:"Dim-weight correction",amount:-2.40},
];
const SEED_INVOICES=[
  {id:"inv1",number:"INV-1001",client:"Sparkle in Pink",date:new Date(Date.now()-7*864e5).toLocaleDateString(),labels:42,amount:512.88,status:"Paid"},
  {id:"inv2",number:"INV-1002",client:"Sparkle in Pink",date:new Date(Date.now()-1*864e5).toLocaleDateString(),labels:18,amount:214.60,status:"Open"},
];

/* analytics + utilities */
function analytics(shipments){
  const v=shipments.filter(s=>s.status!=="Voided");
  const spend=v.reduce((a,s)=>a+s.cost,0),revenue=v.reduce((a,s)=>a+s.sell,0);
  const byCarrier={}; v.forEach(s=>byCarrier[s.carrier]=(byCarrier[s.carrier]||0)+1);
  const byClient={}; v.forEach(s=>{const c=s.client||"—";byClient[c]=byClient[c]||{count:0,spend:0,rev:0};byClient[c].count++;byClient[c].spend+=s.cost;byClient[c].rev+=s.sell;});
  const byDay=Array(7).fill(0); v.forEach(s=>{const d=s.dayAgo??0;if(d<7)byDay[6-d]++;});
  return {count:v.length,spend,revenue,profit:revenue-spend,avg:v.length?spend/v.length:0,byCarrier,byClient,byDay};
}
function validateAddress(a){
  const issues=[];
  if(!a.address1)issues.push("Street address missing");
  if(!/^\d{5}(-\d{4})?$/.test(String(a.zip||"")))issues.push("ZIP looks invalid");
  if(!a.city)issues.push("City missing");
  if(!a.state)issues.push("State missing");
  const fixed={...a,state:String(a.state||"").toUpperCase().slice(0,2),city:String(a.city||"").trim()};
  return {ok:issues.length===0,issues,fixed};
}
function downloadCSV(name,rows){
  const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  const a=document.createElement("a");a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);
}

/* ════════ EMAIL SEED ════════ */
const SEED_EMAILS=[
  {id:"e1",date:new Date(Date.now()-3600e3).toLocaleString(),to:"jenna@example.com",subject:"Your order #1039 is on its way ☁️",type:"Shipped",status:"sent"},
  {id:"e2",date:new Date(Date.now()-7200e3).toLocaleString(),to:"marcus@example.com",subject:"Delivered: your order #1037 ☁️",type:"Delivered",status:"sent"},
];
const NOTIFY_DEFAULTS={orderConfirm:true,shipped:true,delivered:true,returnLabel:true,exception:true};

/* ════════ INTERNATIONAL ════════ */
const COUNTRIES=["United States","Canada","Mexico","United Kingdom","Germany","France","Australia","Japan","South Korea","Brazil","Netherlands","Spain"];
const INCOTERMS=["DAP — Delivered at Place","DDP — Delivered Duty Paid","EXW — Ex Works","FCA — Free Carrier","CPT — Carriage Paid To"];
const EXPORT_REASONS=["Sale","Gift","Sample","Return","Repair","Personal use"];
const HTS_SUGGEST=[
  {code:"6111.20.6020",desc:"Babies' garments, knit cotton"},
  {code:"6209.20.5050",desc:"Babies' garments, woven cotton"},
  {code:"6204.62.8011",desc:"Girls' trousers, cotton"},
  {code:"6402.99.3165",desc:"Footwear, rubber/plastic"},
  {code:"6117.80.8500",desc:"Hair accessories / bows"},
  {code:"9503.00.0073",desc:"Toys & playthings"},
  {code:"6110.20.2079",desc:"Sweaters/pullovers, cotton"},
];

/* ════════ APP ════════ */
export default function App(){
  const [tab,setTab]=useState("ship");
  const [clients,setClients]=useState(SEED_CLIENTS);
  const [clientId,setClientId]=useState("c1");
  const [accounts,setAccounts]=useState(SEED_ACCOUNTS);
  const [orders,setOrders]=useState(SEED_ORDERS);
  const [shipments,setShipments]=useState(SEED_SHIPMENTS);
  const [pickups,setPickups]=useState([]);
  const [returns,setReturns]=useState(SEED_RETURNS);
  const [manifests,setManifests]=useState([]);
  const [rules,setRules]=useState(SEED_RULES);
  const [drafts,setDrafts]=useState([]);
  const [emails,setEmails]=useState(SEED_EMAILS);
  const [ledger,setLedger]=useState(SEED_LEDGER);
  const [invoices,setInvoices]=useState(SEED_INVOICES);
  const [qq,setQQ]=useState(false);
  const [prefill,setPrefill]=useState(null);
  const [settings,setSettings]=useState({company:"Sparkle in Pink",sender:{name:"Matt Goeckeritz",company:"Riley Blake Designs",zip:"84003",state:"UT",city:"Lehi",address1:"4060 W 2100 N",phone:"801-816-0540",email:"spencertesttes@test.com"},defaultBillTo:"sender",thirdPartyAccts:[{id:"tp1",carrier:"FedEx",account:"20601652",label:"England FedEx"}],shopify:true,notify:NOTIFY_DEFAULTS,boxes:SEED_BOXES,checkout:CHECKOUT_DEFAULTS,platforms:PLATFORM_DEFAULTS,plan:"starter",england:{enabled:false,base:"https://englandship.rocksolidinternet.com",apiKey:"",customerId:"",account:"20601652"},addresses:[{id:"ab1",name:"Riley Blake Designs",city:"Lehi",state:"UT",zip:"84003",address1:"4060 W 2100 N"}]});

  const client=clients.find(c=>c.id===clientId)||clients[0];
  const logEmail=(e)=>setEmails(p=>[{id:"e"+Date.now()+Math.random(),date:new Date().toLocaleString(),status:"sent",...e},...p]);
  const addLedger=(entry)=>setLedger(l=>[{id:"l"+Date.now()+Math.random(),date:new Date().toLocaleDateString(),...entry},...l]);

  const goShip=(pf)=>{setPrefill(pf);setTab("ship");};
  const onShipped=(rec,orderId)=>{
    setShipments(p=>[{...rec,dayAgo:0,client:client.name},...p]);
    if(orderId) setOrders(o=>o.map(x=>x.id===orderId?{...x,status:"fulfilled",tracking:rec.tracking}:x));
    if(settings.notify.shipped&&rec.recipient?.name) logEmail({to:(rec.recipient?.email)||"customer@example.com",subject:`Your ${settings.company} order has shipped ☁️`,type:"Shipped"});
    addLedger({type:"Shipping charge",ref:rec.reference||rec.tracking,amount:-(rec.sell||0)});
  };

  const TABS=[["ship","Ship",Package],["dashboard","Dashboard",BarChart3],["orders","Orders",ShoppingBag],["batch","Batch",Layers],["shipments","Shipments",Truck],["drafts","Drafts",FileText],["returns","Returns",Undo2],["pickups","Pickups",Calendar],["invoices","Invoices",Receipt],["ledger","Ledger",Wallet],["addresses","Address Book",BookUser],["settings","Settings",Cog]];
  const unfulfilled=orders.filter(o=>o.status==="unfulfilled").length;

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800" style={{fontFamily:"ui-sans-serif,system-ui,sans-serif"}}>
      <header className="border-b border-stone-200 sticky top-0 z-20 bg-white/90 backdrop-blur">
        <div className="px-4 h-14 flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center"><Cloud className="w-5 h-5 text-blue-600"/></span>
          <span className="font-extrabold tracking-tight text-[17px]">Shipping<span className="text-blue-600">Cloud</span></span>
          <div className="flex-1"/>
          <button onClick={()=>setQQ(true)} className="flex items-center gap-1.5 text-sm bg-stone-900 text-white rounded-lg px-3 py-2 font-medium hover:bg-stone-800"><Calculator className="w-4 h-4"/>Quick quote</button>
        </div>
      </header>
      {qq&&<QuickQuote onClose={()=>setQQ(false)} client={client} england={settings.england}/>}
      <div className="flex">
        <aside className="w-52 shrink-0 border-r border-stone-200 bg-white min-h-screen">
          <nav className="p-2 space-y-0.5 sticky top-14">
            {TABS.map(([id,l,Icon])=>(
              <button key={id} onClick={()=>setTab(id)} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm ${tab===id?"bg-blue-50 text-blue-700 font-medium":"text-stone-600 hover:bg-stone-100"}`}>
                <Icon className="w-4 h-4 shrink-0"/><span className="flex-1 text-left">{l}</span>{id==="orders"&&unfulfilled>0&&<span className="text-[10px] bg-blue-600 text-white rounded-full px-1.5 py-0.5 leading-none">{unfulfilled}</span>}
              </button>
            ))}
          </nav>
        </aside>
        <main className="flex-1 min-w-0 px-4 sm:px-6 py-6">
          {tab==="dashboard"&&<Dashboard shipments={shipments} orders={orders} returns={returns} goTab={setTab}/>}
          {tab==="ship"&&<Ship client={client} accounts={accounts} orders={orders} settings={settings} rules={rules} drafts={drafts} setDrafts={setDrafts} prefill={prefill} clearPrefill={()=>setPrefill(null)} onShipped={onShipped} logEmail={logEmail}/>}
          {tab==="orders"&&<Orders orders={orders} setOrders={setOrders} goShip={goShip} client={client} settings={settings} onShipped={onShipped}/>}
          {tab==="batch"&&<Batch orders={orders} setOrders={setOrders} client={client} rules={rules} onShipped={onShipped}/>}
          {tab==="shipments"&&<Shipments shipments={shipments} setShipments={setShipments} goShip={goShip}/>}
          {tab==="drafts"&&<Drafts drafts={drafts} setDrafts={setDrafts} goShip={goShip}/>}
          {tab==="returns"&&<Returns returns={returns} setReturns={setReturns} orders={orders} settings={settings} logEmail={logEmail}/>}
          {tab==="pickups"&&<Pickups pickups={pickups} setPickups={setPickups} settings={settings}/>}
          {tab==="invoices"&&<Invoices invoices={invoices} setInvoices={setInvoices} shipments={shipments} client={client}/>}
          {tab==="ledger"&&<Ledger ledger={ledger} addLedger={addLedger}/>}
          {tab==="addresses"&&<AddressBook settings={settings} setSettings={setSettings}/>}
          {tab==="settings"&&<Settings settings={settings} setSettings={setSettings} accounts={accounts} setAccounts={setAccounts} clients={clients} setClients={setClients} rules={rules} setRules={setRules} emails={emails} shipments={shipments} setShipments={setShipments} manifests={manifests} setManifests={setManifests} client={client}/>}
        </main>
      </div>
    </div>
  );
}

/* ════════ SHIP ════════ */
function Ship({client,accounts,orders,settings,rules,drafts,setDrafts,prefill,clearPrefill,onShipped,logEmail}){
  const empty={country:"United States",name:"",company:"",zip:"",state:"",city:"",address1:"",address2:"",address3:"",phone:"",email:""};
  const [sender,setSender]=useState({country:"United States",...settings.sender,address2:"STE A",address3:""});
  const [receiver,setReceiver]=useState({...empty,zip:"90210"});
  const [reference,setReference]=useState("");
  const [invoiceNo,setInvoiceNo]=useState("");
  const [poNo,setPoNo]=useState("");
  const [returnDiff,setReturnDiff]=useState(false);
  const [pieces,setPieces]=useState([{weight:3,L:12,W:9,H:4}]);
  const [insurance,setInsurance]=useState("");
  const [residential,setRes]=useState(true);
  const [signature,setSig]=useState(false);
  const [billTo,setBillTo]=useState(settings.defaultBillTo||"sender");
  const [thirdAcct,setThirdAcct]=useState("");
  const [bought,setBought]=useState(null);
  const [selectedOrder,setSelectedOrder]=useState(null);
  const [verify,setVerify]=useState(null);
  const [saved,setSaved]=useState(false);
  const [emailTo,setEmailTo]=useState("");
  const [sent,setSent]=useState("");
  const [customs,setCustoms]=useState({reason:"Sale",incoterm:INCOTERMS[0],dutiesBill:"receiver",lines:[{desc:"",hts:"",origin:"United States",qty:1,value:"",weight:""}]});
  const [showCI,setShowCI]=useState(false);

  const intl=!!receiver.country&&receiver.country!=="United States";
  const setPiece=(i,patch)=>setPieces(ps=>ps.map((p,j)=>j===i?{...p,...patch}:p));
  const addPiece=()=>setPieces(ps=>[...ps,{weight:1,L:12,W:9,H:4}]);
  const delPiece=(i)=>setPieces(ps=>ps.length>1?ps.filter((_,j)=>j!==i):ps);
  const totalWeight=pieces.reduce((a,p)=>a+(+p.weight||0),0);
  const setLine=(i,patch)=>setCustoms(c=>({...c,lines:c.lines.map((l,j)=>j===i?{...l,...patch}:l)}));
  const addLine=()=>setCustoms(c=>({...c,lines:[...c.lines,{desc:"",hts:"",origin:"United States",qty:1,value:"",weight:""}]}));
  const delLine=(i)=>setCustoms(c=>({...c,lines:c.lines.length>1?c.lines.filter((_,j)=>j!==i):c.lines}));
  const customsTotal=customs.lines.reduce((a,l)=>a+(+l.qty||0)*(+l.value||0),0);

  /* auto-verify receiver address + classify commercial vs residential */
  useEffect(()=>{
    const core=receiver.address1&&/^\d{5}/.test(receiver.zip||"")&&receiver.city&&receiver.state;
    if(!core){setVerify(null);return;}
    const r=validateAddress(receiver);
    const type=(receiver.company&&receiver.company.trim())?"Commercial":"Residential";
    setVerify({ok:r.ok,issues:r.issues,type});
    setRes(type==="Residential");
  },[receiver.address1,receiver.zip,receiver.city,receiver.state,receiver.company]);

  const applyOrder=(o)=>{setSelectedOrder(o.id);setReference(o.name);setReceiver({...empty,name:o.customer||"",company:o.company||"",zip:o.zip||"",state:o.state||"",city:o.city||"",address1:o.address1||"",phone:o.phone||"",email:o.email||""});setPieces([{weight:o.weight||1,L:12,W:9,H:4}]);};
  useEffect(()=>{ if(!prefill)return;
    if(prefill.draft){const s=prefill.draft;setSender(s.sender);setReceiver(s.receiver);setReference(s.reference||"");setInvoiceNo(s.invoiceNo||"");setPoNo(s.poNo||"");setPieces(s.pieces||[{weight:3,L:12,W:9,H:4}]);setRes(s.residential);setSig(s.signature);setBillTo(s.billTo);setThirdAcct(s.thirdAcct||"");setInsurance(s.insurance||"");setSelectedOrder(s.selectedOrder||null);if(s.customs)setCustoms(s.customs);clearPrefill();return;}
    if(prefill.receiver)setReceiver({...empty,...prefill.receiver}); if(prefill.weight)setPieces([{weight:prefill.weight,L:12,W:9,H:4}]); if(prefill.reference)setReference(prefill.reference); setSelectedOrder(prefill.fromOrderId||null); clearPrefill();
  },[prefill]);

  const swap=()=>{const s=sender;setSender(receiver);setReceiver(s);};
  const ready=/^\d{5}/.test(receiver.zip||"")&&totalWeight>0;
  const shipment={fromZip:sender.zip||client.origin,toZip:receiver.zip,pieces,residential,signature,intl};
  const localQuotes=()=>quoteRates(shipment).filter(q=>intl?true:(residential?q.key!=="fedex_ground":q.key!=="fedex_home"));
  const [rateSrc,setRateSrc]=useState({rates:[],live:false,loading:false,error:null});
  useEffect(()=>{
    let cancel=false;
    if(!ready){setRateSrc({rates:localQuotes(),live:false,loading:false,error:null});return;}
    const eng=settings.england;
    if(eng&&eng.enabled&&eng.apiKey&&eng.customerId){
      setRateSrc(s=>({...s,loading:true,error:null}));
      getLiveRates(shipment,eng).then(res=>{ if(cancel)return;
        if(res&&res.live&&res.rates&&res.rates.length) setRateSrc({rates:res.rates,live:true,loading:false,error:null});
        else setRateSrc({rates:localQuotes(),live:false,loading:false,error:(res&&res.error)||null});
      });
    } else setRateSrc({rates:localQuotes(),live:false,loading:false,error:null});
    return ()=>{cancel=true;};
  },[JSON.stringify(pieces),receiver.zip,sender.zip,residential,signature,intl,settings.england]);
  const quotes=useMemo(()=>rateSrc.rates.map(q=>({...q,sell:Math.round(q.cost*(1+client.markup/100)*100)/100})).sort((a,b)=>a.sell-b.sell),[rateSrc,client.markup]);
  const best=quotes[0]?.key;

  const print=(q)=>{
    const carrier=carrierOf(q.label);
    const rec={id:Date.now(),date:new Date().toLocaleDateString(),tracking:newTracking(carrier),carrier,service:q.label,recipient:{...receiver},sender:{...sender},fromZip:sender.zip,toZip:receiver.zip,weight:totalWeight,pieces:pieces.map(p=>({...p})),dims:pieces[0],insurance,cost:q.cost,sell:q.sell,billTo,thirdAcct,status:"Label created",lastScan:"Label created",eta:"—",onTime:true,reference,invoiceNo,poNo,residential,intl,customs:intl?{...customs,total:customsTotal,ci:"CI-"+rnd(5)}:null};
    onShipped(rec,selectedOrder);
    setBought(q.key);setTimeout(()=>setBought(null),1800);
  };
  const sendEmail=()=>{const to=emailTo||receiver.email||"customer@example.com";logEmail&&logEmail({to,subject:`Tracking for your ${settings.company} shipment ☁️`,type:"Shipped"});setSent("email");setTimeout(()=>setSent(""),1800);};
  const sendLabel=()=>{const to=emailTo||receiver.email||"customer@example.com";logEmail&&logEmail({to,subject:`Your shipping label from ${settings.company}`,type:"Label"});setSent("label");setTimeout(()=>setSent(""),1800);};

  const ordersToShow=orders.filter(o=>o.status==="unfulfilled");
  const saveDraft=()=>{const d={id:Date.now(),label:reference||receiver.name||receiver.city||"Untitled",when:new Date().toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}),to:`${receiver.city||""}${receiver.state?", "+receiver.state:""}`,snap:{sender,receiver,reference,invoiceNo,poNo,pieces,residential,signature,billTo,thirdAcct,insurance,selectedOrder,customs}};setDrafts(p=>[d,...p]);setSaved(true);setTimeout(()=>setSaved(false),1600);};
  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <aside className="lg:w-64 shrink-0 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-stone-500 mb-1"><ShoppingBag className="w-4 h-4"/>Orders</div>
        {ordersToShow.length===0?<div className="border border-dashed border-stone-300 rounded-lg p-4 text-center text-xs text-stone-400">No unfulfilled orders.</div>:ordersToShow.map(o=>(
          <button key={o.id} onClick={()=>applyOrder(o)} className={`w-full text-left border rounded-lg p-3 transition-colors ${selectedOrder===o.id?"border-blue-400 bg-blue-50":"border-stone-200 bg-white hover:border-stone-300"}`}>
            <div className="flex items-center justify-between"><span className="font-semibold text-sm text-stone-800">{o.name}</span><span className="font-mono text-xs text-stone-400">${o.total}</span></div>
            <div className="text-xs text-stone-600 mt-0.5">{o.customer}</div>
            <div className="text-[11px] text-stone-400 mt-0.5">{o.city}, {o.state} {o.zip}</div>
            <div className="text-[11px] text-stone-400 truncate">{o.items}</div>
          </button>
        ))}
        <div className="text-[11px] text-stone-400 pt-2">Saved drafts now live in the <b>Drafts</b> tab.</div>
      </aside>
      <div className="flex-1 min-w-0 space-y-4">
        <div className="flex flex-wrap items-end gap-3 border border-stone-200 rounded-lg bg-white p-3">
          <div><div className="text-[10px] uppercase tracking-widest text-stone-400">Ship date</div><div className="text-sm font-mono text-stone-800 py-1">{new Date().toLocaleDateString()}</div></div>
          <div className="flex-1 min-w-0"><div className="text-[10px] uppercase tracking-widest text-stone-400">Invoice #</div><input value={invoiceNo} onChange={e=>setInvoiceNo(e.target.value)} placeholder="INV-…" className="w-full bg-transparent text-sm outline-none border-b border-stone-200 focus:border-blue-500 py-1 placeholder-stone-300"/></div>
          <div className="flex-1 min-w-0"><div className="text-[10px] uppercase tracking-widest text-stone-400">PO #</div><input value={poNo} onChange={e=>setPoNo(e.target.value)} placeholder="PO-…" className="w-full bg-transparent text-sm outline-none border-b border-stone-200 focus:border-blue-500 py-1 placeholder-stone-300"/></div>
          <div className="flex-1 min-w-0"><div className="text-[10px] uppercase tracking-widest text-stone-400">Reference #</div><input value={reference} onChange={e=>setReference(e.target.value)} placeholder="order / ref" className="w-full bg-transparent text-sm outline-none border-b border-stone-200 focus:border-blue-500 py-1 placeholder-stone-300"/></div>
          <button onClick={saveDraft} className={`flex items-center gap-1.5 text-sm rounded px-3 py-2 font-medium ${saved?"bg-emerald-600 text-white":"bg-stone-200 text-stone-700 hover:bg-stone-300"}`}>{saved?<><Check className="w-4 h-4"/>Saved</>:<><FileText className="w-4 h-4"/>Save draft</>}</button>
        </div>
        <div className="relative grid lg:grid-cols-2 gap-4">
          <AddressCard title="Sender" data={sender} set={setSender}/>
          <button onClick={swap} title="Swap" className="hidden lg:flex absolute left-1/2 top-6 -translate-x-1/2 z-10 w-9 h-9 items-center justify-center rounded-full bg-stone-200 border border-stone-300 hover:bg-stone-300 text-stone-700"><ArrowLeftRight className="w-4 h-4"/></button>
          <AddressCard title="Receiver" data={receiver} set={setReceiver} required residential={residential} setResidential={setRes}/>
        </div>
        {intl&&<div className="flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2"><MapPin className="w-4 h-4"/>International shipment to <b>{receiver.country}</b> — FedEx &amp; DHL rates shown, customs info required below.</div>}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {verify?(verify.ok
            ?<span className="flex items-center gap-1.5 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1 font-medium"><CheckCircle2 className="w-3.5 h-3.5"/>Address verified</span>
            :<span className="flex items-center gap-1.5 text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-2.5 py-1 font-medium"><AlertTriangle className="w-3.5 h-3.5"/>{verify.issues.join(" · ")}</span>)
            :<span className="flex items-center gap-1.5 text-stone-400"><ShieldCheck className="w-3.5 h-3.5"/>Verifying as you type…</span>}
          {verify&&<span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium border ${verify.type==="Residential"?"text-blue-700 bg-blue-50 border-blue-200":"text-stone-700 bg-stone-100 border-stone-200"}`}>{verify.type==="Residential"?<Home className="w-3.5 h-3.5"/>:<Building2 className="w-3.5 h-3.5"/>}{verify.type}</span>}
        </div>

        <div className="bg-stone-100 border border-stone-200 rounded-lg p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] uppercase tracking-widest text-stone-600 font-semibold">Packages · {pieces.length}</div>
            <div className="flex items-center gap-4">
              <span className="text-[11px] text-stone-400 font-mono">total {totalWeight} lb</span>
              <div className="flex items-center gap-1"><span className="text-[10px] uppercase tracking-widest text-stone-500">Insure $</span><input type="number" value={insurance} onChange={e=>setInsurance(e.target.value)} placeholder="0" className="w-16 bg-white border border-stone-300 rounded px-2 py-1 text-sm font-mono outline-none focus:border-blue-500 placeholder-stone-300"/></div>
              <Toggle on={signature} set={setSig} label="Signature"/>
            </div>
          </div>
          {pieces.map((p,i)=>(
            <div key={i} className="flex flex-wrap items-end gap-2 bg-white border border-stone-200 rounded px-2 py-2">
              <div className="text-[11px] text-stone-400 font-mono w-6">#{i+1}</div>
              <div><div className="text-[10px] uppercase tracking-widest text-stone-500">Box</div><select onChange={e=>{const pr=(settings.boxes||SEED_BOXES)[+e.target.value];if(pr)setPiece(i,{L:pr.L,W:pr.W,H:pr.H,weight:p.weight});}} className="bg-white border border-stone-300 rounded px-2 py-1 text-sm outline-none focus:border-blue-500"><option value="-1">Custom</option>{(settings.boxes||SEED_BOXES).map((pr,j)=><option key={pr.id} value={j}>{pr.name}</option>)}</select></div>
              <PkgInput label="Wt (lb)" value={p.weight} onChange={e=>setPiece(i,{weight:+e.target.value})} w="w-16"/>
              <PkgInput label="L" value={p.L} onChange={e=>setPiece(i,{L:+e.target.value})}/>
              <PkgInput label="W" value={p.W} onChange={e=>setPiece(i,{W:+e.target.value})}/>
              <PkgInput label="H" value={p.H} onChange={e=>setPiece(i,{H:+e.target.value})}/>
              {pieces.length>1&&<button onClick={()=>delPiece(i)} className="text-stone-300 hover:text-rose-500 mb-1"><Trash2 className="w-4 h-4"/></button>}
            </div>
          ))}
          <button onClick={addPiece} className="flex items-center gap-1 text-xs bg-stone-200 hover:bg-stone-300 rounded px-2.5 py-1.5 font-medium text-stone-700"><Plus className="w-3.5 h-3.5"/>Add package</button>
        </div>

        {intl&&(
          <div className="border border-blue-200 bg-blue-50/40 rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-blue-700"><FileText className="w-4 h-4"/>Customs · Commercial invoice</div>
            <div className="grid sm:grid-cols-3 gap-2">
              <Field label="Reason for export"><Select value={customs.reason} onChange={e=>setCustoms({...customs,reason:e.target.value})}>{EXPORT_REASONS.map(r=><option key={r}>{r}</option>)}</Select></Field>
              <Field label="Incoterms"><Select value={customs.incoterm} onChange={e=>setCustoms({...customs,incoterm:e.target.value})}>{INCOTERMS.map(r=><option key={r}>{r}</option>)}</Select></Field>
              <Field label="Duties & taxes to"><Select value={customs.dutiesBill} onChange={e=>setCustoms({...customs,dutiesBill:e.target.value})}><option value="receiver">Receiver (DAP)</option><option value="sender">Sender (DDP)</option></Select></Field>
            </div>
            <div className="space-y-1.5">
              <div className="hidden sm:flex text-[10px] uppercase tracking-wide text-stone-400 px-1 gap-2"><div className="flex-1">Description</div><div className="w-28">HTS code</div><div className="w-28">Origin</div><div className="w-12">Qty</div><div className="w-16">Unit $</div><div className="w-5"/></div>
              {customs.lines.map((l,i)=>(
                <div key={i} className="flex flex-wrap sm:flex-nowrap gap-2 items-center">
                  <input value={l.desc} onChange={e=>setLine(i,{desc:e.target.value})} placeholder="Item description" className="flex-1 min-w-0 bg-white border border-stone-200 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500"/>
                  <input value={l.hts} onChange={e=>setLine(i,{hts:e.target.value})} list="htscodes" placeholder="HTS" className="w-28 bg-white border border-stone-200 rounded px-2 py-1.5 text-sm font-mono outline-none focus:border-blue-500"/>
                  <select value={l.origin} onChange={e=>setLine(i,{origin:e.target.value})} className="w-28 bg-white border border-stone-200 rounded px-1 py-1.5 text-sm outline-none focus:border-blue-500">{COUNTRIES.map(c=><option key={c}>{c}</option>)}</select>
                  <input type="number" value={l.qty} onChange={e=>setLine(i,{qty:+e.target.value})} className="w-12 bg-white border border-stone-200 rounded px-2 py-1.5 text-sm font-mono outline-none focus:border-blue-500"/>
                  <input type="number" value={l.value} onChange={e=>setLine(i,{value:e.target.value})} placeholder="0.00" className="w-16 bg-white border border-stone-200 rounded px-2 py-1.5 text-sm font-mono outline-none focus:border-blue-500 placeholder-stone-300"/>
                  <button onClick={()=>delLine(i)} className="text-stone-300 hover:text-rose-500 w-5"><X className="w-4 h-4"/></button>
                </div>
              ))}
              <datalist id="htscodes">{HTS_SUGGEST.map(h=><option key={h.code} value={h.code}>{h.desc}</option>)}</datalist>
              <button onClick={addLine} className="flex items-center gap-1 text-xs bg-white border border-stone-200 hover:bg-stone-100 rounded px-2.5 py-1.5 font-medium text-stone-700"><Plus className="w-3.5 h-3.5"/>Add item</button>
            </div>
            <div className="flex items-center justify-between flex-wrap gap-2 pt-1 border-t border-blue-200">
              <div className="text-sm">Declared value <span className="font-mono font-semibold">{money(customsTotal)}</span></div>
              <button onClick={()=>setShowCI(s=>!s)} className="text-sm bg-stone-900 text-white rounded px-3 py-1.5 font-medium flex items-center gap-1.5 hover:bg-stone-800"><FileText className="w-4 h-4"/>{showCI?"Hide":"View"} commercial invoice</button>
            </div>
            {showCI&&<CommercialInvoice sender={sender} receiver={receiver} customs={customs} total={customsTotal} reference={reference} pieces={pieces} totalWeight={totalWeight}/>}
          </div>
        )}

        {ready&&<div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 ${rateSrc.loading?"bg-stone-100 text-stone-500":rateSrc.live?"bg-emerald-50 text-emerald-700 border border-emerald-200":"bg-blue-50 text-blue-700 border border-blue-200"}`}>
          {rateSrc.loading?<><Loader2 className="w-3.5 h-3.5 animate-spin"/>Fetching live rates…</>
          :rateSrc.live?<><Wifi className="w-3.5 h-3.5"/>Live rates from your England account</>
          :<><Calculator className="w-3.5 h-3.5"/>Estimated rates{rateSrc.error?` · ${rateSrc.error}`:""} — connect your England account in Settings → Carrier accounts for live pricing</>}
        </div>}
        <ServiceList quotes={quotes} best={best} bought={bought} action={ready?print:null} label="Print label" doneLabel="Printed" ready={ready}/>

        <div className="border border-stone-200 rounded-lg bg-white p-3 space-y-3">
          <div className="text-[11px] uppercase tracking-widest text-stone-600 font-semibold">Billing &amp; third-party</div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-stone-600"><input type="checkbox" checked={returnDiff} onChange={e=>setReturnDiff(e.target.checked)} className="accent-blue-600"/>Return address differs from sender</label>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-stone-500 flex items-center gap-1"><CreditCard className="w-3.5 h-3.5"/>Bill to</span>
              <select value={billTo} onChange={e=>setBillTo(e.target.value)} className="bg-white border border-stone-200 rounded px-2 py-1 text-sm outline-none focus:border-blue-500"><option value="sender">Sender (you)</option><option value="receiver">Receiver</option><option value="third">Third-party acct</option></select>
              {billTo==="third"&&<input value={thirdAcct} onChange={e=>setThirdAcct(e.target.value)} placeholder="3rd-party acct #" className="bg-white border border-stone-200 rounded px-2 py-1 text-sm w-40 outline-none focus:border-blue-500 font-mono"/>}
            </div>
          </div>
        </div>

        <div className="border border-stone-200 rounded-lg bg-white p-3 space-y-3">
          <div className="text-[11px] uppercase tracking-widest text-stone-600 font-semibold flex items-center gap-1.5"><Send className="w-3.5 h-3.5"/>Send label &amp; notify</div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-0"><div className="text-[10px] uppercase tracking-widest text-stone-400">Send to email</div><input value={emailTo} onChange={e=>setEmailTo(e.target.value)} placeholder={receiver.email||"customer@example.com"} className="w-full bg-white border border-stone-200 rounded px-2.5 py-2 text-sm outline-none focus:border-blue-500 placeholder-stone-300"/></div>
            <button onClick={sendLabel} className={`flex items-center gap-1.5 text-sm rounded px-3 py-2 font-medium ${sent==="label"?"bg-emerald-600 text-white":"bg-stone-900 text-white hover:bg-stone-800"}`}>{sent==="label"?<><Check className="w-4 h-4"/>Label sent</>:<><Printer className="w-4 h-4"/>Send shipping label</>}</button>
            <button onClick={sendEmail} className={`flex items-center gap-1.5 text-sm rounded px-3 py-2 font-medium ${sent==="email"?"bg-emerald-600 text-white":"bg-stone-200 text-stone-700 hover:bg-stone-300"}`}>{sent==="email"?<><Check className="w-4 h-4"/>Email sent</>:<><Mail className="w-4 h-4"/>Send tracking email</>}</button>
          </div>
          <p className="text-[11px] text-stone-400">Emails the buyer a tracking link or a printable label PDF. Logged under Settings → Email automation.</p>
        </div>
      </div>
    </div>
  );
}

function CommercialInvoice({sender,receiver,customs,total,reference,pieces,totalWeight}){
  return (
    <div className="bg-white border border-stone-300 rounded-lg p-5 text-[12px] text-stone-700" style={{fontFamily:"ui-sans-serif,system-ui"}}>
      <div className="flex items-start justify-between border-b border-stone-300 pb-3 mb-3">
        <div><div className="text-lg font-bold tracking-tight text-stone-900">COMMERCIAL INVOICE</div><div className="text-stone-400">ShippingCloud · for customs clearance</div></div>
        <div className="text-right"><div>Invoice # <span className="font-mono">{customs.ci||"CI-PREVIEW"}</span></div><div>Date {new Date().toLocaleDateString()}</div><div>Ref {reference||"—"}</div></div>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div><div className="text-[10px] uppercase tracking-widest text-stone-400 mb-0.5">Exporter / Shipper</div><div className="font-medium text-stone-900">{sender.company||sender.name}</div><div>{sender.address1}</div><div>{sender.city}, {sender.state} {sender.zip}</div><div>{sender.country}</div></div>
        <div><div className="text-[10px] uppercase tracking-widest text-stone-400 mb-0.5">Importer / Consignee</div><div className="font-medium text-stone-900">{receiver.name}{receiver.company?` · ${receiver.company}`:""}</div><div>{receiver.address1}</div><div>{receiver.city}, {receiver.state} {receiver.zip}</div><div>{receiver.country}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-3 text-[11px]">
        <div><span className="text-stone-400">Reason for export:</span> {customs.reason}</div>
        <div><span className="text-stone-400">Incoterms:</span> {(customs.incoterm||"").split(" — ")[0]}</div>
        <div><span className="text-stone-400">Duties/taxes:</span> {customs.dutiesBill==="sender"?"Prepaid (DDP)":"Collect (DAP)"}</div>
      </div>
      <table className="w-full border-collapse">
        <thead><tr className="border-y border-stone-300 text-[10px] uppercase tracking-wide text-stone-400 text-left"><th className="py-1.5 font-normal">Description</th><th className="font-normal">HTS code</th><th className="font-normal">Origin</th><th className="font-normal text-right">Qty</th><th className="font-normal text-right">Unit</th><th className="font-normal text-right">Total</th></tr></thead>
        <tbody>{customs.lines.map((l,i)=>(<tr key={i} className="border-b border-stone-100"><td className="py-1.5">{l.desc||<span className="text-stone-300">—</span>}</td><td className="font-mono">{l.hts||"—"}</td><td>{l.origin}</td><td className="text-right">{l.qty}</td><td className="text-right font-mono">{money(+l.value||0)}</td><td className="text-right font-mono">{money((+l.qty||0)*(+l.value||0))}</td></tr>))}</tbody>
        <tfoot><tr className="font-semibold text-stone-900"><td colSpan={5} className="text-right py-2 pr-2">Total declared value</td><td className="text-right font-mono">{money(total)}</td></tr></tfoot>
      </table>
      <div className="flex justify-between text-[11px] text-stone-500 mt-2"><span>{pieces.length} package(s) · {totalWeight} lb total</span><span>Currency: USD</span></div>
      <div className="mt-4 pt-3 border-t border-stone-200 text-[11px] text-stone-500">I declare the information on this invoice to be true and correct to the best of my knowledge.</div>
      <div className="mt-6 flex justify-between text-[11px]"><div className="border-t border-stone-400 w-48 pt-1 text-stone-400">Signature</div><div className="border-t border-stone-400 w-32 pt-1 text-stone-400">Date</div></div>
    </div>
  );
}


function ServiceList({quotes,best,bought,action,label,doneLabel,showCost,ready=true}){
  const [view,setView]=useState("cheapest");
  const Row=(q)=>(
    <div key={q.key} className={`border rounded-lg px-3 py-2.5 flex items-center gap-4 ${q.key===best&&ready?"border-blue-200 bg-blue-50":"border-stone-200 bg-white"}`}>
      <div className="flex-1 min-w-0"><div className="flex items-center gap-2">{view==="cheapest"&&<span className={`text-[10px] font-bold w-10 shrink-0 ${CARRIER_TINT[q.carrier]}`}>{q.carrier}</span>}<span className="text-sm truncate">{q.label}</span>{q.key===best&&ready&&<span className="text-[10px] uppercase text-blue-600 border border-blue-200 rounded px-1">best value</span>}</div><div className="text-[11px] text-stone-500">{q.minDays?(q.minDays===q.maxDays?`${q.minDays} business day${q.minDays>1?"s":""}`:`${q.minDays}–${q.maxDays} days`):""}</div></div>
      {showCost&&<div className="text-right font-mono hidden sm:block"><div className="text-[10px] uppercase tracking-widest text-stone-400">cost</div><div className="text-sm text-stone-500">{ready?money(q.cost):"—"}</div></div>}
      <div className="text-right font-mono"><div className="text-base font-semibold text-stone-900">{ready?money(q.sell??q.cost):"—"}</div></div>
      {action&&<button onClick={()=>action(q)} disabled={!ready} className={`shrink-0 w-32 text-sm rounded px-3 py-2 font-medium flex items-center justify-center gap-1.5 disabled:opacity-40 ${bought===q.key?"bg-blue-600 text-white":"bg-stone-900 text-white hover:bg-stone-800"}`}>{bought===q.key?<><Check className="w-4 h-4"/>{doneLabel}</>:<><Printer className="w-4 h-4"/>{label}</>}</button>}
    </div>
  );
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-stone-700">Select service</h2>
        <div className="flex items-center gap-2">
          {!ready&&<span className="text-[11px] text-stone-400">enter ZIP &amp; weight to see rates</span>}
          <div className="flex bg-stone-100 rounded-lg p-0.5 text-xs">
            {[["cheapest","Cheapest"],["carrier","By carrier"]].map(([v,l])=><button key={v} onClick={()=>setView(v)} className={`px-2.5 py-1 rounded-md ${view===v?"bg-white shadow-sm text-stone-900 font-medium":"text-stone-500"}`}>{l}</button>)}
          </div>
        </div>
      </div>
      {view==="cheapest"
        ? <div className="space-y-1.5">{quotes.map(Row)}</div>
        : CARRIER_ORDER.map(c=>{const list=quotes.filter(q=>q.carrier===c);if(!list.length)return null;return (<div key={c} className="mb-4"><div className={`text-xs font-bold tracking-wide mb-1.5 ${CARRIER_TINT[c]}`}>{c}</div><div className="space-y-1.5">{list.map(Row)}</div></div>);})}
    </div>
  );
}

/* ════════ ORDERS ════════ */
function Orders({orders,setOrders,goShip,client,settings,onShipped}){
  const [filter,setFilter]=useState("all");
  const [q,setQ]=useState("");
  const [open,setOpen]=useState(null);
  const list=orders.filter(o=>(filter==="all"||o.status===filter)&&(o.name+o.customer+o.city).toLowerCase().includes(q.toLowerCase()));
  const ship=(o)=>goShip({receiver:{name:o.customer,company:o.company,zip:o.zip,state:o.state,city:o.city,address1:o.address1,phone:o.phone,email:o.email},weight:o.weight,reference:o.name,fromOrderId:o.id});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex bg-stone-100 rounded-lg p-0.5 text-sm">{["all","unfulfilled","fulfilled"].map(f=><button key={f} onClick={()=>setFilter(f)} className={`px-3 py-1.5 rounded-md capitalize ${filter===f?"bg-white shadow-sm text-stone-900 font-medium":"text-stone-500"}`}>{f}</button>)}</div>
        <div className="flex-1 relative"><Search className="w-4 h-4 absolute left-2.5 top-2.5 text-stone-400"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search orders" className="w-full bg-white border border-stone-200 rounded-lg pl-8 pr-3 py-2 text-sm outline-none focus:border-blue-500"/></div>
        <Badge tone="blue">{orders.filter(o=>o.status==="unfulfilled").length} to ship</Badge>
      </div>
      <div className="border border-stone-200 rounded-lg overflow-hidden bg-white divide-y divide-stone-100">
        {list.length===0&&<div className="p-8 text-center text-sm text-stone-400">No orders.</div>}
        {list.map(o=>(
          <div key={o.id}>
            <div className="flex items-center gap-3 px-4 py-3 hover:bg-stone-50 cursor-pointer" onClick={()=>setOpen(open===o.id?null:o.id)}>
              <ChevronRight className={`w-4 h-4 text-stone-400 transition-transform ${open===o.id?"rotate-90":""}`}/>
              <div className="w-16 font-semibold text-sm">{o.name}</div>
              <div className="flex-1 min-w-0"><div className="text-sm text-stone-800 truncate">{o.customer}</div><div className="text-[11px] text-stone-400 truncate">{o.items}</div></div>
              <div className="text-xs text-stone-500 hidden sm:block w-28 truncate">{o.city}, {o.state}</div>
              <div className="font-mono text-sm w-16 text-right">${o.total}</div>
              <Badge tone={o.status==="fulfilled"?"green":"amber"}>{o.status}</Badge>
              <button onClick={(e)=>{e.stopPropagation();setOpen(open===o.id?null:o.id);}} disabled={o.status==="fulfilled"} className="text-sm bg-stone-900 text-white rounded px-3 py-1.5 font-medium hover:bg-stone-800 disabled:opacity-40">{o.status==="fulfilled"?"Shipped":"Ship"}</button>
            </div>
            {open===o.id&&<OrderDetail o={o} setOrders={setOrders} client={client} settings={settings} onShipped={onShipped} goShip={ship}/>}
          </div>
        ))}
      </div>
    </div>
  );
}
function OrderDetail({o,setOrders,client,settings,onShipped,goShip}){
  const commercial=!!(o.company&&o.company.trim());
  const [weight,setWeight]=useState(o.weight||1);
  const [boxIdx,setBoxIdx]=useState(-1);
  const [residential,setRes]=useState(!commercial);
  const [bought,setBought]=useState(null);
  const [done,setDone]=useState(false);
  const upd=(patch)=>setOrders(os=>os.map(x=>x.id===o.id?{...x,...patch}:x));
  const boxes=settings?.boxes||SEED_BOXES;
  const box=boxIdx>=0?boxes[boxIdx]:{L:12,W:9,H:4};
  const fromZip=settings?.sender?.zip||client?.origin||"84003";
  const ready=/^\d{5}/.test(o.zip||"")&&(+weight>0);
  const quotes=useMemo(()=>quoteRates({fromZip,toZip:o.zip,pieces:[{weight:+weight||0,L:box.L,W:box.W,H:box.H}],residential,intl:false}).filter(qq=>residential?qq.key!=="fedex_ground":qq.key!=="fedex_home").map(qq=>({...qq,sell:Math.round(qq.cost*(1+(client?.markup||0)/100)*100)/100})).sort((a,b)=>a.sell-b.sell),[o.zip,weight,box.L,box.W,box.H,residential,client]);
  const best=quotes[0]?.key;
  const printHere=(qq)=>{
    const carrier=carrierOf(qq.label);
    const rec={id:Date.now(),date:new Date().toLocaleDateString(),tracking:newTracking(carrier),carrier,service:qq.label,recipient:{name:o.customer,company:o.company,zip:o.zip,state:o.state,city:o.city,address1:o.address1,phone:o.phone,email:o.email},sender:{...(settings?.sender||{})},fromZip,toZip:o.zip,weight:+weight,pieces:[{weight:+weight,L:box.L,W:box.W,H:box.H}],dims:box,cost:qq.cost,sell:qq.sell,billTo:"sender",status:"Label created",lastScan:"Label created",eta:"—",onTime:true,reference:o.name};
    onShipped(rec,o.id);
    setBought(qq.key);setDone(true);
  };
  const Info=({k,v})=>(<div className="min-w-0"><div className="text-[10px] uppercase tracking-widest text-stone-400">{k}</div><div className="text-sm text-stone-800 truncate">{v||"—"}</div></div>);
  return (
    <div className="px-4 sm:px-12 pb-5 pt-2 bg-stone-50/70 space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
        <Info k="Customer" v={o.customer}/>
        <Info k="Company" v={o.company}/>
        <Info k="Email" v={o.email}/>
        <Info k="Phone" v={o.phone}/>
        <div className="col-span-2"><div className="text-[10px] uppercase tracking-widest text-stone-400">Ship to</div><div className="text-sm text-stone-800">{o.address1}, {o.city}, {o.state} {o.zip}</div></div>
        <Info k="Order total" v={`$${o.total}`}/>
        <Info k="SKU" v={o.sku}/>
        <div className="col-span-2 sm:col-span-4"><div className="text-[10px] uppercase tracking-widest text-stone-400">Items</div><div className="text-sm text-stone-800">{o.items}</div></div>
      </div>

      {o.status==="fulfilled"?(
        <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2"><CheckCircle2 className="w-4 h-4"/>Shipped{o.tracking?<> · tracking <a className="underline font-mono" href={TRACK_URL[carrierOf("FedEx")](o.tracking)} target="_blank" rel="noopener">{o.tracking}</a></>:""}</div>
      ):(<>
        <div className="flex flex-wrap items-end gap-3 border border-stone-200 rounded-lg bg-white p-3">
          <div><div className="text-[10px] uppercase tracking-widest text-stone-400">Weight (lb)</div><input type="number" value={weight} onChange={e=>{setWeight(+e.target.value);upd({weight:+e.target.value});}} className="w-20 bg-white border border-stone-300 rounded px-2 py-1 text-sm font-mono outline-none focus:border-blue-500"/></div>
          <div><div className="text-[10px] uppercase tracking-widest text-stone-400">Box</div><select value={boxIdx} onChange={e=>setBoxIdx(+e.target.value)} className="bg-white border border-stone-300 rounded px-2 py-1 text-sm outline-none focus:border-blue-500"><option value="-1">Default 12×9×4</option>{boxes.map((b,j)=><option key={b.id} value={j}>{b.name}</option>)}</select></div>
          <label className="flex items-center gap-1.5 text-sm text-stone-600"><input type="checkbox" checked={residential} onChange={e=>setRes(e.target.checked)} className="accent-blue-600"/>Residential</label>
          <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${residential?"text-blue-700 bg-blue-50 border-blue-200":"text-stone-700 bg-stone-100 border-stone-200"}`}>{residential?<Home className="w-3.5 h-3.5"/>:<Building2 className="w-3.5 h-3.5"/>}{residential?"Residential":"Commercial"}</span>
          <div className="flex-1"/>
          <button onClick={()=>goShip(o)} className="text-sm bg-stone-200 text-stone-700 rounded px-3 py-1.5 font-medium hover:bg-stone-300 flex items-center gap-1.5"><Edit3 className="w-3.5 h-3.5"/>Open in Ship tab</button>
        </div>
        <ServiceList quotes={quotes} best={best} bought={bought} action={ready?printHere:null} label="Buy & print" doneLabel="Printed" ready={ready}/>
        {done&&<div className="flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2"><CheckCircle2 className="w-4 h-4"/>Label created — order moved to Shipments.</div>}
      </>)}
    </div>
  );
}

/* ════════ SHIPMENTS (history) ════════ */
function Shipments({shipments,setShipments,goShip}){
  const [open,setOpen]=useState(null);
  const [q,setQ]=useState("");
  if(!shipments.length)return <Empty icon={Truck} title="No shipments yet" body="Print a label on the Ship tab and it lands here with tracking, edit & reship."/>;
  const voidS=id=>setShipments(s=>s.map(x=>x.id===id?{...x,status:"Voided"}:x));
  const reship=s=>goShip({receiver:s.recipient,weight:s.weight,reference:s.reference});
  const tone=st=>st==="Delivered"?"green":st==="Voided"?"stone":st==="Exception"?"rose":st==="Out for delivery"?"amber":st==="In transit"?"amber":"blue";
  const term=q.trim().toLowerCase();
  const list=term?shipments.filter(s=>[s.recipient?.name,s.tracking,s.reference,s.invoiceNo,s.poNo,s.service].filter(Boolean).some(v=>String(v).toLowerCase().includes(term))):shipments;
  return (
    <div className="space-y-3">
      <div className="relative"><Search className="w-4 h-4 absolute left-3 top-2.5 text-stone-400"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search by name, tracking, order, reference or PO #" className="w-full bg-white border border-stone-200 rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-500"/></div>
      <div className="border border-stone-200 rounded-lg overflow-hidden bg-white divide-y divide-stone-100">
        <div className="flex items-center gap-3 px-4 py-2 text-[11px] uppercase tracking-widest text-stone-400 bg-stone-50"><div className="w-4"/><div className="w-24">Date</div><div className="flex-1">Recipient</div><div className="w-40 hidden md:block">Tracking</div><div className="w-20 text-right">Rate</div><div className="w-24 text-right">Status</div></div>
        {list.length===0&&<div className="p-8 text-center text-sm text-stone-400">No shipments match “{q}”.</div>}
        {list.map(s=>(
        <div key={s.id}>
          <div className="flex items-center gap-3 px-4 py-3 hover:bg-stone-50">
            <button onClick={()=>setOpen(open===s.id?null:s.id)} className="text-stone-400"><ChevronRight className={`w-4 h-4 transition-transform ${open===s.id?"rotate-90":""}`}/></button>
            <div className="w-24 text-sm font-mono text-stone-500">{s.date}</div>
            <div className="flex-1 min-w-0"><div className="text-sm text-stone-800 truncate">{s.recipient?.name||"—"}</div><div className="text-[11px] text-stone-400 truncate">{s.service}</div></div>
            <div className="w-40 hidden md:block"><a href={TRACK_URL[s.carrier](s.tracking)} target="_blank" rel="noopener" className="text-blue-600 underline font-mono text-xs flex items-center gap-1 truncate">{s.tracking}<ExternalLink className="w-3 h-3 shrink-0"/></a></div>
            <div className="w-20 text-right font-mono text-sm text-stone-900">{money(s.sell)}</div>
            <div className="w-24 text-right"><Badge tone={tone(s.status)}>{s.status}</Badge></div>
          </div>
          {open===s.id&&(
            <div className="px-12 pb-4 pt-1 bg-stone-50/60 text-sm">
              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1 mb-3">
                <Info k="Carrier / service" v={s.service}/>
                <Info k="Tracking" v={<a href={TRACK_URL[s.carrier](s.tracking)} target="_blank" rel="noopener" className="text-blue-600 underline">{s.tracking} ↗</a>}/>
                <Info k="To" v={`${s.recipient?.name||""} — ${s.recipient?.city||""}, ${s.recipient?.state||""} ${s.recipient?.zip||""}`}/>
                <Info k="From ZIP" v={s.fromZip}/>
                <Info k="Packages" v={`${s.pieces?.length||1} pkg · ${s.weight} lb total`}/>
                <Info k="Last scan" v={s.lastScan||"—"}/>
                {s.intl&&<Info k="Customs" v={s.customs?`${s.customs.ci} · declared ${money(s.customs.total)}`:"International"}/>}
                <Info k="Bill to" v={s.billTo==="third"?`Third-party ${s.thirdAcct||""}`:s.billTo}/>
                <Info k="Rate" v={money(s.sell)}/>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={()=>reship(s)} className="text-sm bg-stone-900 text-white rounded px-3 py-1.5 font-medium hover:bg-stone-800 flex items-center gap-1.5"><RotateCcw className="w-3.5 h-3.5"/>Edit &amp; reship</button>
                <button className="text-sm bg-stone-200 text-stone-700 rounded px-3 py-1.5 font-medium hover:bg-stone-300 flex items-center gap-1.5"><Printer className="w-3.5 h-3.5"/>Reprint</button>
                {s.status!=="Voided"&&<button onClick={()=>voidS(s.id)} className="text-sm text-rose-600 hover:bg-rose-50 rounded px-3 py-1.5 font-medium flex items-center gap-1.5"><X className="w-3.5 h-3.5"/>Void label</button>}
              </div>
            </div>
          )}
        </div>
      ))}
      </div>
    </div>
  );
}

/* ════════ PICKUPS ════════ */
function Pickups({pickups,setPickups,settings}){
  const [f,setF]=useState({carrier:"FedEx",date:"",ready:"09:00",close:"17:00",count:1,location:"Front desk"});
  const add=()=>{ if(!f.date)return; setPickups(p=>[{id:Date.now(),conf:"PU"+rnd(7),...f},...p]); };
  return (
    <div className="grid lg:grid-cols-2 gap-6 max-w-4xl">
      <Panel title="Schedule a pickup">
        <Field label="Carrier"><Select value={f.carrier} onChange={e=>setF({...f,carrier:e.target.value})}><option>FedEx</option><option>UPS</option><option>USPS</option></Select></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Date"><Input type="date" value={f.date} onChange={e=>setF({...f,date:e.target.value})}/></Field><Field label="Packages"><Input type="number" value={f.count} onChange={e=>setF({...f,count:+e.target.value})}/></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label="Ready time"><Input type="time" value={f.ready} onChange={e=>setF({...f,ready:e.target.value})}/></Field><Field label="Close time"><Input type="time" value={f.close} onChange={e=>setF({...f,close:e.target.value})}/></Field></div>
        <Field label="Package location"><Input value={f.location} onChange={e=>setF({...f,location:e.target.value})}/></Field>
        <div className="text-[11px] text-stone-400 flex items-center gap-1"><MapPin className="w-3.5 h-3.5"/>{settings.sender.address1}, {settings.sender.city} {settings.sender.zip}</div>
        <button onClick={add} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium hover:bg-stone-800">Schedule pickup</button>
      </Panel>
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-widest text-stone-500">Scheduled</div>
        {pickups.length===0?<Empty icon={Calendar} title="No pickups" body="Schedule one and it shows here."/>:pickups.map(p=>(
          <div key={p.id} className="border border-stone-200 rounded-lg bg-white p-3 flex items-center gap-3">
            <div className={`text-xs font-bold ${CARRIER_TINT[p.carrier]}`}>{p.carrier}</div>
            <div className="flex-1"><div className="text-sm text-stone-800">{p.date} · {p.count} pkg</div><div className="text-[11px] text-stone-400">{p.ready}–{p.close} · {p.location}</div></div>
            <div className="font-mono text-[11px] text-stone-400">{p.conf}</div>
            <button onClick={()=>setPickups(x=>x.filter(y=>y.id!==p.id))} className="text-stone-300 hover:text-rose-500"><Trash2 className="w-4 h-4"/></button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════ QUICK QUOTE ════════ */
function QuickQuote({onClose,client,england}){
  const [s,setS]=useState({fromZip:client?.origin||"84003",toZip:"90210",weight:3,L:12,W:9,H:4,residential:true});
  const ready=/^\d{5}/.test(s.toZip||"")&&/^\d{5}/.test(s.fromZip||"")&&s.weight>0;
  const [rateSrc,setRateSrc]=useState({rates:[],live:false,loading:false,error:null});
  useEffect(()=>{
    let cancel=false;
    if(!ready){setRateSrc({rates:[],live:false,loading:false,error:null});return;}
    const ship={fromZip:s.fromZip,toZip:s.toZip,pieces:[{weight:s.weight,L:s.L,W:s.W,H:s.H}],residential:s.residential};
    if(england&&england.enabled&&england.apiKey&&england.customerId){
      setRateSrc(p=>({...p,loading:true}));
      getLiveRates(ship,england).then(res=>{ if(cancel)return;
        if(res&&res.live&&res.rates&&res.rates.length) setRateSrc({rates:res.rates,live:true,loading:false,error:null});
        else setRateSrc({rates:quoteRates(ship),live:false,loading:false,error:(res&&res.error)||null});
      });
    } else setRateSrc({rates:quoteRates(ship),live:false,loading:false,error:null});
    return ()=>{cancel=true;};
  },[s,england]);
  const quotes=useMemo(()=>rateSrc.rates.map(q=>({...q,sell:Math.round(q.cost*(1+(client?.markup||0)/100)*100)/100})).sort((a,b)=>a.sell-b.sell),[rateSrc,client]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-stone-900/40 backdrop-blur-sm overflow-auto" onClick={onClose}>
      <div className="bg-stone-50 rounded-xl border border-stone-200 shadow-xl w-full max-w-3xl" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 h-14 border-b border-stone-200">
          <div className="flex items-center gap-2 font-semibold"><Calculator className="w-4 h-4 text-blue-600"/>Quick quote <span className="text-stone-400 font-normal text-sm">· ZIP to ZIP, no addresses</span></div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700"><X className="w-5 h-5"/></button>
        </div>
        <div className="p-5 flex flex-col lg:flex-row gap-5">
          <div className="lg:w-64 shrink-0"><Panel title="Shipment">
            <div className="grid grid-cols-2 gap-3"><Field label="From ZIP"><Input value={s.fromZip} onChange={e=>setS({...s,fromZip:e.target.value})}/></Field><Field label="To ZIP"><Input value={s.toZip} onChange={e=>setS({...s,toZip:e.target.value})}/></Field></div>
            <Field label="Weight (lb)"><Input type="number" value={s.weight} onChange={e=>setS({...s,weight:+e.target.value})}/></Field>
            <Field label="Dimensions (in)"><div className="grid grid-cols-3 gap-2">{["L","W","H"].map(k=><Input key={k} type="number" value={s[k]} onChange={e=>setS({...s,[k]:+e.target.value})}/>)}</div></Field>
            <Toggle on={s.residential} set={v=>setS({...s,residential:v})} label="Residential"/>
            <div className="grid grid-cols-2 gap-px bg-stone-200 border border-stone-200 rounded overflow-hidden font-mono text-center"><div className="bg-white py-2"><div className="text-[10px] uppercase text-stone-400">zone</div><div className="font-semibold">{zoneEst(s.fromZip,s.toZip)}</div></div><div className="bg-white py-2"><div className="text-[10px] uppercase text-stone-400">billable</div><div className="font-semibold">{billable(s.L,s.W,s.H,s.weight)} lb</div></div></div>
            {ready&&<div className={`text-[11px] rounded px-2 py-1.5 flex items-center gap-1.5 ${rateSrc.loading?"bg-stone-100 text-stone-500":rateSrc.live?"bg-emerald-50 text-emerald-700":"bg-blue-50 text-blue-700"}`}>{rateSrc.loading?<><Loader2 className="w-3 h-3 animate-spin"/>Fetching…</>:rateSrc.live?<><Wifi className="w-3 h-3"/>Live rates</>:<><Calculator className="w-3 h-3"/>Estimated</>}</div>}
          </Panel></div>
          <div className="flex-1 min-w-0"><ServiceList quotes={quotes} ready={ready}/></div>
        </div>
      </div>
    </div>
  );
}

/* ════════ DASHBOARD ════════ */
const TRACK_STAGES=["Label created","In transit","Out for delivery","Delivered"];
function trackPct(s){if(s==="Delivered")return 100;if(s==="Out for delivery")return 75;if(s==="In transit")return 45;if(s==="Exception")return 45;return 12;}
function Dashboard({shipments,orders,returns,goTab}){
  const a=useMemo(()=>analytics(shipments),[shipments]);
  const days=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const maxDay=Math.max(1,...a.byDay);
  const carriers=Object.entries(a.byCarrier).sort((x,y)=>y[1]-x[1]);
  const live=shipments.filter(s=>s.status!=="Voided");
  const cnt=st=>live.filter(s=>s.status===st).length;
  const inTransit=cnt("In transit"),outForDel=cnt("Out for delivery"),delivered=cnt("Delivered"),exceptions=cnt("Exception"),created=cnt("Label created");
  const delivCount=live.filter(s=>s.status==="Delivered").length;
  const onTime=live.filter(s=>s.status==="Delivered"&&s.onTime).length;
  const onTimePct=delivCount?Math.round((onTime/delivCount)*100):100;
  const active=live.filter(s=>["Label created","In transit","Out for delivery","Exception"].includes(s.status));
  const Tile=({label,value,tone,Icon,onClick})=>(<button onClick={onClick} className="border border-stone-200 rounded-xl bg-white p-3 text-left hover:border-blue-200"><div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-stone-400">{Icon&&<Icon className="w-3.5 h-3.5"/>}{label}</div><div className={`text-2xl font-bold mt-1 ${tone||"text-stone-900"}`}>{value}</div></button>);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="border border-stone-200 rounded-xl bg-white p-4"><div className="text-[11px] uppercase tracking-widest text-stone-400">Labels</div><div className="text-2xl font-bold mt-1">{a.count}</div></div>
        <div className="border border-stone-200 rounded-xl bg-white p-4"><div className="text-[11px] uppercase tracking-widest text-stone-400">Shipping spend</div><div className="text-2xl font-bold mt-1">{money(a.revenue)}</div></div>
        <div className="border border-stone-200 rounded-xl bg-white p-4"><div className="text-[11px] uppercase tracking-widest text-stone-400">Avg / label</div><div className="text-2xl font-bold mt-1">{money(a.count?a.revenue/a.count:0)}</div></div>
        <div className="border border-stone-200 rounded-xl bg-white p-4"><div className="text-[11px] uppercase tracking-widest text-stone-400">On-time</div><div className="text-2xl font-bold mt-1 text-emerald-700">{onTimePct}%</div></div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold text-stone-700 flex items-center gap-2"><Truck className="w-4 h-4"/>Tracking</h3><button onClick={()=>goTab("shipments")} className="text-xs text-blue-600">View all →</button></div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Tile label="In transit" value={inTransit} Icon={Truck} onClick={()=>goTab("shipments")}/>
          <Tile label="Out for delivery" value={outForDel} Icon={MapPin} onClick={()=>goTab("shipments")}/>
          <Tile label="Delivered" value={delivered} tone="text-emerald-700" Icon={CheckCircle2} onClick={()=>goTab("shipments")}/>
          <Tile label="Exceptions" value={exceptions} tone={exceptions?"text-rose-600":""} Icon={AlertTriangle} onClick={()=>goTab("shipments")}/>
          <div className="border border-stone-200 rounded-xl bg-white p-3"><div className="text-[11px] uppercase tracking-widest text-stone-400">On-time</div><div className="text-2xl font-bold mt-1 text-emerald-700">{onTimePct}%</div><div className="h-1.5 bg-stone-100 rounded-full overflow-hidden mt-1"><div className="h-full bg-emerald-500" style={{width:`${onTimePct}%`}}/></div></div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 border border-stone-200 rounded-xl bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-stone-100 flex items-center justify-between"><h3 className="text-sm font-semibold text-stone-700">Active shipments</h3><span className="text-[11px] text-stone-400">{active.length} moving</span></div>
          <div className="divide-y divide-stone-50 max-h-80 overflow-auto">
            {active.length===0&&<div className="p-6 text-center text-sm text-stone-400">Nothing in transit.</div>}
            {active.map(s=>{const exc=s.status==="Exception";return (
              <div key={s.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className={`text-[11px] font-bold w-10 ${CARRIER_TINT[s.carrier]}`}>{s.carrier}</span>
                  <div className="flex-1 min-w-0"><div className="text-sm text-stone-800 truncate">{s.recipient?.name} · {s.recipient?.city}, {s.recipient?.state}</div><a href={TRACK_URL[s.carrier](s.tracking)} target="_blank" rel="noopener" className="text-[11px] text-blue-600 font-mono">{s.tracking}</a></div>
                  <Badge tone={exc?"rose":s.status==="Out for delivery"?"amber":"blue"}>{s.status}</Badge>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-stone-100 rounded-full overflow-hidden"><div className={`h-full ${exc?"bg-rose-400":"bg-blue-600"}`} style={{width:`${trackPct(s.status)}%`}}/></div>
                  <span className={`text-[11px] ${exc?"text-rose-600":"text-stone-400"} w-28 truncate text-right`}>{s.lastScan}</span>
                </div>
              </div>
            );})}
          </div>
        </div>
        <div className="space-y-4">
          <div className="border border-stone-200 rounded-xl bg-white p-4">
            <h3 className="text-sm font-semibold text-stone-700 mb-4">Carrier mix</h3>
            <div className="space-y-3">{carriers.map(([c,n])=>(<div key={c}><div className="flex justify-between text-xs mb-1"><span className={`font-semibold ${CARRIER_TINT[c]}`}>{c}</span><span className="text-stone-400">{n}</span></div><div className="h-2 bg-stone-100 rounded-full overflow-hidden"><div className="h-full bg-blue-600 rounded-full" style={{width:`${(n/a.count)*100}%`}}/></div></div>))}</div>
          </div>
          <div className="border border-stone-200 rounded-xl bg-white p-4">
            <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-stone-700">Volume · 7 days</h3></div>
            <div className="flex items-end gap-2 h-24">{a.byDay.map((v,i)=>(<div key={i} className="flex-1 flex flex-col items-center gap-1"><div className="w-full bg-blue-100 rounded-t" style={{height:`${Math.max(4,(v/maxDay)*100)}%`}}/><span className="text-[10px] text-stone-400">{days[i]}</span></div>))}</div>
          </div>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <button onClick={()=>goTab("orders")} className="border border-stone-200 rounded-xl bg-white p-4 text-left hover:border-blue-200"><div className="flex items-center gap-2 text-blue-600"><ShoppingBag className="w-4 h-4"/><span className="font-semibold">{orders.filter(o=>o.status==="unfulfilled").length} orders to ship</span></div><div className="text-[11px] text-stone-400 mt-1">Open the queue →</div></button>
        <button onClick={()=>goTab("returns")} className="border border-stone-200 rounded-xl bg-white p-4 text-left hover:border-blue-200"><div className="flex items-center gap-2 text-blue-600"><Undo2 className="w-4 h-4"/><span className="font-semibold">{returns.length} open returns</span></div><div className="text-[11px] text-stone-400 mt-1">Manage RMAs →</div></button>
        <button onClick={()=>goTab("shipments")} className="border border-stone-200 rounded-xl bg-white p-4 text-left hover:border-blue-200"><div className="flex items-center gap-2 text-blue-600"><TrendingUp className="w-4 h-4"/><span className="font-semibold">{money(a.count?a.revenue/a.count:0)} avg / label</span></div><div className="text-[11px] text-stone-400 mt-1">Shipment history →</div></button>
      </div>
    </div>
  );
}

/* ════════ BATCH ════════ */
function Batch({orders,setOrders,client,rules,onShipped}){
  const pool=orders.filter(o=>o.status==="unfulfilled");
  const [sel,setSel]=useState(()=>new Set());
  const [rule,setRule]=useState("cheapest");
  const [groupBy,setGroupBy]=useState("none");
  const [done,setDone]=useState(0);
  const toggle=id=>setSel(s=>{const n=new Set(s);n.has(id)?n.delete(id):n.add(id);return n;});
  const all=()=>setSel(s=>s.size===pool.length?new Set():new Set(pool.map(o=>o.id)));
  const rateFor=(o)=>{const qs=quoteRates({fromZip:client.origin,toZip:o.zip,L:12,W:9,H:4,weight:o.weight,residential:true});const pool2=rule==="ground"?qs.filter(q=>/Ground|Home/.test(q.label)):qs;const pick=pool2.sort((a,b)=>a.cost-b.cost)[0]||qs[0];return {...pick,sell:Math.round(pick.cost*(1+client.markup/100)*100)/100};};
  const rows=pool.filter(o=>sel.has(o.id)).map(o=>({o,q:rateFor(o)}));
  const totals=rows.reduce((a,r)=>({cost:a.cost+r.q.cost,sell:a.sell+r.q.sell}),{cost:0,sell:0});
  const run=()=>{rows.forEach(({o,q})=>{const carrier=carrierOf(q.label);onShipped({id:Date.now()+o.id,date:new Date().toLocaleDateString(),tracking:newTracking(carrier),carrier,service:q.label,recipient:{name:o.customer,city:o.city,state:o.state,zip:o.zip},sender:{},fromZip:client.origin,toZip:o.zip,weight:o.weight,dims:{L:12,W:9,H:4},cost:q.cost,sell:q.sell,billTo:"sender",status:"Label created",reference:o.name},o.id);});setDone(rows.length);setSel(new Set());setTimeout(()=>setDone(0),2500);};
  const keyOf=(o)=>{if(groupBy==="sku")return o.sku||"—";if(groupBy==="product")return o.product||o.items||"—";if(groupBy==="zone")return "Zone "+zoneEst(client.origin,o.zip);if(groupBy==="service")return rateFor(o).label;if(groupBy==="state")return o.state||"—";return "All orders";};
  const groups={}; pool.forEach(o=>{const k=keyOf(o);(groups[k]=groups[k]||[]).push(o);});
  const groupKeys=Object.keys(groups).sort();
  const selectGroup=(arr)=>setSel(s=>{const n=new Set(s);const allOn=arr.every(o=>n.has(o.id));arr.forEach(o=>allOn?n.delete(o.id):n.add(o.id));return n;});
  const OrderRow=(o)=>{const q=rateFor(o);const on=sel.has(o.id);return (
    <label key={o.id} className={`flex items-center gap-3 px-4 py-3 cursor-pointer ${on?"bg-blue-50/50":"hover:bg-stone-50"}`}>
      <input type="checkbox" checked={on} onChange={()=>toggle(o.id)} className="accent-blue-600"/>
      <div className="w-14 font-semibold text-sm">{o.name}</div>
      <div className="flex-1 min-w-0"><div className="text-sm truncate">{o.customer}</div><div className="text-[11px] text-stone-400">{o.city}, {o.state} · {o.weight} lb · {o.sku}</div></div>
      <div className="w-28 hidden sm:block text-xs text-stone-500 truncate">{q.label}</div>
      <div className="w-20 text-right font-mono text-sm">{money(q.sell)}</div>
    </label>
  );};
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-stone-700 flex items-center gap-2"><Layers className="w-4 h-4"/>Batch label printing</h2>
        <div className="flex-1"/>
        <span className="text-sm text-stone-500">Group by</span>
        <select value={groupBy} onChange={e=>setGroupBy(e.target.value)} className="bg-white border border-stone-200 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500"><option value="none">None</option><option value="sku">SKU</option><option value="product">Product name</option><option value="zone">Zone</option><option value="service">Service</option><option value="state">Dest. state</option></select>
        <span className="text-sm text-stone-500">Rate rule</span>
        <select value={rule} onChange={e=>setRule(e.target.value)} className="bg-white border border-stone-200 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500"><option value="cheapest">Cheapest overall</option><option value="ground">Cheapest ground</option></select>
      </div>
      {done>0&&<div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-700 flex items-center gap-2"><CheckCircle2 className="w-4 h-4"/>Printed {done} labels — orders moved to Shipments.</div>}
      <div className="border border-stone-200 rounded-lg overflow-hidden bg-white divide-y divide-stone-100">
        <div className="flex items-center gap-3 px-4 py-2 bg-stone-50 text-[11px] uppercase tracking-widest text-stone-400"><input type="checkbox" checked={sel.size===pool.length&&pool.length>0} onChange={all} className="accent-blue-600"/><div className="w-14">Order</div><div className="flex-1">Customer</div><div className="w-28 hidden sm:block">Service</div><div className="w-20 text-right">Rate</div></div>
        {pool.length===0&&<div className="p-8 text-center text-sm text-stone-400">No unfulfilled orders to batch.</div>}
        {groupBy==="none"
          ? pool.map(OrderRow)
          : groupKeys.map(k=>(<div key={k}>
              <button onClick={()=>selectGroup(groups[k])} className="w-full flex items-center gap-2 px-4 py-1.5 bg-stone-50/80 text-left text-[11px] uppercase tracking-widest text-stone-500 font-semibold hover:bg-stone-100"><Layers className="w-3 h-3"/>{k}<span className="text-stone-400">· {groups[k].length}</span></button>
              {groups[k].map(OrderRow)}
            </div>))}
      </div>
      <div className="flex flex-wrap items-center gap-4 border border-stone-200 rounded-lg bg-white p-3">
        <div className="text-sm"><span className="font-semibold">{sel.size}</span> selected</div>
        <div className="text-sm text-stone-500">total <span className="font-mono text-stone-900">{money(totals.sell)}</span></div>
        <div className="flex-1"/>
        <button disabled={!sel.size} onClick={run} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium hover:bg-stone-800 disabled:opacity-40 flex items-center gap-1.5"><Printer className="w-4 h-4"/>Print {sel.size||""} label{sel.size===1?"":"s"}</button>
      </div>
    </div>
  );
}

/* ════════ RETURNS / RMA ════════ */
function Returns({returns,setReturns,orders,settings,logEmail}){
  const [creating,setCreating]=useState(false);
  const [f,setF]=useState({customer:"",order:"",reason:"Wrong size",carrier:"FedEx"});
  const fulfilled=orders.filter(o=>o.status==="fulfilled");
  const create=()=>{if(!f.customer)return;const tracking=newTracking(f.carrier);setReturns(r=>[{id:Date.now(),rma:"RMA-"+rnd(4),customer:f.customer,order:f.order,reason:f.reason,carrier:f.carrier,tracking,status:"Label created",date:new Date().toLocaleDateString()},...r]);if(settings?.notify?.returnLabel&&logEmail)logEmail({to:"customer@example.com",subject:`Your return label for ${f.order||"your order"} is ready`,type:"Return label"});setCreating(false);setF({customer:"",order:"",reason:"Wrong size",carrier:"FedEx"});};
  const tone=s=>s==="Delivered"?"green":s==="In transit"?"amber":"blue";
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-700 flex items-center gap-2"><Undo2 className="w-4 h-4"/>Returns &amp; RMAs</h2><button onClick={()=>setCreating(v=>!v)} className="flex items-center gap-1 text-sm bg-stone-900 text-white rounded px-3 py-1.5 font-medium hover:bg-stone-800"><Plus className="w-4 h-4"/>Create return</button></div>
      {creating&&<Panel title="New return label">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Customer"><Input value={f.customer} onChange={e=>setF({...f,customer:e.target.value})} placeholder="Name"/></Field>
          <Field label="Original order"><Select value={f.order} onChange={e=>setF({...f,order:e.target.value})}><option value="">—</option>{fulfilled.map(o=><option key={o.id} value={o.name}>{o.name} · {o.customer}</option>)}</Select></Field>
          <Field label="Reason"><Select value={f.reason} onChange={e=>setF({...f,reason:e.target.value})}><option>Wrong size</option><option>Defective</option><option>Not as described</option><option>No longer wanted</option></Select></Field>
          <Field label="Return carrier"><Select value={f.carrier} onChange={e=>setF({...f,carrier:e.target.value})}><option>FedEx</option><option>UPS</option><option>USPS</option></Select></Field>
        </div>
        <button onClick={create} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium">Generate return label</button>
      </Panel>}
      <div className="border border-stone-200 rounded-lg overflow-hidden bg-white divide-y divide-stone-100">
        {returns.length===0&&<div className="p-8 text-center text-sm text-stone-400">No returns yet.</div>}
        {returns.map(r=>(
          <div key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-stone-50">
            <div className="w-24 font-mono text-sm font-semibold text-blue-600">{r.rma}</div>
            <div className="flex-1 min-w-0"><div className="text-sm truncate">{r.customer}</div><div className="text-[11px] text-stone-400">{r.order?`${r.order} · `:""}{r.reason}</div></div>
            <div className={`text-xs font-bold hidden sm:block ${CARRIER_TINT[r.carrier]}`}>{r.carrier}</div>
            <a href={TRACK_URL[r.carrier](r.tracking)} target="_blank" rel="noopener" className="text-blue-600 underline font-mono text-xs flex items-center gap-1 w-36 truncate">{r.tracking}<ExternalLink className="w-3 h-3 shrink-0"/></a>
            <Badge tone={tone(r.status)}>{r.status}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════ MANIFESTS (end of day) ════════ */
function Manifests({shipments,setShipments,manifests,setManifests}){
  const open=shipments.filter(s=>s.status==="Label created");
  const byCarrier={}; open.forEach(s=>byCarrier[s.carrier]=(byCarrier[s.carrier]||0)+1);
  const closeAll=()=>{const created=Object.entries(byCarrier).map(([c,n])=>({id:Date.now()+Math.random(),carrier:c,count:n,date:new Date().toLocaleString(),manifest:"MAN"+rnd(8)}));if(!created.length)return;setManifests(m=>[...created,...m]);setShipments(ss=>ss.map(s=>s.status==="Label created"?{...s,status:"In transit"}:s));};
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="border border-stone-200 rounded-lg bg-white p-4">
        <div className="flex items-center justify-between mb-3"><h2 className="text-sm font-semibold text-stone-700 flex items-center gap-2"><FileText className="w-4 h-4"/>End-of-day manifests</h2><button onClick={closeAll} disabled={!open.length} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium hover:bg-stone-800 disabled:opacity-40">Close manifests</button></div>
        {open.length===0?<p className="text-sm text-stone-400">No open labels. Today's labels are all manifested.</p>:
          <div className="grid sm:grid-cols-3 gap-3">{Object.entries(byCarrier).map(([c,n])=>(<div key={c} className="border border-stone-200 rounded-lg p-3"><div className={`text-xs font-bold ${CARRIER_TINT[c]}`}>{c}</div><div className="text-2xl font-bold mt-1">{n}</div><div className="text-[11px] text-stone-400">open labels</div></div>))}</div>}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-widest text-stone-500">Closed manifests</div>
        {manifests.length===0?<Empty icon={FileText} title="No manifests closed" body="Close end-of-day to hand carriers a single scan sheet."/>:manifests.map(m=>(
          <div key={m.id} className="border border-stone-200 rounded-lg bg-white p-3 flex items-center gap-3">
            <div className={`text-xs font-bold ${CARRIER_TINT[m.carrier]}`}>{m.carrier}</div>
            <div className="flex-1"><div className="text-sm">{m.count} packages</div><div className="text-[11px] text-stone-400">{m.date}</div></div>
            <div className="font-mono text-[11px] text-stone-400">{m.manifest}</div>
            <button className="text-xs bg-stone-200 hover:bg-stone-300 rounded px-2.5 py-1.5 flex items-center gap-1"><Printer className="w-3.5 h-3.5"/>Print</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════ REPORTS ════════ */
function Reports({shipments}){
  const [range,setRange]=useState(30);
  const data=range===0?shipments:shipments.filter(s=>(s.dayAgo??0)<range);
  const a=useMemo(()=>analytics(data),[data,range]);
  const carriers=Object.entries(a.byCarrier).sort((x,y)=>y[1]-x[1]);
  const exportCSV=()=>{const rows=[["Date","Carrier","Service","Recipient","ZIP","Rate","Status"],...data.map(s=>[s.date,s.carrier,s.service,s.recipient?.name||"",s.toZip,s.sell,s.status])];downloadCSV("shippingcloud-shipments.csv",rows);};
  const byService={}; data.forEach(s=>{byService[s.service]=byService[s.service]||{n:0,spend:0};byService[s.service].n++;byService[s.service].spend+=s.sell;});
  const services=Object.entries(byService).sort((x,y)=>y[1].n-x[1].n);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-stone-700 flex items-center gap-2"><TrendingUp className="w-4 h-4"/>Reports</h2>
        <div className="flex-1"/>
        <select value={range} onChange={e=>setRange(+e.target.value)} className="bg-white border border-stone-200 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={0}>All time</option></select>
        <button onClick={exportCSV} className="flex items-center gap-1.5 text-sm bg-stone-900 text-white rounded px-3 py-1.5 font-medium hover:bg-stone-800"><Download className="w-4 h-4"/>Export CSV</button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat2 label="Labels" v={a.count}/><Stat2 label="Shipping spend" v={money(a.revenue)}/><Stat2 label="Avg / label" v={money(a.count?a.revenue/a.count:0)}/><Stat2 label="Carriers used" v={carriers.length}/>
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <ReportTable title="By carrier" head={["Carrier","Labels","Spend","Share"]} rows={carriers.map(([c,n])=>[<span key={c} className={`font-semibold ${CARRIER_TINT[c]}`}>{c}</span>,n,money(data.filter(s=>s.carrier===c).reduce((x,s)=>x+s.sell,0)),`${Math.round((n/a.count)*100)}%`])}/>
        <ReportTable title="By service" head={["Service","Labels","Spend"]} rows={services.map(([s,d])=>[s,d.n,money(d.spend)])}/>
      </div>
    </div>
  );
}
function Stat2({label,v,tone}){return <div className="border border-stone-200 rounded-xl bg-white p-4"><div className="text-[11px] uppercase tracking-widest text-stone-400">{label}</div><div className={`text-xl font-bold mt-1 ${tone||"text-stone-900"}`}>{v}</div></div>;}
function ReportTable({title,head,rows}){return (<div className="border border-stone-200 rounded-lg bg-white overflow-hidden"><div className="px-4 py-2.5 text-sm font-semibold text-stone-700 border-b border-stone-100">{title}</div><table className="w-full text-sm"><thead><tr className="text-[11px] uppercase tracking-widest text-stone-400">{head.map(h=><th key={h} className="text-left font-normal px-4 py-2">{h}</th>)}</tr></thead><tbody>{rows.length===0?<tr><td colSpan={head.length} className="px-4 py-4 text-stone-400">No data.</td></tr>:rows.map((r,i)=><tr key={i} className="border-t border-stone-50">{r.map((c,j)=><td key={j} className="px-4 py-2 font-mono text-stone-700">{c}</td>)}</tr>)}</tbody></table></div>);}


/* ════════ CHECKOUT RATES (Shopify) ════════ */
const CHECKOUT_SERVICES=Object.keys(RATES).filter(k=>!RATES[k].intl&&RATES[k].carrier!=="DHL");
function CheckoutRates({settings,setSettings,client}){
  const ck=settings.checkout||CHECKOUT_DEFAULTS;
  const setCk=(patch)=>setSettings({...settings,checkout:{...ck,...patch}});
  const toggleSvc=(k)=>setCk({services:{...ck.services,[k]:!ck.services[k]}});
  const boxes=settings.boxes||SEED_BOXES;
  const [zip,setZip]=useState("90210");
  const [cart,setCart]=useState(()=>({0:1,1:1}));
  const setQty=(i,d)=>setCart(c=>({...c,[i]:Math.max(0,(c[i]||0)+d)}));
  const items=CART_ITEMS.map((it,i)=>({...it,qty:cart[i]||0})).filter(it=>it.qty>0);
  const subtotal=items.reduce((a,it)=>a+it.price*it.qty,0);
  const pack=items.length?pickBox(items,boxes):null;
  const enabled=CHECKOUT_SERVICES.filter(k=>ck.services[k]);
  const pieces=pack?Array.from({length:pack.count}).map(()=>({weight:pack.billWt/pack.count,L:pack.box.L,W:pack.box.W,H:pack.box.H})):[{weight:1,L:8,W:6,H:4}];
  const quotes=useMemo(()=>quoteRates({fromZip:client.origin,toZip:zip,pieces,residential:true}).filter(q=>enabled.includes(q.key)).map(q=>({...q,buyer:Math.round((q.cost*(1+client.markup/100)+(+ck.handling||0))*100)/100})).sort((a,b)=>a.buyer-b.buyer),[zip,JSON.stringify(pieces),JSON.stringify(ck),client.markup]);
  const tierOf=q=>q.maxDays<=1?"Express":q.maxDays<=3?"Standard":"Economy";
  let display=quotes;
  if(ck.presentation==="tiers"){const bt={};quotes.forEach(q=>{const t=tierOf(q);if(!bt[t]||q.buyer<bt[t].buyer)bt[t]={...q,shown:t};});display=["Express","Standard","Economy"].map(t=>bt[t]).filter(Boolean);}
  else display=quotes.map(q=>({...q,shown:q.label}));
  const free=subtotal>=(+ck.freeThreshold||0)&&(+ck.freeThreshold>0)&&items.length>0;
  const endpoint="https://shippingcloud.net/.netlify/functions/shopify-rates";
  return (
    <div className="grid lg:grid-cols-2 gap-6">
      {/* CONFIG */}
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-stone-700 flex items-center gap-2 mb-1"><ShoppingBag className="w-4 h-4"/>Live checkout rates</h2>
          <p className="text-sm text-stone-500">Show live, calculated shipping rates inside your Shopify checkout. ShippingCloud answers Shopify's CarrierService callback in real time, so buyers always see an accurate rate.</p>
        </div>
        <div className="border border-stone-200 rounded-lg bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded bg-stone-100 flex items-center justify-center"><ShoppingBag className="w-4 h-4 text-stone-600"/></div>
            <div className="flex-1"><div className="font-medium">Shopify · CarrierService</div><div className="text-[11px] text-stone-400 font-mono break-all">{endpoint}</div></div>
            <Badge tone={ck.registered?"green":"stone"}>{ck.registered?"registered":"off"}</Badge>
          </div>
          <button onClick={()=>setCk({registered:!ck.registered})} className={`mt-3 text-sm rounded px-3 py-1.5 font-medium ${ck.registered?"bg-stone-200 text-stone-700 hover:bg-stone-300":"bg-stone-900 text-white hover:bg-stone-800"}`}>{ck.registered?"Disable at checkout":"Register carrier service"}</button>
          <p className="text-[11px] text-stone-400 mt-2">Live checkout rates require a Shopify plan with Carrier Calculated Shipping (Advanced/Plus, or the $20/mo add-on).</p>
        </div>
        <Panel title="How rates appear">
          <Field label="Presentation">
            <div className="flex bg-stone-100 rounded-lg p-0.5 text-sm">{[["named","Carrier names"],["tiers","Economy / Standard / Express"]].map(([v,l])=><button key={v} onClick={()=>setCk({presentation:v})} className={`flex-1 px-2 py-1.5 rounded-md ${ck.presentation===v?"bg-white shadow-sm text-stone-900 font-medium":"text-stone-500"}`}>{l}</button>)}</div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Handling fee ($ per order)"><Input type="number" value={ck.handling} onChange={e=>setCk({handling:e.target.value})}/></Field>
            <Field label="Free shipping over ($)"><Input type="number" value={ck.freeThreshold} onChange={e=>setCk({freeThreshold:e.target.value})}/></Field>
          </div>
        </Panel>
        <Panel title="Services offered at checkout">
          <div className="space-y-1">{CHECKOUT_SERVICES.map(k=>(
            <div key={k} className="flex items-center gap-3 py-1.5">
              <span className={`text-[10px] font-bold w-12 ${CARRIER_TINT[RATES[k].carrier]}`}>{RATES[k].carrier}</span>
              <span className="flex-1 text-sm">{RATES[k].label}</span>
              <button onClick={()=>toggleSvc(k)}><span className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors ${ck.services[k]?"bg-blue-600 justify-end":"bg-stone-300 justify-start"}`}><span className="w-4 h-4 bg-white rounded-full"/></span></button>
            </div>
          ))}</div>
        </Panel>
      </div>
      {/* PREVIEW */}
      <div className="space-y-4">
        <div className="border border-stone-200 rounded-lg bg-white p-4">
          <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-stone-700 flex items-center gap-2"><Calculator className="w-4 h-4"/>Test cart</h3><div className="flex items-center gap-1.5 text-sm"><span className="text-stone-400">Ship to</span><input value={zip} onChange={e=>setZip(e.target.value)} className="w-20 bg-white border border-stone-200 rounded px-2 py-1 text-sm font-mono outline-none focus:border-blue-500"/></div></div>
          <div className="space-y-1.5">{CART_ITEMS.map((it,i)=>(
            <div key={i} className="flex items-center gap-3 text-sm">
              <div className="flex-1"><span className="text-stone-800">{it.name}</span><span className="text-[11px] text-stone-400 ml-2 font-mono">{it.l}×{it.w}×{it.h} · {it.wt}lb · ${it.price}</span></div>
              <button onClick={()=>setQty(i,-1)} className="w-6 h-6 rounded bg-stone-200 hover:bg-stone-300">–</button>
              <span className="w-6 text-center font-mono">{cart[i]||0}</span>
              <button onClick={()=>setQty(i,1)} className="w-6 h-6 rounded bg-stone-200 hover:bg-stone-300">+</button>
            </div>
          ))}</div>
        </div>

        {pack&&(
          <div className="border border-blue-200 bg-blue-50/50 rounded-lg p-3 flex items-center gap-3">
            <Boxes className="w-5 h-5 text-blue-600"/>
            <div className="flex-1 text-sm"><div className="font-medium text-stone-800">Box logic picked: {pack.box.name}{pack.count>1?` ×${pack.count}`:""}</div><div className="text-[11px] text-stone-500">{pack.box.L}×{pack.box.W}×{pack.box.H} in · billable {pack.billWt} lb · {pack.reason}</div></div>
          </div>
        )}

        {/* SHOPIFY CHECKOUT MOCK */}
        <div className="border border-stone-300 rounded-xl bg-white overflow-hidden shadow-sm">
          <div className="bg-stone-900 text-white px-4 py-2.5 text-sm font-medium flex items-center justify-between"><span>Shopify checkout · Shipping method</span><span className="text-[11px] text-stone-300">buyer view</span></div>
          <div className="p-4 space-y-2">
            {items.length===0?<div className="text-sm text-stone-400 text-center py-6">Add items to the cart to preview rates.</div>:display.length===0?<div className="text-sm text-stone-400 text-center py-6">No services enabled. Toggle some on the left.</div>:display.map((q,idx)=>{
              const isFree=free&&idx===0;
              return (
                <label key={q.key} className={`flex items-center gap-3 border rounded-lg px-3 py-2.5 cursor-pointer ${idx===0?"border-stone-900":"border-stone-200"}`}>
                  <span className={`w-4 h-4 rounded-full border-2 ${idx===0?"border-stone-900 bg-stone-900":"border-stone-300"}`}/>
                  <div className="flex-1"><div className="text-sm font-medium text-stone-800">{q.shown}</div><div className="text-[11px] text-stone-400">{q.minDays===q.maxDays?`${q.minDays} business day${q.minDays>1?"s":""}`:`${q.minDays}–${q.maxDays} business days`}</div></div>
                  <div className="font-mono text-sm font-semibold">{isFree?<span className="text-emerald-600">FREE</span>:money(q.buyer)}</div>
                </label>
              );
            })}
          </div>
          <div className="border-t border-stone-100 px-4 py-2.5 flex justify-between text-sm"><span className="text-stone-500">Cart subtotal</span><span className="font-mono">{money(subtotal)}</span></div>
        </div>
        <p className="text-[11px] text-stone-400">Buyers see only the final rate above. Add an optional handling fee or free-shipping threshold to match your store's shipping strategy.</p>
      </div>
    </div>
  );
}

/* ════════ SETTINGS ════════ */
function Settings({settings,setSettings,accounts,setAccounts,clients,setClients,rules,setRules,emails,shipments,setShipments,manifests,setManifests,client}){
  const [sec,setSec]=useState("carriers");
  const secs=[["carriers","Carrier accounts",Plug],["boxes","Package sizes",Boxes],["checkout","Checkout rates",ShoppingBag],["manifests","Manifests",FileText],["reports","Reports",TrendingUp],["automation","Automation rules",Zap],["notifications","Email automation",Mail],["clients","Clients & markup",Users],["billing","Billing",CreditCard],["integrations","Integrations",Layers],["subscription","Subscription",Star],["company","Company",Building2]];
  return (
    <div className="flex flex-col md:flex-row gap-6">
      <aside className="md:w-56 shrink-0 space-y-1">{secs.map(([id,l,Icon])=><button key={id} onClick={()=>setSec(id)} className={`w-full flex items-center gap-2 text-sm rounded-lg px-3 py-2 text-left ${sec===id?"bg-white border border-stone-200 text-stone-900 font-medium":"text-stone-500 hover:bg-stone-100"}`}><Icon className="w-4 h-4"/>{l}</button>)}</aside>
      <div className="flex-1 min-w-0">
        {sec==="carriers"&&<CarrierAccounts accounts={accounts} setAccounts={setAccounts} settings={settings} setSettings={setSettings}/>}
        {sec==="boxes"&&<BoxesSettings settings={settings} setSettings={setSettings}/>}
        {sec==="checkout"&&<CheckoutRates settings={settings} setSettings={setSettings} client={client}/>}
        {sec==="manifests"&&<Manifests shipments={shipments} setShipments={setShipments} manifests={manifests} setManifests={setManifests}/>}
        {sec==="reports"&&<Reports shipments={shipments}/>}
        {sec==="automation"&&<AutomationRules rules={rules} setRules={setRules}/>}
        {sec==="notifications"&&<Notifications settings={settings} setSettings={setSettings} emails={emails}/>}
        {sec==="clients"&&<Clients clients={clients} setClients={setClients}/>}
        {sec==="billing"&&<Billing settings={settings} setSettings={setSettings}/>}
        {sec==="integrations"&&<Integrations settings={settings} setSettings={setSettings}/>}
        {sec==="subscription"&&<Subscription settings={settings} setSettings={setSettings}/>}
        {sec==="company"&&<Company settings={settings} setSettings={setSettings}/>}
      </div>
    </div>
  );
}
function BoxesSettings({settings,setSettings}){
  const boxes=settings.boxes||SEED_BOXES;
  const [n,setN]=useState({name:"",L:"",W:"",H:"",maxWt:"",empty:""});
  const add=()=>{if(!n.name)return;setSettings({...settings,boxes:[...boxes,{id:"bx"+Date.now(),name:n.name,L:+n.L||1,W:+n.W||1,H:+n.H||1,maxWt:+n.maxWt||50,empty:+n.empty||0.3}]});setN({name:"",L:"",W:"",H:"",maxWt:"",empty:""});};
  const del=(id)=>setSettings({...settings,boxes:boxes.filter(b=>b.id!==id)});
  return (<div className="max-w-2xl space-y-3">
    <p className="text-sm text-stone-500">Your box catalog. ShippingCloud's box logic auto-picks the smallest box that fits each order — used on the Ship tab and for live Shopify checkout rates.</p>
    <div className="border border-stone-200 rounded-lg bg-white overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 bg-stone-50 text-[11px] uppercase tracking-widest text-stone-400"><div className="flex-1">Box</div><div className="w-28">Dimensions</div><div className="w-16 text-right">Max wt</div><div className="w-16 text-right">Empty</div><div className="w-6"/></div>
      <div className="divide-y divide-stone-100">{boxes.map(b=>(
        <div key={b.id} className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex-1 text-sm font-medium">{b.name}</div>
          <div className="w-28 font-mono text-xs text-stone-500">{b.L}×{b.W}×{b.H} in</div>
          <div className="w-16 text-right font-mono text-sm">{b.maxWt} lb</div>
          <div className="w-16 text-right font-mono text-xs text-stone-400">{b.empty} lb</div>
          <button onClick={()=>del(b.id)} className="text-stone-300 hover:text-rose-500 w-6"><Trash2 className="w-4 h-4"/></button>
        </div>
      ))}</div>
    </div>
    <Panel title="Add box">
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
        <div className="col-span-2"><Field label="Name"><Input value={n.name} onChange={e=>setN({...n,name:e.target.value})}/></Field></div>
        <Field label="L"><Input type="number" value={n.L} onChange={e=>setN({...n,L:e.target.value})}/></Field>
        <Field label="W"><Input type="number" value={n.W} onChange={e=>setN({...n,W:e.target.value})}/></Field>
        <Field label="H"><Input type="number" value={n.H} onChange={e=>setN({...n,H:e.target.value})}/></Field>
        <Field label="Max wt"><Input type="number" value={n.maxWt} onChange={e=>setN({...n,maxWt:e.target.value})}/></Field>
      </div>
      <button onClick={add} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium">Add box</button>
    </Panel>
  </div>);
}
function Notifications({settings,setSettings,emails}){
  const N=settings.notify||{};
  const items=[["orderConfirm","Order confirmation","Sent to the customer when an order is placed"],["shipped","Shipment confirmation","Tracking link emailed when a label prints"],["delivered","Delivered notice","Sent when the carrier marks delivered"],["returnLabel","Return label","Emailed when an RMA label is created"],["exception","Delivery exception alert","Internal alert when a shipment hits a delivery exception"]];
  const toggle=k=>setSettings({...settings,notify:{...N,[k]:!N[k]}});
  return (<div className="space-y-4 max-w-2xl">
    <p className="text-sm text-stone-500">Automated emails fire on shipping & warehouse events. Toggle what sends — the log below records every send.</p>
    <div className="border border-stone-200 rounded-lg bg-white divide-y divide-stone-100">
      {items.map(([k,l,d])=>(<div key={k} className="flex items-center gap-3 px-4 py-3"><div className="flex-1"><div className="text-sm font-medium">{l}</div><div className="text-[11px] text-stone-400">{d}</div></div><button onClick={()=>toggle(k)}><span className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors ${N[k]?"bg-blue-600 justify-end":"bg-stone-300 justify-start"}`}><span className="w-4 h-4 bg-white rounded-full"/></span></button></div>))}
    </div>
    <div>
      <div className="text-xs font-semibold uppercase tracking-widest text-stone-500 mb-2 flex items-center gap-1.5"><Mail className="w-3.5 h-3.5"/>Email log</div>
      <div className="border border-stone-200 rounded-lg bg-white divide-y divide-stone-100">
        {(!emails||emails.length===0)?<div className="p-6 text-center text-sm text-stone-400">No emails sent yet.</div>:emails.map(e=>(
          <div key={e.id} className="flex items-center gap-3 px-4 py-2.5"><Mail className="w-4 h-4 text-stone-300"/><div className="flex-1 min-w-0"><div className="text-sm truncate">{e.subject}</div><div className="text-[11px] text-stone-400">to {e.to} · {e.date}</div></div><Badge tone="green">{e.type}</Badge></div>
        ))}
      </div>
    </div>
  </div>);
}

/* ════════ SETTINGS-SUB ════════ */
function AutomationRules({rules,setRules}){
  const [f,setF]=useState({name:"",field:"weight",op:">",value:"",action:"service",actionValue:""});
  const add=()=>{if(!f.name)return;setRules(r=>[...r,{id:"r"+Date.now(),enabled:true,...f}]);setF({name:"",field:"weight",op:">",value:"",action:"service",actionValue:""});};
  const labelFor=r=>`If ${r.field} ${r.op} ${r.value} → ${r.action}${r.actionValue?`: ${r.actionValue}`:""}`;
  return (<div className="max-w-2xl space-y-3">
    <p className="text-sm text-stone-500">Rules run automatically on imported orders and in Batch — auto-pick services, force signature, flag oversize, and more.</p>
    {rules.map(r=>(<div key={r.id} className="border border-stone-200 rounded-lg bg-white p-3 flex items-center gap-3">
      <button onClick={()=>setRules(rs=>rs.map(x=>x.id===r.id?{...x,enabled:!x.enabled}:x))}><span className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors ${r.enabled?"bg-blue-600 justify-end":"bg-stone-300 justify-start"}`}><span className="w-4 h-4 bg-white rounded-full"/></span></button>
      <div className="flex-1"><div className="font-medium text-sm flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-blue-600"/>{r.name}</div><div className="text-[11px] text-stone-400 font-mono">{labelFor(r)}</div></div>
      <button onClick={()=>setRules(rs=>rs.filter(x=>x.id!==r.id))} className="text-stone-300 hover:text-rose-500"><Trash2 className="w-4 h-4"/></button>
    </div>))}
    <Panel title="New rule">
      <Field label="Rule name"><Input value={f.name} onChange={e=>setF({...f,name:e.target.value})} placeholder="e.g. West coast → Ground"/></Field>
      <div className="grid grid-cols-3 gap-2 items-end">
        <Field label="When"><Select value={f.field} onChange={e=>setF({...f,field:e.target.value})}><option value="weight">Weight (lb)</option><option value="value">Order value ($)</option><option value="state">Dest. state</option><option value="zip">Dest. ZIP</option></Select></Field>
        <Field label="Is"><Select value={f.op} onChange={e=>setF({...f,op:e.target.value})}><option>{">"}</option><option>{"<"}</option><option>{"="}</option></Select></Field>
        <Field label="Value"><Input value={f.value} onChange={e=>setF({...f,value:e.target.value})}/></Field>
      </div>
      <div className="grid grid-cols-2 gap-2 items-end">
        <Field label="Then"><Select value={f.action} onChange={e=>setF({...f,action:e.target.value})}><option value="service">Set service</option><option value="signature">Require signature</option><option value="insure">Auto-insure</option><option value="flag">Flag for review</option></Select></Field>
        <Field label="Detail"><Input value={f.actionValue} onChange={e=>setF({...f,actionValue:e.target.value})} placeholder="e.g. Cheapest Ground"/></Field>
      </div>
      <button onClick={add} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium">Add rule</button>
    </Panel>
  </div>);
}
function AddressBook({settings,setSettings}){
  const [f,setF]=useState({name:"",company:"",address1:"",city:"",state:"",zip:"",phone:""});
  const [q,setQ]=useState("");
  const [msg,setMsg]=useState("");
  const list=settings.addresses||[];
  const add=()=>{if(!f.name)return;setSettings({...settings,addresses:[{id:"ab"+Date.now(),...f},...list]});setF({name:"",company:"",address1:"",city:"",state:"",zip:"",phone:""});};
  const del=(id)=>setSettings({...settings,addresses:list.filter(x=>x.id!==id)});
  const importCSV=(e)=>{
    const file=e.target.files&&e.target.files[0]; if(!file)return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      const text=String(ev.target.result||"");
      const lines=text.split(/\r?\n/).filter(l=>l.trim());
      if(!lines.length){setMsg("Empty file");return;}
      const head=lines[0].split(",").map(h=>h.trim().toLowerCase().replace(/"/g,""));
      const col=(names)=>head.findIndex(h=>names.includes(h));
      const idx={name:col(["name","contact","full name"]),company:col(["company","business"]),address1:col(["address","address1","street","address 1"]),city:col(["city","town"]),state:col(["state","province","region"]),zip:col(["zip","postal","postal code","zipcode","zip code"]),phone:col(["phone","telephone"])};
      const hasHeader=idx.name>=0||idx.zip>=0||idx.address1>=0;
      const rows=hasHeader?lines.slice(1):lines;
      const parsed=rows.map((line,i)=>{const c=line.split(",").map(x=>x.trim().replace(/^"|"$/g,""));const g=(k,d)=>idx[k]>=0?c[idx[k]]||"":(c[d]||"");return {id:"ab"+Date.now()+i,name:g("name",0),company:g("company",1),address1:g("address1",2),city:g("city",3),state:g("state",4),zip:g("zip",5),phone:g("phone",6)};}).filter(r=>r.name||r.address1||r.zip);
      setSettings(s=>({...s,addresses:[...parsed,...(s.addresses||[])]}));
      setMsg(`Imported ${parsed.length} address${parsed.length===1?"":"es"}.`);
      setTimeout(()=>setMsg(""),3000);
    };
    reader.readAsText(file); e.target.value="";
  };
  const filtered=q.trim()?list.filter(a=>[a.name,a.company,a.city,a.state,a.zip].filter(Boolean).some(v=>String(v).toLowerCase().includes(q.trim().toLowerCase()))):list;
  return (<div className="max-w-3xl space-y-3">
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-stone-500 flex-1">Saved contacts for fast ship-to / ship-from. Import your whole list from a CSV.</p>
      <label className="flex items-center gap-1.5 text-sm bg-stone-900 text-white rounded px-3 py-2 font-medium hover:bg-stone-800 cursor-pointer"><Upload className="w-4 h-4"/>Import CSV<input type="file" accept=".csv,text/csv" onChange={importCSV} className="hidden"/></label>
    </div>
    {msg&&<div className="bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg px-3 py-2 text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4"/>{msg}</div>}
    <div className="text-[11px] text-stone-400">CSV columns recognized: name, company, address, city, state, zip, phone (header row optional).</div>
    <div className="relative"><Search className="w-4 h-4 absolute left-3 top-2.5 text-stone-400"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search address book" className="w-full bg-white border border-stone-200 rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-500"/></div>
    <Panel title="Add address">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2"><Field label="Name"><Input value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></Field><Field label="Company"><Input value={f.company} onChange={e=>setF({...f,company:e.target.value})}/></Field><Field label="Phone"><Input value={f.phone} onChange={e=>setF({...f,phone:e.target.value})}/></Field><div className="col-span-2 sm:col-span-3"><Field label="Street"><Input value={f.address1} onChange={e=>setF({...f,address1:e.target.value})}/></Field></div><Field label="City"><Input value={f.city} onChange={e=>setF({...f,city:e.target.value})}/></Field><Field label="State"><Input value={f.state} onChange={e=>setF({...f,state:e.target.value})}/></Field><Field label="ZIP"><Input value={f.zip} onChange={e=>setF({...f,zip:e.target.value})}/></Field></div>
      <button onClick={add} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium">Save address</button>
    </Panel>
    <div className="border border-stone-200 rounded-lg bg-white divide-y divide-stone-100">
      <div className="px-4 py-2 bg-stone-50 text-[11px] uppercase tracking-widest text-stone-400 flex items-center justify-between"><span>{filtered.length} address{filtered.length===1?"":"es"}</span></div>
      {filtered.length===0&&<div className="p-6 text-center text-sm text-stone-400">No addresses{q?" match your search":" yet"}.</div>}
      {filtered.map(adr=>(<div key={adr.id} className="flex items-center gap-3 px-4 py-2.5"><MapPin className="w-4 h-4 text-stone-400 shrink-0"/><div className="flex-1 min-w-0"><div className="font-medium text-sm truncate">{adr.name}{adr.company?` · ${adr.company}`:""}</div><div className="text-[11px] text-stone-400 truncate">{adr.address1}{adr.address1?", ":""}{adr.city} {adr.state} {adr.zip}{adr.phone?` · ${adr.phone}`:""}</div></div><button onClick={()=>del(adr.id)} className="text-stone-300 hover:text-rose-500"><Trash2 className="w-4 h-4"/></button></div>))}
    </div>
  </div>);
}
function Integrations({settings,setSettings}){
  return (<div className="max-w-xl space-y-3">
    <p className="text-sm text-stone-500">Connect stores so orders flow into Ship and Orders automatically.</p>
    <div className="border border-stone-200 rounded-lg bg-white p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded bg-stone-100 flex items-center justify-center"><ShoppingBag className="w-4 h-4 text-stone-600"/></div>
      <div className="flex-1"><div className="font-medium">Shopify</div><div className="text-[11px] text-stone-400 font-mono">sparkle-in-pink.myshopify.com</div></div>
      {settings.shopify?<Badge tone="green">connected</Badge>:<button onClick={()=>setSettings({...settings,shopify:true})} className="text-sm bg-stone-900 text-white rounded px-3 py-1.5">Connect</button>}
    </div>
    {["WooCommerce","Amazon","eBay","Etsy"].map(n=>(
      <div key={n} className="border border-stone-200 rounded-lg bg-white p-4 flex items-center gap-3 opacity-80"><div className="w-9 h-9 rounded bg-stone-100"/><div className="flex-1 font-medium text-stone-600">{n}</div><button className="text-sm bg-stone-200 text-stone-600 rounded px-3 py-1.5">Connect</button></div>
    ))}
  </div>);
}
function Billing({settings,setSettings}){
  const [n,setN]=useState({carrier:"FedEx",account:"",label:""});
  const add=()=>{ if(!n.account)return; setSettings({...settings,thirdPartyAccts:[...settings.thirdPartyAccts,{id:"tp"+Date.now(),...n}]}); setN({carrier:"FedEx",account:"",label:""}); };
  return (<div className="max-w-xl space-y-4">
    <Panel title="Default billing">
      <Field label="Bill shipments to"><Select value={settings.defaultBillTo} onChange={e=>setSettings({...settings,defaultBillTo:e.target.value})}><option value="sender">Sender (you)</option><option value="receiver">Receiver</option><option value="third">Third-party account</option></Select></Field>
    </Panel>
    <Panel title="Third-party carrier accounts">
      <p className="text-[12px] text-stone-400">Bill shipping to someone else's FedEx/UPS account number.</p>
      {settings.thirdPartyAccts.map(t=>(<div key={t.id} className="flex items-center gap-2 text-sm border border-stone-200 rounded px-3 py-2"><span className={`text-xs font-bold ${CARRIER_TINT[t.carrier]}`}>{t.carrier}</span><span className="flex-1 font-mono">{t.account}</span><span className="text-stone-400">{t.label}</span><button onClick={()=>setSettings({...settings,thirdPartyAccts:settings.thirdPartyAccts.filter(x=>x.id!==t.id)})} className="text-stone-300 hover:text-rose-500"><Trash2 className="w-4 h-4"/></button></div>))}
      <div className="grid grid-cols-3 gap-2"><Select value={n.carrier} onChange={e=>setN({...n,carrier:e.target.value})}><option>FedEx</option><option>UPS</option></Select><Input placeholder="Account #" value={n.account} onChange={e=>setN({...n,account:e.target.value})}/><Input placeholder="Label" value={n.label} onChange={e=>setN({...n,label:e.target.value})}/></div>
      <button onClick={add} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium">Add account</button>
    </Panel>
  </div>);
}
function Company({settings,setSettings}){
  const sn=settings.sender; const set=(k,v)=>setSettings({...settings,sender:{...sn,[k]:v}});
  return (<div className="max-w-xl space-y-4">
    <Panel title="Company"><Field label="Company name"><Input value={settings.company} onChange={e=>setSettings({...settings,company:e.target.value})}/></Field></Panel>
    <Panel title="Default sender (ship-from)">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name"><Input value={sn.name} onChange={e=>set("name",e.target.value)}/></Field>
        <Field label="Company"><Input value={sn.company} onChange={e=>set("company",e.target.value)}/></Field>
        <Field label="Address"><Input value={sn.address1} onChange={e=>set("address1",e.target.value)}/></Field>
        <Field label="City"><Input value={sn.city} onChange={e=>set("city",e.target.value)}/></Field>
        <Field label="State"><Input value={sn.state} onChange={e=>set("state",e.target.value)}/></Field>
        <Field label="ZIP"><Input value={sn.zip} onChange={e=>set("zip",e.target.value)}/></Field>
        <Field label="Phone"><Input value={sn.phone} onChange={e=>set("phone",e.target.value)}/></Field>
        <Field label="Email"><Input value={sn.email} onChange={e=>set("email",e.target.value)}/></Field>
      </div>
    </Panel>
  </div>);
}

/* ════════ CARRIER ACCOUNTS (platform + own) ════════ */
const PROVIDERS=[{id:"england",name:"England Logistics API"},{id:"fedex",name:"FedEx · direct"},{id:"ups",name:"UPS · direct"}];
function CarrierAccounts({accounts,setAccounts,settings,setSettings}){
  const [adding,setAdding]=useState(false);
  const [d,setD]=useState({label:"",provider:"england",account:"",apiKey:"",secret:"",customerId:""});
  const plat=settings.platforms||PLATFORM_DEFAULTS;
  const togglePlat=(id)=>setSettings({...settings,platforms:{...plat,[id]:!plat[id]}});
  const add=()=>{const id="a"+Date.now();setAccounts(a=>[...a,{id,...d,status:"connected",mode:"own"}]);setAdding(false);setD({label:"",provider:"england",account:"",apiKey:"",secret:"",customerId:""});};
  const eng=settings.england||{enabled:false,base:"https://englandship.rocksolidinternet.com",apiKey:"",customerId:"",account:""};
  const setEng=(patch)=>setSettings({...settings,england:{...eng,...patch}});
  const [test,setTest]=useState(null); // {ok,msg,sample}
  const runTest=async()=>{
    setTest({loading:true});
    const res=await getLiveRates({fromZip:settings.sender?.zip||"84003",toZip:"90210",residential:true,pieces:[{weight:3,L:12,W:9,H:4}]},{...eng,enabled:true});
    if(res&&res.live&&res.rates&&res.rates.length) setTest({ok:true,msg:`Connected — ${res.rates.length} live services returned (cheapest ${money(res.rates[0].cost)}).`});
    else setTest({ok:false,msg:(res&&res.error)||"No live rates. On the chat preview there's no server — this works once deployed to Netlify."});
  };
  return (<div className="max-w-2xl space-y-5">
    <div>
      <h3 className="text-sm font-semibold text-stone-700 mb-1 flex items-center gap-2"><Wifi className="w-4 h-4 text-emerald-600"/>England Logistics — live FedEx &amp; UPS rates</h3>
      <p className="text-sm text-stone-500 mb-3">Enter your England API credentials to pull your real negotiated rates on the Ship tab and Quick quote. Until this is on, the app shows estimates.</p>
      <div className="border border-stone-200 rounded-lg bg-white p-4 space-y-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium flex items-center gap-2">Use live England rates {eng.enabled&&<Badge tone="green">on</Badge>}</span>
          <button onClick={()=>setEng({enabled:!eng.enabled})}><span className={`w-10 h-6 rounded-full flex items-center px-0.5 transition-colors ${eng.enabled?"bg-emerald-600 justify-end":"bg-stone-300 justify-start"}`}><span className="w-5 h-5 bg-white rounded-full"/></span></button>
        </label>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="England API key"><Input type="password" value={eng.apiKey} onChange={e=>setEng({apiKey:e.target.value})} placeholder="paste your key"/></Field>
          <Field label="England customer ID"><Input value={eng.customerId} onChange={e=>setEng({customerId:e.target.value})} placeholder="e.g. 20601652"/></Field>
          <Field label="FedEx account #"><Input value={eng.account} onChange={e=>setEng({account:e.target.value})} placeholder="20601652"/></Field>
          <Field label="API base URL"><Input value={eng.base} onChange={e=>setEng({base:e.target.value})}/></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={runTest} disabled={!eng.apiKey||!eng.customerId} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium hover:bg-stone-800 disabled:opacity-40 flex items-center gap-1.5">{test&&test.loading?<><Loader2 className="w-4 h-4 animate-spin"/>Testing…</>:<><ShieldCheck className="w-4 h-4"/>Test connection</>}</button>
          {test&&!test.loading&&<span className={`text-xs flex items-center gap-1.5 ${test.ok?"text-emerald-700":"text-blue-600"}`}>{test.ok?<CheckCircle2 className="w-4 h-4"/>:<AlertTriangle className="w-4 h-4"/>}{test.msg}</span>}
        </div>
        <p className="text-[11px] text-stone-400">For production, store the API key as a Netlify env var (<span className="font-mono">ENGLAND_API_KEY</span>, <span className="font-mono">ENGLAND_CUSTOMER_ID</span>) instead of here, so it never ships to the browser. England authenticates with the API key + customer ID; if you only have the FedEx account number, try it as the customer ID or confirm the key with your England rep.</p>
      </div>
    </div>
    <div>
      <h3 className="text-sm font-semibold text-stone-700 mb-1">ShippingCloud platform accounts</h3>
      <p className="text-sm text-stone-500 mb-3">Ship on ShippingCloud's negotiated accounts — no carrier contract needed. Toggle on the ones you want to offer; your markup still applies.</p>
      <div className="border border-stone-200 rounded-lg bg-white divide-y divide-stone-100">
        {PLATFORM_CARRIERS.map(c=>(
          <div key={c.id} className="flex items-center gap-3 px-4 py-3">
            <div className={`w-12 text-xs font-bold ${c.tint}`}>{c.name}</div>
            <div className="flex-1 min-w-0"><div className="text-sm font-medium">{c.blurb}</div><div className="text-[11px] text-stone-400">ShippingCloud account · instant</div></div>
            {plat[c.id]&&<Badge tone="green">on</Badge>}
            <button onClick={()=>togglePlat(c.id)}><span className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors ${plat[c.id]?"bg-blue-600 justify-end":"bg-stone-300 justify-start"}`}><span className="w-4 h-4 bg-white rounded-full"/></span></button>
          </div>
        ))}
      </div>
    </div>
    <div>
      <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold text-stone-700">Your own carrier accounts</h3><button onClick={()=>setAdding(v=>!v)} className="flex items-center gap-1 text-sm bg-stone-200 hover:bg-stone-300 rounded px-2.5 py-1.5"><Plus className="w-4 h-4"/>Add</button></div>
      <p className="text-sm text-stone-500 mb-3">Prefer your own negotiated rates? Connect your FedEx, UPS, or England account number.</p>
      {adding&&<Panel title="Add carrier account">
        <div className="grid grid-cols-2 gap-3"><Field label="Label"><Input value={d.label} onChange={e=>setD({...d,label:e.target.value})}/></Field><Field label="Provider"><Select value={d.provider} onChange={e=>setD({...d,provider:e.target.value})}>{PROVIDERS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field></div>
        <Field label="Account #"><Input value={d.account} onChange={e=>setD({...d,account:e.target.value})}/></Field>
        <Field label="API key"><Input type="password" value={d.apiKey} onChange={e=>setD({...d,apiKey:e.target.value})}/></Field>
        {d.provider==="england"&&<Field label="Customer ID"><Input value={d.customerId} onChange={e=>setD({...d,customerId:e.target.value})}/></Field>}
        {d.provider!=="england"&&<Field label="Secret"><Input type="password" value={d.secret} onChange={e=>setD({...d,secret:e.target.value})}/></Field>}
        <button onClick={add} className="text-sm bg-stone-900 text-white rounded px-4 py-2 font-medium">Connect</button>
      </Panel>}
      <div className="space-y-2 mt-2">{accounts.map(a=>(<div key={a.id} className="border border-stone-200 rounded-lg bg-white p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded bg-blue-50 text-blue-600 flex items-center justify-center"><Wifi className="w-4 h-4"/></div>
        <div className="flex-1"><div className="font-medium">{a.label||a.provider}</div><div className="text-[11px] text-stone-400 font-mono">{(PROVIDERS.find(p=>p.id===a.provider)||{}).name}{a.account?` · ${a.account}`:""}</div></div>
        <Badge tone="amber">{a.mode}</Badge>
        <button onClick={()=>setAccounts(x=>x.filter(y=>y.id!==a.id))} className="text-stone-300 hover:text-rose-500"><Trash2 className="w-4 h-4"/></button>
      </div>))}</div>
    </div>
  </div>);
}

/* ════════ SUBSCRIPTION ════════ */
function Subscription({settings,setSettings}){
  const current=settings.plan||"starter";
  const order=["free","starter","pro","scale"];
  return (<div className="space-y-4">
    <p className="text-sm text-stone-500">Your ShippingCloud plan. Upgrade to unlock more volume, integrations, and tools. Downgrade anytime.</p>
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {PLANS.map(p=>{const active=p.id===current;const isUp=order.indexOf(p.id)>order.indexOf(current);return (
        <div key={p.id} className={`rounded-xl border p-4 flex flex-col ${active?"border-blue-500 bg-blue-50/40 ring-1 ring-blue-200":"border-stone-200 bg-white"}`}>
          <div className="flex items-center justify-between"><div className="font-bold text-stone-900">{p.name}</div>{active&&<Badge tone="blue">current</Badge>}</div>
          <div className="text-[11px] text-stone-400 mb-2">{p.tagline}</div>
          <div className="text-2xl font-bold">{p.price===0?"Free":<>${p.price}<span className="text-sm font-normal text-stone-400">/mo</span></>}</div>
          <div className="text-[11px] text-blue-600 font-medium mb-3">{p.limits}</div>
          <ul className="space-y-1.5 flex-1">{p.features.map(f=>(<li key={f} className="flex items-start gap-1.5 text-[12px] text-stone-600"><Check className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5"/>{f}</li>))}</ul>
          <button onClick={()=>setSettings({...settings,plan:p.id})} disabled={active} className={`mt-3 text-sm rounded px-3 py-2 font-medium ${active?"bg-stone-100 text-stone-400":isUp?"bg-stone-900 text-white hover:bg-stone-800":"bg-stone-200 text-stone-700 hover:bg-stone-300"}`}>{active?"Current plan":isUp?"Upgrade":"Switch"}</button>
        </div>
      );})}
    </div>
    <p className="text-[11px] text-stone-400">Plans shown for demo. Billing isn't charged here — wire this to Stripe when you're ready to take payments.</p>
  </div>);
}

/* ════════ DRAFTS ════════ */
function Drafts({drafts,setDrafts,goShip}){
  if(!drafts.length)return <Empty icon={FileText} title="No saved drafts" body="On the Ship tab, fill out a shipment and hit “Save draft.” It'll show up here to finish later."/>;
  const load=(d)=>goShip({draft:d.snap});
  return (<div className="max-w-3xl space-y-2">
    <p className="text-sm text-stone-500">Half-finished shipments you saved. Open one to pick up right where you left off.</p>
    <div className="border border-stone-200 rounded-lg bg-white divide-y divide-stone-100">
      {drafts.map(d=>(<div key={d.id} className="flex items-center gap-3 px-4 py-3 hover:bg-stone-50">
        <FileText className="w-4 h-4 text-stone-300 shrink-0"/>
        <div className="flex-1 min-w-0"><div className="text-sm font-medium text-stone-800 truncate">{d.label}</div><div className="text-[11px] text-stone-400">{d.to?`to ${d.to} · `:""}saved {d.when}</div></div>
        <button onClick={()=>load(d)} className="text-sm bg-stone-900 text-white rounded px-3 py-1.5 font-medium hover:bg-stone-800">Open</button>
        <button onClick={()=>setDrafts(p=>p.filter(x=>x.id!==d.id))} className="text-stone-300 hover:text-rose-500"><Trash2 className="w-4 h-4"/></button>
      </div>))}
    </div>
  </div>);
}

/* ════════ INVOICES ════════ */
function Invoices({invoices,setInvoices,shipments,client}){
  const live=shipments.filter(s=>s.status!=="Voided");
  const uninvoicedTotal=live.reduce((a,s)=>a+s.sell,0);
  const generate=()=>{if(!live.length)return;const num="INV-"+(1003+invoices.length);setInvoices(p=>[{id:"inv"+Date.now(),number:num,client:client.name,date:new Date().toLocaleDateString(),labels:live.length,amount:Math.round(uninvoicedTotal*100)/100,status:"Open"},...p]);};
  const markPaid=(id)=>setInvoices(p=>p.map(i=>i.id===id?{...i,status:"Paid"}:i));
  const open=invoices.filter(i=>i.status==="Open").reduce((a,i)=>a+i.amount,0);
  const exportCSV=()=>downloadCSV("shippingcloud-invoices.csv",[["Invoice","Client","Date","Labels","Amount","Status"],...invoices.map(i=>[i.number,i.client,i.date,i.labels,i.amount,i.status])]);
  return (<div className="max-w-3xl space-y-4">
    <div className="grid grid-cols-3 gap-3">
      <Stat2 label="Invoices" v={invoices.length}/>
      <Stat2 label="Open balance" v={money(open)} tone={open?"text-blue-600":""}/>
      <Stat2 label="Billed all-time" v={money(invoices.reduce((a,i)=>a+i.amount,0))}/>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-sm font-semibold text-stone-700 flex items-center gap-2"><Receipt className="w-4 h-4"/>Invoices</h2>
      <div className="flex-1"/>
      <button onClick={exportCSV} className="flex items-center gap-1.5 text-sm bg-stone-200 text-stone-700 rounded px-3 py-1.5 font-medium hover:bg-stone-300"><Download className="w-4 h-4"/>Export</button>
      <button onClick={generate} className="flex items-center gap-1.5 text-sm bg-stone-900 text-white rounded px-3 py-1.5 font-medium hover:bg-stone-800"><Plus className="w-4 h-4"/>Generate from shipments</button>
    </div>
    <div className="border border-stone-200 rounded-lg bg-white divide-y divide-stone-100">
      <div className="flex items-center gap-3 px-4 py-2 bg-stone-50 text-[11px] uppercase tracking-widest text-stone-400"><div className="w-24">Invoice</div><div className="flex-1">Client</div><div className="w-16 text-right">Labels</div><div className="w-24 text-right">Amount</div><div className="w-20 text-right">Status</div><div className="w-16"/></div>
      {invoices.length===0&&<div className="p-8 text-center text-sm text-stone-400">No invoices yet.</div>}
      {invoices.map(i=>(<div key={i.id} className="flex items-center gap-3 px-4 py-3">
        <div className="w-24 font-mono text-sm font-semibold">{i.number}</div>
        <div className="flex-1 min-w-0"><div className="text-sm truncate">{i.client}</div><div className="text-[11px] text-stone-400">{i.date}</div></div>
        <div className="w-16 text-right font-mono text-sm text-stone-500">{i.labels}</div>
        <div className="w-24 text-right font-mono text-sm font-semibold">{money(i.amount)}</div>
        <div className="w-20 text-right"><Badge tone={i.status==="Paid"?"green":"amber"}>{i.status}</Badge></div>
        <div className="w-16 text-right">{i.status==="Open"&&<button onClick={()=>markPaid(i.id)} className="text-xs text-blue-600 hover:underline">Mark paid</button>}</div>
      </div>))}
    </div>
  </div>);
}

/* ════════ LEDGER ════════ */
function Ledger({ledger,addLedger}){
  const [funds,setFunds]=useState("");
  const [adj,setAdj]=useState({amount:"",note:""});
  const balance=ledger.reduce((a,e)=>a+e.amount,0);
  const addFunds=()=>{const amt=+funds;if(!amt)return;addLedger({type:"Funds added",ref:"Manual deposit",amount:Math.abs(amt)});setFunds("");};
  const addAdj=()=>{const amt=+adj.amount;if(!amt)return;addLedger({type:"Adjustment",ref:adj.note||"Adjustment",amount:amt});setAdj({amount:"",note:""});};
  // running balance (oldest first), display newest first
  let run=0; const withRun=[...ledger].reverse().map(e=>{run+=e.amount;return {...e,run};}).reverse();
  return (<div className="max-w-3xl space-y-4">
    <div className="grid sm:grid-cols-3 gap-3">
      <div className="border border-stone-200 rounded-xl bg-white p-4 sm:col-span-1"><div className="text-[11px] uppercase tracking-widest text-stone-400">Account balance</div><div className={`text-3xl font-bold mt-1 ${balance<0?"text-rose-600":"text-stone-900"}`}>{money(balance)}</div></div>
      <div className="border border-stone-200 rounded-xl bg-white p-4"><div className="text-[11px] uppercase tracking-widest text-stone-400 mb-1">Add funds</div><div className="flex gap-2"><div className="relative flex-1"><DollarSign className="w-4 h-4 absolute left-2 top-2.5 text-stone-400"/><input type="number" value={funds} onChange={e=>setFunds(e.target.value)} placeholder="100.00" className="w-full bg-white border border-stone-200 rounded pl-7 pr-2 py-2 text-sm font-mono outline-none focus:border-blue-500"/></div><button onClick={addFunds} className="text-sm bg-stone-900 text-white rounded px-3 py-2 font-medium hover:bg-stone-800">Add</button></div></div>
      <div className="border border-stone-200 rounded-xl bg-white p-4"><div className="text-[11px] uppercase tracking-widest text-stone-400 mb-1">Adjustment</div><div className="flex gap-2"><input type="number" value={adj.amount} onChange={e=>setAdj({...adj,amount:e.target.value})} placeholder="±0.00" className="w-20 bg-white border border-stone-200 rounded px-2 py-2 text-sm font-mono outline-none focus:border-blue-500"/><input value={adj.note} onChange={e=>setAdj({...adj,note:e.target.value})} placeholder="note" className="flex-1 min-w-0 bg-white border border-stone-200 rounded px-2 py-2 text-sm outline-none focus:border-blue-500"/><button onClick={addAdj} className="text-sm bg-stone-200 text-stone-700 rounded px-3 py-2 font-medium hover:bg-stone-300">Post</button></div></div>
    </div>
    <div className="border border-stone-200 rounded-lg bg-white divide-y divide-stone-100">
      <div className="flex items-center gap-3 px-4 py-2 bg-stone-50 text-[11px] uppercase tracking-widest text-stone-400"><div className="w-24">Date</div><div className="w-36">Type</div><div className="flex-1">Reference</div><div className="w-24 text-right">Amount</div><div className="w-24 text-right">Balance</div></div>
      {withRun.length===0&&<div className="p-8 text-center text-sm text-stone-400">No transactions yet.</div>}
      {withRun.map(e=>(<div key={e.id} className="flex items-center gap-3 px-4 py-2.5">
        <div className="w-24 text-sm font-mono text-stone-500">{e.date}</div>
        <div className="w-36 text-sm">{e.type}</div>
        <div className="flex-1 min-w-0 text-sm text-stone-500 truncate">{e.ref}</div>
        <div className={`w-24 text-right font-mono text-sm ${e.amount<0?"text-rose-600":"text-emerald-600"}`}>{e.amount<0?"−":"+"}{money(Math.abs(e.amount))}</div>
        <div className="w-24 text-right font-mono text-sm text-stone-700">{money(e.run)}</div>
      </div>))}
    </div>
  </div>);
}


function Clients({clients,setClients}){
  const set=(id,v)=>setClients(cs=>cs.map(c=>c.id===id?{...c,markup:Math.max(0,v)}:c));
  return (<div className="space-y-3 max-w-2xl"><p className="text-sm text-stone-500">Markup is your cut on every label this client ships. Customers never see it.</p>
    {clients.map(c=>(<div key={c.id} className="border border-stone-200 rounded-lg bg-white p-4 flex items-center gap-4"><div className="w-9 h-9 rounded bg-stone-100 flex items-center justify-center text-blue-600 font-semibold">{c.name[0]}</div><div className="flex-1"><div className="font-medium">{c.name}</div><div className="text-[11px] text-stone-400 font-mono">origin {c.origin}</div></div><button onClick={()=>set(c.id,c.markup-1)} className="w-7 h-7 rounded bg-stone-200 hover:bg-stone-300">–</button><div className="w-14 text-center font-mono text-blue-600 font-semibold">{c.markup}%</div><button onClick={()=>set(c.id,c.markup+1)} className="w-7 h-7 rounded bg-stone-200 hover:bg-stone-300">+</button></div>))}
  </div>);
}

/* ════════ PRIMITIVES ════════ */
function AddressCard({title,data,set,required,residential,setResidential}){
  const f=(k,v)=>set({...data,[k]:v});
  const Cell=({label,k,span,req})=>(<div className={`px-2 py-1.5 ${req&&!data[k]?"bg-blue-50":"bg-white"} ${span||""}`}><div className={`text-[9px] uppercase tracking-wide ${req&&!data[k]?"text-blue-600":"text-stone-400"}`}>{label}</div>{k==="country"?<select value={data.country||"United States"} onChange={e=>f("country",e.target.value)} className="w-full bg-transparent text-[13px] text-stone-900 outline-none mt-0.5">{COUNTRIES.map(c=><option key={c}>{c}</option>)}</select>:<input value={data[k]||""} onChange={e=>f(k,e.target.value)} className="w-full bg-transparent text-[13px] text-stone-900 outline-none mt-0.5 placeholder-stone-300"/>}</div>);
  return (<div><div className="flex items-center justify-between mb-1.5"><span className="text-blue-600 font-semibold text-sm">{title}</span>{setResidential&&<label className="flex items-center gap-1.5 text-[11px] text-stone-500"><input type="checkbox" checked={residential} onChange={e=>setResidential(e.target.checked)} className="accent-blue-600"/>Residential</label>}</div>
    <div className="grid grid-cols-6 gap-px bg-stone-200 border border-stone-200 rounded-lg overflow-hidden">
      <Cell label="Country" k="country" span="col-span-6"/><Cell label="Name" k="name" span="col-span-3" req={required}/><Cell label="Company" k="company" span="col-span-3"/><Cell label="Zip" k="zip" span="col-span-2" req={required}/><Cell label="State" k="state" span="col-span-2" req={required}/><Cell label="City" k="city" span="col-span-2" req={required}/><Cell label="Address 1" k="address1" span="col-span-6" req={required}/><Cell label="Address 2" k="address2" span="col-span-3"/><Cell label="Address 3" k="address3" span="col-span-3"/><Cell label="Phone" k="phone" span="col-span-3"/><Cell label="Email" k="email" span="col-span-3"/>
    </div></div>);
}
function PkgInput({label,w,...p}){return <div><div className="text-[10px] uppercase tracking-widest text-stone-500">{label}</div><input {...p} type="number" className={`${w||"w-14"} bg-white border border-stone-300 rounded px-2 py-1 text-sm font-mono text-stone-900 outline-none focus:border-blue-500`}/></div>;}
function Panel({title,children}){return <div className="border border-stone-200 rounded-lg bg-white p-4 space-y-3"><div className="text-[11px] uppercase tracking-widest text-stone-400">{title}</div>{children}</div>;}
function Field({label,children}){return <label className="block space-y-1"><span className="text-[11px] text-stone-500">{label}</span>{children}</label>;}
function Input({className="",...p}){return <input {...p} className={`w-full bg-white border border-stone-200 rounded px-2.5 py-2 text-sm font-mono text-stone-900 focus:border-blue-500 outline-none ${className}`}/>;}
function Select({children,...p}){return <select {...p} className="w-full bg-white border border-stone-200 rounded px-2.5 py-2 text-sm focus:border-blue-500 outline-none">{children}</select>;}
function Toggle({on,set,label}){return <button onClick={()=>set(!on)} className={`flex items-center gap-1.5 text-xs rounded px-2.5 py-1.5 border ${on?"bg-blue-50 border-blue-200 text-blue-600":"bg-white border-stone-200 text-stone-400"}`}><span className={`w-2 h-2 rounded-full ${on?"bg-blue-600":"bg-stone-300"}`}/>{label}</button>;}
function Badge({children,tone="stone"}){const t={stone:"bg-stone-100 text-stone-500 border-stone-200",green:"bg-emerald-50 text-emerald-700 border-emerald-200",amber:"bg-amber-50 text-amber-700 border-amber-200",blue:"bg-sky-50 text-sky-700 border-sky-200",rose:"bg-rose-50 text-rose-600 border-rose-200"}[tone];return <span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border ${t}`}>{children}</span>;}
function Empty({icon:Icon,title,body}){return <div className="border border-dashed border-stone-300 rounded-lg p-12 text-center"><Icon className="w-8 h-8 text-stone-300 mx-auto mb-3"/><div className="text-stone-700 font-medium">{title}</div><div className="text-sm text-stone-400 mt-1 max-w-sm mx-auto">{body}</div></div>;}
function EditField({label,v,on}){return <label className="block"><span className="text-[10px] uppercase tracking-wide text-stone-400">{label}</span><input value={v} onChange={e=>on(e.target.value)} className="w-full bg-white border border-stone-200 rounded px-2 py-1 text-sm mt-0.5 outline-none focus:border-blue-500"/></label>;}
function Info({k,v}){return <div className="flex justify-between gap-4 py-0.5 border-b border-stone-100"><span className="text-stone-400">{k}</span><span className="text-stone-800 text-right">{v}</span></div>;}
