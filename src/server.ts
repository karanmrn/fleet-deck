// Embedded dashboard server. One process, one port, no framework.
// Server-rendered HTML; uPlot is served from the local node_modules, so the
// page makes zero calls to the outside internet.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { Ledger, defaultDbPath } from "./ledger.js";
import { buildPayload } from "./export.js";
import { runQuotaAxi } from "./quota.js";

const require = createRequire(import.meta.url);

let uplotJs: Buffer | null = null;
let uplotCss: Buffer | null = null;

function vendorAssets(): void {
  if (!uplotJs) uplotJs = readFileSync(require.resolve("uplot/dist/uPlot.iife.min.js"));
  if (!uplotCss) uplotCss = readFileSync(require.resolve("uplot/dist/uPlot.min.css"));
}

const PAGE = [
"<!DOCTYPE html>",
'<html lang="en">',
"<head>",
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1">',
"<title>fleet-deck</title>",
'<link rel="stylesheet" href="/vendor/uplot.css">',
"<style>",
":root{--bg:#0d1117;--panel:#161b22;--border:#2b333d;--text:#d7dde4;--muted:#7d8590;--accent:#58a6ff;--amber:#d29922;--green:#3fb950}",
"*{box-sizing:border-box}",
"body{margin:0;background:var(--bg);color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;line-height:1.5}",
"main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}",
"h1{font-size:20px;font-weight:600;letter-spacing:.5px;margin:0 0 24px;color:var(--accent)}",
"h1 span{color:var(--muted);font-weight:400}",
"h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted);margin:0 0 12px;border-bottom:1px solid var(--border);padding-bottom:8px}",
"section{margin-bottom:40px}",
".cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}",
".card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px}",
".card .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px}",
".card .value{font-size:22px;margin-top:6px}",
"table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}",
"th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}",
"th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600}",
"tr:last-child td{border-bottom:none}",
"td.num{text-align:right;font-variant-numeric:tabular-nums}",
".flag{color:var(--amber);font-size:11px}",
".chart{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px}",
"pre{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px;overflow-x:auto;margin:0;color:var(--text);font-size:12px}",
".energy{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px}",
".energy .big{font-size:26px;color:var(--green)}",
".energy .band{color:var(--amber);margin-top:4px}",
".energy .method{color:var(--muted);font-size:12px;margin-top:12px;max-width:70ch}",
".empty{color:var(--muted);padding:24px 0}",
".u-legend{font-size:11px!important}",
"</style>",
"</head>",
"<body>",
"<main>",
"<h1>fleet-deck <span>localhost only - zero telemetry</span></h1>",
'<section><h2>Overview</h2><div class="cards" id="cards"></div></section>',
'<section><h2>Models in use</h2><div id="models"></div></section>',
'<section><h2>Tokens per day</h2><div class="chart" id="chart-tokens"></div></section>',
'<section><h2>Cost per day</h2><div class="chart" id="chart-cost"></div></section>',
'<section><h2>Sessions per day</h2><div class="chart" id="chart-sessions"></div></section>',
'<section><h2>Provider quota windows</h2><pre id="quota">loading...</pre></section>',
'<section><h2>Electricity</h2><div class="energy" id="energy"></div></section>',
"</main>",
'<script src="/vendor/uplot.js"></script>',
"<script>",
"function fmt(n){if(n===null||n===undefined)return '-';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(n)}",
"function money(n){if(n===null||n===undefined)return 'unknown';return '$'+Number(n).toFixed(2)}",
"function tok(r){return(r.input_tokens||0)+(r.output_tokens||0)+(r.cache_read_tokens||0)+(r.cache_write_tokens||0)+(r.reasoning_tokens||0)}",
"function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}",
"function dayTs(d){return Date.parse(d+'T00:00:00Z')/1000}",
"var COLORS=['#58a6ff','#3fb950','#d29922','#f778ba','#a371f7','#76e3ea'];",
"function makeChart(el,labels,series){",
"  if(!series.length||!series[0].length){el.innerHTML='<div class=\"empty\">no data yet</div>';return}",
"  var w=Math.max(el.clientWidth-24,320);",
"  var u=new uPlot({",
"    width:w,height:260,",
"    scales:{x:{time:true}},",
"    axes:[",
"      {stroke:'#7d8590',grid:{stroke:'#21262d'},ticks:{stroke:'#2b333d'}},",
"      {stroke:'#7d8590',grid:{stroke:'#21262d'},ticks:{stroke:'#2b333d'},values:function(s,v){return v.map(fmt)}}",
"    ],",
"    series:labels.map(function(l,i){",
"      if(i===0)return{label:'day'};",
"      return{label:l,stroke:COLORS[(i-1)%COLORS.length],width:2,spanGaps:true,points:{show:false}};",
"    }),",
"    legend:{show:true},",
"    cursor:{show:true}",
"  },series,el);",
"  window.addEventListener('resize',function(){u.setSize({width:Math.max(el.clientWidth-24,320),height:260})});",
"}",
"fetch('/api/summary').then(function(r){return r.json()}).then(function(data){",
"  var t=data.totals;",
"  if(!t.events){",
"    document.getElementById('cards').innerHTML='<div class=\"empty\">ledger is empty - run <b>fleet-deck scan</b> first</div>';",
"    ['models','chart-tokens','chart-cost','chart-sessions'].forEach(function(id){document.getElementById(id).innerHTML=''});",
"  } else {",
"    var cards=[['tokens',fmt(t.totalTokens)],['cost',t.costUsd===null?'unknown':money(t.costUsd)]];",
"    if(t.listPriceEquivalentUsd!==null&&t.listPriceEquivalentUsd!==undefined)cards.push(['List-price equivalent',money(t.listPriceEquivalentUsd)]);",
"    cards.push(['sessions',fmt(t.sessions)],['events',fmt(t.events)],['models',String(t.models)],['sources',String(t.sources)]);",
"    if(t.estimatedEvents)cards.push(['estimated',fmt(t.estimatedEvents)]);",
"    if(t.partialEvents)cards.push(['partial',fmt(t.partialEvents)]);",
"    document.getElementById('cards').innerHTML=cards.map(function(c){return '<div class=\"card\"><div class=\"label\">'+c[0]+'</div><div class=\"value\">'+c[1]+'</div></div>'}).join('');",
"    var rows=data.models.map(function(m){",
"      var flags=[];",
"      if(m.any_estimated)flags.push('est');",
"      if(m.any_partial)flags.push('partial');",
"      if(m.unknown_cost_events)flags.push('cost?');",
"      var costCell='unknown';",
"      if(m.cost_usd!==null&&m.cost_usd!==undefined){costCell=money(m.cost_usd);}",
"      else if(m.list_price_equivalent_usd!==null&&m.list_price_equivalent_usd!==undefined){costCell=money(m.list_price_equivalent_usd);flags.push('list-price');}",
"      return '<tr><td>'+esc(m.model)+'</td><td>'+esc(m.provider)+'</td><td class=\"num\">'+fmt(tok(m))+'</td><td class=\"num\">'+costCell+'</td><td class=\"num\">'+m.sessions+'</td><td class=\"flag\">'+flags.join(' ')+'</td></tr>';",
"    }).join('');",
"    document.getElementById('models').innerHTML='<table><thead><tr><th>model</th><th>provider</th><th>tokens</th><th>cost</th><th>sessions</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';",
"    var days=data.days.map(function(d){return d.day});",
"    var x=days.map(dayTs);",
"    var top=data.models.slice(0,5);",
"    var labels=['day'].concat(top.map(function(m){return m.model}));",
"    var series=[x];",
"    top.forEach(function(m){",
"      var perDay={};",
"      data.dayModel.forEach(function(r){",
"        if(r.model===m.model&&r.provider===m.provider){perDay[r.day]=(perDay[r.day]||0)+tok(r)}",
"      });",
"      series.push(days.map(function(d){return perDay[d]||0}));",
"    });",
"    makeChart(document.getElementById('chart-tokens'),labels,series);",
"    var costSeries=days.map(function(d){",
"      var row=null;",
"      for(var i=0;i<data.days.length;i++){if(data.days[i].day===d){row=data.days[i];break}}",
"      return row&&row.cost_usd!==null?row.cost_usd:null;",
"    });",
"    makeChart(document.getElementById('chart-cost'),['day','usd'],[x,costSeries]);",
"    var sessSeries=days.map(function(d){",
"      var row=null;",
"      for(var i=0;i<data.days.length;i++){if(data.days[i].day===d){row=data.days[i];break}}",
"      return row?row.sessions:0;",
"    });",
"    makeChart(document.getElementById('chart-sessions'),['day','sessions'],[x,sessSeries]);",
"  }",
"  var e=data.energy;",
"  document.getElementById('energy').innerHTML='<div class=\"big\">~'+e.kwh.toFixed(3)+' kWh</div><div class=\"band\">band: '+e.low.toFixed(3)+' - '+e.high.toFixed(3)+' kWh (x5 both ways)</div><div class=\"method\">'+esc(e.method)+'</div>';",
"}).catch(function(err){",
"  document.getElementById('cards').innerHTML='<div class=\"empty\">failed to load summary: '+esc(err)+'</div>';",
"});",
"fetch('/api/quota').then(function(r){return r.json()}).then(function(q){",
"  document.getElementById('quota').textContent=q.output;",
"}).catch(function(){",
"  document.getElementById('quota').textContent='quota-axi unavailable';",
"});",
"</script>",
"</body>",
"</html>",
].join("\n");

export interface ServeOptions {
  port?: number;
  dbPath?: string;
}

export function startServer(opts: ServeOptions = {}): Promise<number> {
  const port = opts.port ?? 4173;
  const ledger = new Ledger(opts.dbPath ?? defaultDbPath());
  vendorAssets();

  let quotaCache: { at: number; body: string } | null = null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // Reject other Host headers to block DNS rebinding from web pages.
        const { port: boundPort } = server.address() as AddressInfo;
        if (req.headers.host !== `localhost:${boundPort}` && req.headers.host !== `127.0.0.1:${boundPort}`) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("forbidden host");
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");

        if (url.pathname === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(PAGE);
          return;
        }

        if (url.pathname === "/api/summary") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(buildPayload(ledger)));
          return;
        }

        if (url.pathname === "/api/quota") {
          if (!quotaCache || Date.now() - quotaCache.at > 60_000) {
            const q = await runQuotaAxi(4000);
            quotaCache = { at: Date.now(), body: JSON.stringify(q) };
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(quotaCache.body);
          return;
        }

        if (url.pathname === "/vendor/uplot.js") {
          res.writeHead(200, { "Content-Type": "text/javascript" });
          res.end(uplotJs);
          return;
        }

        if (url.pathname === "/vendor/uplot.css") {
          res.writeHead(200, { "Content-Type": "text/css" });
          res.end(uplotCss);
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("server error: " + String(err));
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}
