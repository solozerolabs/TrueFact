// M4 — the timeline viewer. One self-contained static HTML file with the run's
// steps inlined: no server, no accounts, no build step, opens from file://.
// Left: the steps, each with its verdict. Right: why — reason, the a11y tree
// diff (what appeared / disappeared), the network errors, the screenshot if
// one was taken, and — clearly separated as the untrusted channel — what the
// agent claimed. Deliberately a page, not a product (SPEC-V2 §6).
import { readFileSync, writeFileSync } from "node:fs";
import type { Step } from "./index.js";

const PAGE = (dataJson: string, title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --add:#166534; --addbg:#f0fdf4; --rem:#991b1b; --rembg:#fef2f2;
          --landed:#16a34a; --dnl:#dc2626; --inc:#d97706; --claim:#6b7280; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#0f1115; --fg:#e5e7eb; --muted:#9ca3af; --line:#1f2937; --addbg:#0b2a17; --add:#4ade80; --rembg:#2a0f12; --rem:#f87171; --claim:#9ca3af; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:12px 16px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:baseline; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .meta { color:var(--muted); font-size:12px; }
  .wrap { display:grid; grid-template-columns:minmax(280px,38%) 1fr; height:calc(100vh - 49px); }
  @media (max-width:720px){ .wrap{ grid-template-columns:1fr; height:auto; } .detail{ border-left:none; border-top:1px solid var(--line);} }
  .list { overflow:auto; border-right:1px solid var(--line); }
  .detail { overflow:auto; padding:16px; }
  .step { padding:10px 16px; border-bottom:1px solid var(--line); cursor:pointer; display:flex; gap:10px; align-items:flex-start; }
  .step:hover { background:rgba(127,127,127,.06); }
  .step.sel { background:rgba(127,127,127,.12); }
  .idx { color:var(--muted); font-variant-numeric:tabular-nums; min-width:1.6em; text-align:right; }
  .step .a { flex:1; word-break:break-word; }
  .step .k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .badge { font-size:11px; font-weight:600; padding:1px 7px; border-radius:999px; white-space:nowrap; color:#fff; }
  .landed{ background:var(--landed);} .did-not-land{ background:var(--dnl);} .inconclusive{ background:var(--inc);} .read,.nav{ background:var(--muted);}
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:20px 0 6px; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 12px; font-size:13px; }
  .kv div:nth-child(odd){ color:var(--muted); }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; word-break:break-all; }
  .diff div { padding:1px 6px; border-radius:4px; margin:2px 0; font-family:ui-monospace,monospace; font-size:12px; }
  .diff .add{ color:var(--add); background:var(--addbg);} .diff .add::before{ content:"+ "; }
  .diff .rem{ color:var(--rem); background:var(--rembg);} .diff .rem::before{ content:"− "; }
  .neterr { color:var(--rem); font-family:ui-monospace,monospace; font-size:12px; }
  .claim { border:1px dashed var(--line); border-radius:8px; padding:8px 12px; color:var(--claim); font-size:13px; }
  .claim .tag{ font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  img.shot { max-width:100%; border:1px solid var(--line); border-radius:8px; margin-top:6px; }
  .empty { color:var(--muted); }
</style></head>
<body>
<header><h1>TrueFact</h1><span class="meta" id="meta"></span></header>
<div class="wrap"><div class="list" id="list"></div><div class="detail" id="detail"><p class="empty">Select a step.</p></div></div>
<script>window.__STEPS__=${dataJson};</script>
<script>
const steps = window.__STEPS__ || [];
const $ = (s)=>document.querySelector(s);
const esc = (s)=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const writes = steps.filter(s=>s.kind==="write");
const rolled = writes.some(s=>s.verdict==="did-not-land")?"did-not-land":writes.some(s=>s.verdict==="inconclusive")?"inconclusive":writes.length?"landed":"—";
$("#meta").textContent = steps.length+" steps · "+writes.length+" writes · run verdict: "+rolled;

function row(s,i){
  const v = s.kind==="write" ? s.verdict : s.kind;
  return '<div class="step" data-i="'+i+'"><span class="idx">'+i+'</span>'+
    '<div class="a"><div class="k">'+esc(s.kind)+'</div>'+esc(s.action)+'</div>'+
    '<span class="badge '+esc(v)+'">'+esc(v)+'</span></div>';
}
$("#list").innerHTML = steps.map(row).join("");

function detail(s){
  const rec = s.evidence&&s.evidence.record;
  const p = (s.evidence&&s.evidence.postcondition)||rec||{};
  const after = (s.evidence&&s.evidence.after)||{};
  const net = (p.network&&p.network.errors)||[];
  const parts = [];
  parts.push('<div class="kv">'+
    '<div>verdict</div><div><span class="badge '+esc(s.kind==="write"?s.verdict:s.kind)+'">'+esc(s.kind==="write"?s.verdict:s.kind)+'</span></div>'+
    (p.reason?'<div>reason</div><div>'+esc(p.reason)+(p.confidence?' · '+esc(p.confidence):'')+'</div>':'')+
    (after.href?'<div>url</div><div class="mono">'+esc(after.href)+'</div>':'')+
    (s.hash?'<div>hash</div><div class="mono">'+esc(s.hash.slice(0,16))+'…</div>':'')+
    (s.timestamp?'<div>time</div><div class="mono">'+esc(s.timestamp)+'</div>':'')+
  '</div>');
  const added=(p.treeAdded||[]), removed=(p.treeRemoved||[]);
  if(added.length||removed.length){ parts.push('<h2>page changed</h2><div class="diff">'+
    added.map(l=>'<div class="add">'+esc(l)+'</div>').join('')+removed.map(l=>'<div class="rem">'+esc(l)+'</div>').join('')+'</div>'); }
  if(rec){
    const at=(v,path)=>path==="(root)"?v:path.replaceAll("[",".").replaceAll("]","").split(".").filter(Boolean).reduce((o,k)=>o==null?undefined:o[k],v);
    const show=(v)=>v===undefined?"—":JSON.stringify(v);
    parts.push('<h2>record read-back</h2><div class="diff">'+
      (rec.changed.length?rec.changed.map(c=>'<div class="rem">'+esc(c)+': '+esc(show(at(rec.before,c)))+'</div><div class="add">'+esc(c)+': '+esc(show(at(rec.after,c)))+'</div>').join(''):'<div>no change</div>')+'</div>'+
      (s.declaration&&s.declaration.expect!==undefined?(()=>{ const e=s.declaration.expect;
        const rows=e&&typeof e==="object"&&!Array.isArray(e)?Object.keys(e).map(k=>[k,e[k],rec.after==null?undefined:rec.after[k]]):[["(record)",e,rec.after]];
        return '<h2>expect'+(rec.met===true?' · met':rec.met===false?' · not met':'')+'</h2><div class="kv">'+rows.map(([k,want,got])=>'<div>'+esc(k)+'</div><div class="mono">expected '+esc(show(want))+' · got '+esc(show(got))+'</div>').join('')+'</div>'; })():'')+
      (s.declaration==="auto"&&!rec.afterError?'<p class="empty">No <code>expect</code> declared, so a change alone can\\'t decide this write. Declare the fields that prove it.</p>':'')+
      (rec.beforeError||rec.afterError?'<div class="neterr">read failed: '+esc(rec.afterError||rec.beforeError)+'</div>':''));
  }
  if(net.length){ parts.push('<h2>network</h2>'+net.map(n=>'<div class="neterr">'+esc(n.url)+' → '+esc(n.status==null?'failed':'HTTP '+n.status)+'</div>').join('')); }
  if(p.field){ parts.push('<h2>field</h2><div class="kv"><div>'+esc(p.field.selector)+'</div><div class="mono">expected '+esc(p.field.expected)+' · got '+esc(p.field.actual)+'</div></div>'); }
  if(s.evidence&&s.evidence.screenshot){ parts.push('<h2>screenshot</h2><img class="shot" src="'+esc(s.evidence.screenshot)+'" alt="step screenshot" onerror="this.replaceWith(Object.assign(document.createElement(\\'p\\'),{className:\\'empty\\',textContent:\\'screenshot not found at \\'+this.getAttribute(\\'src\\')}))">'); }
  if(s.agent_claim){ parts.push('<h2>the agent\\'s claim (untrusted — recorded, never used for the verdict)</h2>'+
    '<div class="claim"><span class="tag">agent said</span> success='+esc(!!s.agent_claim.success)+(s.agent_claim.message?' · '+esc(s.agent_claim.message):'')+'</div>'); }
  return parts.join("");
}
function select(i){
  document.querySelectorAll(".step").forEach(e=>e.classList.toggle("sel", +e.dataset.i===i));
  $("#detail").innerHTML = detail(steps[i]);
}
$("#list").addEventListener("click", e=>{ const el=e.target.closest(".step"); if(el) select(+el.dataset.i); });
// Open on the first write that didn't land, else the first step — the thing worth looking at.
const firstProblem = steps.findIndex(s=>s.kind==="write"&&s.verdict!=="landed");
if(steps.length) select(firstProblem>=0?firstProblem:0);
</script>
</body></html>`;

/** Render a standalone HTML timeline for a set of recorded steps. Pure. */
export function renderHtml(steps: Step[], title = "TrueFact"): string {
  // Neutralize any "</script>" (and "<") in the data so it can't break out of
  // the inline <script> that carries it.
  const data = JSON.stringify(steps).replace(/</g, "\\u003c");
  return PAGE(data, title);
}

/** Read a run's jsonl, write `<path>.html` beside it, and return the html path. */
export function viewFile(jsonlPath: string): string {
  const steps = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Step);
  const out = jsonlPath.replace(/\.jsonl$/i, "") + ".html";
  writeFileSync(out, renderHtml(steps));
  return out;
}
