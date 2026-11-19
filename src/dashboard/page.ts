// Single-page operations dashboard (no build step, no external scripts). All data comes from
// /api/overview; every value is inserted with textContent, never as HTML.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DailyBot Operasyon</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b1220;--panel:#111a2e;--panel2:#16213a;--line:#22304d;--text:#e6ecf7;--muted:#8b9ab8;--brand:#4f8cff;--up:#22c55e;--down:#ef4444;--warn:#f59e0b;--chip:#1c2a47;--shadow:0 1px 0 rgba(255,255,255,.03),0 8px 24px rgba(0,0,0,.25)}
@media (prefers-color-scheme: light){:root{--bg:#f4f6fb;--panel:#fff;--panel2:#f8faff;--line:#e3e8f2;--text:#0f172a;--muted:#5b6b88;--brand:#2563eb;--chip:#eef2fb;--shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06)}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,sans-serif}
a{color:inherit}.mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar{max-width:1320px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px}
.logo i{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--brand),#7c3aed);display:inline-block}
.logo small{display:block;font-weight:500;color:var(--muted);font-size:11px;letter-spacing:.6px;text-transform:uppercase}
nav{display:flex;gap:4px;flex-wrap:wrap}nav a{text-decoration:none;color:var(--muted);padding:6px 10px;border-radius:8px;font-weight:500}nav a:hover{background:var(--chip);color:var(--text)}
.tick{margin-left:auto;display:flex;gap:14px;align-items:center;color:var(--muted);font-size:12.5px}.tick b{color:var(--text);font-weight:600}
main{max-width:1320px;margin:0 auto;padding:22px 20px 60px}
h2{font-size:15px;margin:34px 0 12px;display:flex;align-items:center;gap:10px}h2 span{color:var(--muted);font-weight:500;font-size:12.5px}
.grid{display:grid;gap:14px}.kpis{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}.engines{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.kpi .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px}.kpi .v{font-size:24px;font-weight:700;margin-top:4px}.kpi .s{color:var(--muted);font-size:12.5px}
.up{color:var(--up)}.down{color:var(--down)}.warn{color:var(--warn)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--chip);color:var(--muted);white-space:nowrap}
.badge.live{background:rgba(239,68,68,.14);color:var(--down)}.badge.testnet{background:rgba(245,158,11,.15);color:var(--warn)}.badge.paper{background:rgba(79,140,255,.14);color:var(--brand)}
.badge.ok{background:rgba(34,197,94,.14);color:var(--up)}.badge.bad{background:rgba(239,68,68,.14);color:var(--down)}
.badge.long{background:rgba(34,197,94,.14);color:var(--up)}.badge.short{background:rgba(239,68,68,.14);color:var(--down)}
.eng h3{margin:0;font-size:15px;display:flex;align-items:center;gap:8px;justify-content:space-between}.eng .sub{color:var(--muted);font-size:12.5px;margin:2px 0 10px}
.eng .row{display:flex;justify-content:space-between;padding:5px 0;border-top:1px dashed var(--line);font-size:13px}.eng .row span:first-child{color:var(--muted)}
svg.spark{width:100%;height:56px;display:block;margin:6px 0 8px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600;background:var(--panel2);position:sticky;top:0}
tr:last-child td{border-bottom:0}td.num{text-align:right;font-variant-numeric:tabular-nums}th.num{text-align:right}
.empty{padding:26px;text-align:center;color:var(--muted)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}.chip{border:1px solid var(--line);background:var(--panel);color:var(--muted);padding:5px 11px;border-radius:999px;cursor:pointer;font:inherit;font-size:12.5px}.chip.on{background:var(--brand);border-color:var(--brand);color:#fff}
.why{color:var(--text);max-width:760px}.raw{color:var(--muted);font-size:11.5px;margin-top:3px}.note{color:var(--muted);font-size:12.5px;margin-top:8px}
.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.35);color:var(--down);padding:10px 14px;border-radius:10px;margin-bottom:14px;display:none}
footer{color:var(--muted);font-size:12px;text-align:center;padding:30px 0 0}
@media (max-width:640px){.tick{margin-left:0;width:100%}.kpi .v{font-size:20px}}
</style>
</head>
<body>
<header><div class="bar">
  <div class="logo"><i></i><div>DailyBot<small>Trading Operasyon Merkezi</small></div></div>
  <nav><a href="#ozet">Özet</a><a href="#pozisyonlar">Açık Pozisyonlar</a><a href="#islemler">İşlemler</a><a href="#kararlar">Karar Günlüğü</a><a href="#olaylar">Olaylar</a></nav>
  <div class="tick" id="tick">yükleniyor…</div>
</div></header>
<main>
  <div class="err" id="err"></div>
  <section id="ozet"><div class="grid kpis" id="kpis"></div><h2>Motorlar <span>her biri ayrı hesap / sermaye dilimi</span></h2><div class="grid engines" id="engines"></div></section>
  <section id="pozisyonlar"><h2>Açık Pozisyonlar <span>stop emri borsada duruyor; take-profit emri yok, çıkış stratejinin kuralıyla</span></h2><div class="tablewrap"><table id="open"></table></div></section>
  <section id="islemler"><h2>İşlem Geçmişi <span>son 100 kapanan işlem</span></h2><div class="tablewrap"><table id="closed"></table></div></section>
  <section id="kararlar"><h2>Karar Günlüğü <span>her mum kapanışında motorun kararı ve nedeni (GC saatlik, A ve TS 4 saatlik)</span></h2><div class="chips" id="chips"></div><div class="tablewrap"><table id="decisions"></table></div><button class="chip" id="more" style="margin-top:10px;display:none"></button><div class="note">"Sinyal yok" satırındaki neden, girişin hangi koşulunu beklediğini gösterir (ör. 20 mumluk zirveye uzaklık, EMA farkı, momentum skoru).</div></section>
  <section id="olaylar"><h2>Olaylar <span>uyarılar, stop işlemleri, kill switch</span></h2><div class="tablewrap"><table id="events"></table></div></section>
  <footer>Veriler 60 saniyede bir yenilenir · Saatler tarayıcınızın saat diliminde · Salt okunur panel</footer>
</main>
<script>
const $=(id)=>document.getElementById(id);
function el(tag,attrs,...kids){const e=document.createElement(tag);if(attrs)for(const[k,v]of Object.entries(attrs)){if(k==="class")e.className=v;else e.setAttribute(k,v)}for(const k of kids){if(k===null||k===undefined)continue;e.append(k instanceof Node?k:document.createTextNode(String(k)))}return e}
const fmt=(n,d=2)=>n===null||n===undefined||!isFinite(n)?"–":Number(n).toLocaleString("tr-TR",{minimumFractionDigits:d,maximumFractionDigits:d});
const px=(n)=>n===null||n===undefined?"–":fmt(n,n<10?4:2);
const pct=(n,d=2)=>n===null||n===undefined||!isFinite(n)?"–":fmt(n*100,d)+"%";
const t=(ms)=>ms?new Date(ms).toLocaleString("tr-TR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"–";
const signed=(n,d=2)=>n===null||n===undefined?"–":(n>0?"+":"")+fmt(n,d);
const cls=(n)=>n>0?"up":n<0?"down":"";
const modeBadge=(m)=>el("span",{class:"badge "+(m||"")},m==="live"?"CANLI":m==="testnet"?"TESTNET":"PAPER");
const sideBadge=(s)=>el("span",{class:"badge "+(s==="LONG"?"long":"short")},s==="LONG"?"LONG":"SHORT");
const REASONS={STOP_NOT_TRIGGERED:"Stop tetiklenmedi, piyasadan kapatıldı",STRATEGY_EXIT:"Strateji çıkışı",EXCHANGE_CLOSE:"Borsada stop",TRAIL_STOP_CROSSED:"Takip stopu aşıldı",STOP_PLACEMENT_FAILED:"Stop konamadı",EXCHANGE_CLOSE_NO_FILLS:"Borsada kapandı (dolum yok)"};
const GATES={NO_SIGNAL:"Sinyal yok",KILL_SWITCH:"Kill switch açık",DATA_STALE:"Veri gecikmeli",MAX_DRAWDOWN:"Düşüş limiti",DAILY_LOSS_LIMIT:"Günlük zarar limiti",ALREADY_IN_POSITION:"Zaten pozisyonda",MAX_OPEN_POSITIONS:"Maks. pozisyon"};
let data=null,filter="ALL",symFilter="ALL",shown=40;
function trWhy(d){const x=d.detail,n=(r)=>{const m=x.match(r);return m?Number(m[1]):null};
  if(d.gate!=="NO_SIGNAL")return d.accepted?"Giriş koşulları sağlandı, işlem açıldı.":"Sinyal vardı ama risk kuralı engelledi: "+(GATES[d.gate]||d.gate);
  if(/warming up/.test(x))return "Göstergeler için yeterli geçmiş veri birikiyor.";
  if(/trend (up|down|mixed)/.test(x)){const tr=x.match(/trend (up|down|mixed)/)[1],hi=n(/high [0-9.]+ \\((-?[0-9.]+)% away\\)/),lo=n(/low [0-9.]+ \\((-?[0-9.]+)% away\\)/);const blocked=/BLOCKED/.test(x)?" Volatilite çok yüksek, giriş engelli.":"";
    if(tr==="up")return "Trend yukarı. Long için fiyatın 20 mumluk zirveyi geçmesi gerekiyor: %"+fmt(hi)+" uzakta."+blocked;
    if(tr==="down")return "Trend aşağı. Short için fiyatın 20 mumluk dibin altında kapanması gerekiyor: %"+fmt(lo)+" uzakta."+blocked;
    return "Trend net değil (EMA'lar ve fiyat aynı yönü göstermiyor); işlem yok."+blocked}
  if(/ema50 .* ema200/.test(x)){const g=n(/gap (-?[0-9.]+)%/),above=/ above /.test(x);return "EMA50, EMA200'ün %"+fmt(Math.abs(g))+" "+(above?"üstünde":"altında")+". İşlem sadece kesişim anında: sıradaki "+(above?"aşağı kesişim (short)":"yukarı kesişim (long)")+"."}
  if(/momentum score/.test(x)){const sc=n(/score (-?[0-9.]+)/),up=x.match(/up vs (\\d+)\\/(\\d+)/);return "Momentum skoru "+fmt(sc)+" (long için en az 0,60 gerekli). Yukarıda olan süre: "+(up?up[1]+"/"+up[2]:"–")+"."}
  return x}
function spark(series){const w=300,h=56;if(!series||series.length<2)return el("div",{class:"note"},"Özsermaye eğrisi için veri birikiyor");const vs=series.map(p=>p.v),mn=Math.min(...vs),mx=Math.max(...vs),r=mx-mn||1;const pts=series.map((p,i)=>[(i/(series.length-1))*w,h-4-((p.v-mn)/r)*(h-8)]);const d=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");const up=vs.at(-1)>=vs[0];const ns="http://www.w3.org/2000/svg";const s=document.createElementNS(ns,"svg");s.setAttribute("viewBox","0 0 "+w+" "+h);s.setAttribute("preserveAspectRatio","none");s.setAttribute("class","spark");const a=document.createElementNS(ns,"path");a.setAttribute("d",d+" L "+w+" "+h+" L 0 "+h+" Z");a.setAttribute("fill",up?"rgba(34,197,94,.12)":"rgba(239,68,68,.12)");const l=document.createElementNS(ns,"path");l.setAttribute("d",d);l.setAttribute("fill","none");l.setAttribute("stroke",up?"var(--up)":"var(--down)");l.setAttribute("stroke-width","2");l.setAttribute("vector-effect","non-scaling-stroke");s.append(a,l);return s}
function table(id,head,rows,empty){const tb=$(id);tb.replaceChildren();tb.append(el("thead",null,el("tr",null,...head.map(h=>el("th",h.num?{class:"num"}:null,h.t||h)))));const body=el("tbody");if(!rows.length)body.append(el("tr",null,el("td",{colspan:String(head.length),class:"empty"},empty)));for(const r of rows)body.append(el("tr",null,...r.map((c,i)=>{const td=el("td",head[i].num?{class:"num"}:null);if(c instanceof Node)td.append(c);else td.textContent=c===null||c===undefined?"–":String(c);return td})));tb.append(body)}
function render(){const E=data.engines.filter(e=>!e.error),prices=data.prices||{};
  $("tick").replaceChildren(...["BTCUSDT","ETHUSDT"].map(s=>el("span",null,s.replace("USDT","")+" ",el("b",null,prices[s]?fmt(prices[s],2):"–"))),el("span",null,"güncelleme "+new Date(data.generatedAt).toLocaleTimeString("tr-TR")));
  const errs=data.engines.filter(e=>e.error);$("err").style.display=errs.length?"block":"none";$("err").textContent=errs.map(e=>e.key+": "+e.error).join(" · ");
  const total=E.reduce((a,e)=>a+(e.equity.now||0),0),start=E.reduce((a,e)=>a+(e.equity.start||0),0),day=E.reduce((a,e)=>a+((e.equity.now||0)-(e.equity.dayStart??e.equity.now??0)),0);
  const openN=E.reduce((a,e)=>a+e.open.length,0),closedN=E.reduce((a,e)=>a+e.stats.closedTrades,0),net=E.reduce((a,e)=>a+e.stats.netPnl,0),ks=E.filter(e=>e.killSwitch&&e.killSwitch.on);
  const kpi=(l,v,s,c)=>el("div",{class:"card kpi"},el("div",{class:"l"},l),el("div",{class:"v "+(c||"")},v),el("div",{class:"s"},s));
  $("kpis").replaceChildren(kpi("Toplam özsermaye",fmt(total)+" USDT",start?("başlangıç "+fmt(start)+" · "+signed((total/start-1)*100)+"%"):""),kpi("Bugün",signed(day)+" USDT","UTC gün başından beri",cls(day)),kpi("Açık pozisyon",String(openN),openN?"stoplar borsada":"pozisyon yok"),kpi("Kapanan işlem",String(closedN),"net "+signed(net)+" USDT",cls(net)),kpi("Sistem",ks.length?"DURDU":"ÇALIŞIYOR",ks.length?ks.map(e=>e.key+": "+e.killSwitch.reason).join(" · "):"kill switch kapalı",ks.length?"down":"up"));
  $("engines").replaceChildren(...E.map(e=>{const x=e.expectation||{},s=e.stats,row=(a,b,c)=>el("div",{class:"row"},el("span",null,a),el("span",{class:c||""},b));const chg=e.equity.start?(e.equity.now/e.equity.start-1):null;
    return el("div",{class:"card eng"},el("h3",null,el("span",null,e.key+" · "+e.label),modeBadge(e.mode)),el("div",{class:"sub mono"},e.strategy),spark(e.equity.series),
      row("Özsermaye",fmt(e.equity.now)+" USDT"),row("Değişim",chg===null?"–":signed(chg*100)+"%",cls(chg)),row("Düşüş (backtest maks.)",pct(e.equity.drawdownPct,1)+" ("+pct(x.maxDrawdown,1)+")",e.equity.drawdownPct>(x.maxDrawdown||1)?"down":""),
      row("İşlem / kazanma",s.closedTrades+" / "+(s.winRate===null?"–":pct(s.winRate,0))+" (bt "+pct(x.winRate,0)+")"),row("Kâr faktörü",(s.profitFactor===null?"–":fmt(s.profitFactor))+" (bt "+fmt(x.profitFactor)+")"),
      row("Çıkış kuralı",e.exitRule),row("Kill switch",e.killSwitch&&e.killSwitch.on?"AÇIK":"kapalı",e.killSwitch&&e.killSwitch.on?"down":"up"))}));
  const openRows=[];for(const e of E)for(const p of e.open){const m=prices[p.symbol]??null,dir=p.side==="LONG"?1:-1,u=m===null?null:(m-p.entryPrice)*p.quantity*dir,r=u===null?null:u/(p.riskAmount||1),dist=m===null?null:dir*(m-p.stop)/m;
    openRows.push([e.key,p.symbol,sideBadge(p.side),px(p.entryPrice),px(m),el("b",null,px(p.stop)),px(p.initialStop),pct(dist),el("span",{class:cls(u)},signed(u)+" / "+signed(r)+"R"),p.leverage+"x",t(p.entryTime),"yok · "+e.exitRule])}
  table("open",["Motor","Sembol","Yön",{t:"Giriş",num:1},{t:"Anlık",num:1},{t:"Stop",num:1},{t:"İlk stop",num:1},{t:"Stop'a mesafe",num:1},{t:"Kâr/Zarar (USDT / R)",num:1},"Kaldıraç","Açılış","Take-profit"],openRows,"Açık pozisyon yok. Motorlar giriş koşulunu bekliyor (Karar Günlüğü'ne bakın).");
  const closed=E.flatMap(e=>e.closed.map(p=>({e,p}))).sort((a,b)=>(b.p.exitTime||0)-(a.p.exitTime||0)).slice(0,100);
  table("closed",["Motor","Sembol","Yön",{t:"Giriş",num:1},{t:"Çıkış",num:1},{t:"İlk stop",num:1},{t:"Kâr/Zarar",num:1},{t:"R",num:1},"Açılış","Kapanış","Neden"],closed.map(({e,p})=>[e.key,p.symbol,sideBadge(p.side),px(p.entryPrice),px(p.exitPrice),px(p.initialStop),el("span",{class:cls(p.realizedPnl)},signed(p.realizedPnl)),el("span",{class:cls(p.realizedPnl)},signed((p.realizedPnl||0)/(p.riskAmount||1))),t(p.entryTime),t(p.exitTime),REASONS[p.exitReason]||p.exitReason]),"Henüz kapanan işlem yok.");
  const keys=["ALL",...E.map(e=>e.key)],syms=["ALL","BTCUSDT","ETHUSDT"];
  $("chips").replaceChildren(...keys.map(k=>{const b=el("button",{class:"chip"+(k===filter?" on":"")},k==="ALL"?"Tüm motorlar":k);b.onclick=()=>{filter=k;shown=40;render()};return b}),el("span",{style:"width:12px"}),...syms.map(k=>{const b=el("button",{class:"chip"+(k===symFilter?" on":"")},k==="ALL"?"Tüm semboller":k.replace("USDT",""));b.onclick=()=>{symFilter=k;shown=40;render()};return b}));
  const decAll=E.filter(e=>filter==="ALL"||e.key===filter).flatMap(e=>e.decisions.filter(d=>symFilter==="ALL"||d.symbol===symFilter).map(d=>({e,d}))).sort((a,b)=>b.d.candleOpenTime-a.d.candleOpenTime||b.d.createdAt-a.d.createdAt),dec=decAll.slice(0,shown);
  table("decisions",["Mum (açılış)","Motor","Sembol","Sonuç","Neden"],dec.map(({e,d})=>[t(d.candleOpenTime),e.key,d.symbol,d.gate==="NO_SIGNAL"?el("span",{class:"badge"},"Sinyal yok"):d.accepted?el("span",{class:"badge ok"},(d.side||"")+" sinyal · işleme girildi"):el("span",{class:"badge bad"},(d.side||"")+" sinyal · "+(GATES[d.gate]||d.gate)),el("div",{class:"why"},trWhy(d),el("div",{class:"mono raw"},d.detail))]),"Henüz kayıt yok. İlk satırlar bir sonraki mum kapanışında gelir.");
  const more=$("more");more.style.display=decAll.length>shown?"inline-block":"none";more.textContent="Daha fazla göster ("+(decAll.length-shown)+")";more.onclick=()=>{shown+=60;render()};
  const ev=E.flatMap(e=>e.events.map(v=>({e,v}))).sort((a,b)=>b.v.createdAt-a.v.createdAt).slice(0,100);
  table("events",["Zaman","Motor","Seviye","Tür","Sembol","Mesaj"],ev.map(({e,v})=>[t(v.createdAt),e.key,el("span",{class:"badge "+(v.level==="error"?"bad":v.level==="warn"?"testnet":"")},v.level),v.kind,v.symbol,el("span",{class:"mono"},v.message)]),"Olay yok.");
}
async function load(){try{const r=await fetch("/api/overview",{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);data=await r.json();render()}catch(e){$("err").style.display="block";$("err").textContent="Veri alınamadı: "+e.message}}
load();setInterval(load,60000);
</script>
</body>
</html>`;
