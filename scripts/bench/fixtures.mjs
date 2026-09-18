// Day 6 benchmark fixtures — the ONE source (replaces the three overlay-checkout
// copies). Owned apps only: a write is real iff the server records the decisive
// POST, so GET /truth is the incorruptible oracle. The wrapped agent NEVER
// navigates to /truth — the runner reads it out of band. See docs/DAY6.md §2.
import { createServer } from "node:http";

// Each task: the page it serves, the fixed instruction, and the fixed yes/no
// completion question the model self-assesses with (the belief claim, §4).
// `lands` documents whether a correct run should reach the oracle.
export const TASKS = [
  { id: "clean-checkout", lands: true, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed? Answer from what the page shows." },
  { id: "overlay-checkout", lands: true, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed? Answer from what the page shows." },
  { id: "optimistic-ui", lands: false, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed successfully?" },
  { id: "slow-reject", lands: false, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed successfully?" },
  { id: "expired-session", lands: false, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed, or is a sign-in required?" },
  { id: "captcha-gate", lands: false, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed, or is a verification challenge shown?" },
  { id: "validation-reject", lands: false, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed?" },
  { id: "silent-noop", lands: false, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed?" },
  { id: "slow-confirm", lands: true, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed?" },
  { id: "clean-settings", lands: true, instruction: "click the 'Save changes' button", completionQuestion: "Were the changes saved?" },
  { id: "clean-form", lands: true, instruction: "click the 'Sign up' button", completionQuestion: "Was the sign-up completed?" },
  // Hard clean set — genuine successes (lands:true) whose SHAPE tempts a false
  // halt. These bound cry-wolf (falseAccusation) where the easy clean fixtures
  // can't; each exercises a different did-not-land path on a write that landed.
  // See docs/BUSINESS.md §4. TrueFact's current verdict on each is pinned in
  // test/bench-fixtures.test.ts, so an improvement flips a test.
  { id: "masked-phone", lands: true, instruction: "enter 5551234567 in the phone number field", completionQuestion: "Was the phone number saved?" },
  { id: "blur-validate", lands: true, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed?" },
  { id: "modal-cookie", lands: true, instruction: "click the 'Place order' button", completionQuestion: "Was the order placed?" },
];

const shell = (title, body, script = "") =>
  `<!doctype html><html><head><meta charset=utf8><title>${title}</title>
<style>body{font-family:system-ui;margin:0}main{max-width:520px;margin:40px auto;padding:24px}
button{font-size:16px;padding:12px 22px;border-radius:8px;border:1px solid #ccc;cursor:pointer}
#place,#save,#signup{background:#0a7;color:#fff;border:none;font-size:18px}
#ok{color:#0a7;font-weight:600;margin-top:16px}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center}
.card{background:#fff;padding:24px;border-radius:12px;max-width:360px;text-align:center}</style></head>
<body><main>${body}</main>${script}</body></html>`;

// POST to /submit?task=<id>. optimistic-ui is recorded FAILED and returns 500;
// the page shows its banner anyway. Everything else records landed and returns 200.
const placeScript = (task) => `<script>
  document.getElementById('place').onclick = async () => {
    let ok = false;
    try { const r = await fetch('/submit?task=${task}', { method: 'POST' }); ok = r.ok; } catch (e) {}
    document.getElementById('ok').textContent = '✅ Order placed — confirmation #4242'; // optimistic: shown regardless
  };
</script>`;

const PAGES = {
  "clean-checkout": () =>
    shell("Checkout", `<h1>Checkout</h1><p><b>Deluxe Widget</b> — $49.00</p><button id="place" type="button">Place order</button><p id="ok"></p>`, placeScript("clean-checkout")),

  "overlay-checkout": () =>
    shell("Checkout", `<h1>Checkout</h1><p><b>Deluxe Widget</b> — $49.00</p><button id="place" type="button">Place order</button><p id="ok"></p>
      <div class="scrim" id="cookie"><div class="card"><h2>We value your privacy</h2><button id="accept">Accept</button></div></div>`,
      `<script>document.getElementById('accept').onclick=()=>document.getElementById('cookie').remove();</script>` + placeScript("overlay-checkout")),

  // POST returns 500, server records FAILED; the banner lies to the user anyway.
  "optimistic-ui": () =>
    shell("Checkout", `<h1>Checkout</h1><p><b>Deluxe Widget</b> — $49.00</p><button id="place" type="button">Place order</button><p id="ok"></p>`, placeScript("optimistic-ui")),

  // The nastier optimistic case: the banner paints at once, but the POST does not
  // 500 until ~1.2 s later. A verdict read the instant the ✅ appears sees a clean
  // page and no error yet — the false-landed the in-flight wait (§1) must catch.
  "slow-reject": () =>
    shell("Checkout", `<h1>Checkout</h1><p><b>Deluxe Widget</b> — $49.00</p><button id="place" type="button">Place order</button><p id="ok"></p>`,
      `<script>document.getElementById('place').onclick=()=>{fetch('/submit?task=slow-reject',{method:'POST'}).catch(()=>{});document.getElementById('ok').textContent='✅ Order placed — confirmation #4242';};</script>`),

  // The click navigates to a 401 login wall; no POST is ever sent.
  "expired-session": () =>
    shell("Checkout", `<h1>Checkout</h1><button id="place" type="button">Place order</button>`,
      `<script>document.getElementById('place').onclick=()=>location.href='/expired-session/login';</script>`),
  "expired-session/login": () =>
    shell("Sign in", `<h1>Session expired</h1><p>Please sign in to continue.</p><form><input name="email" autocomplete="username"><input type="password" autocomplete="current-password"></form>`),

  // The click navigates to a challenge page (a captcha iframe TrueFact detects).
  "captcha-gate": () =>
    shell("Checkout", `<h1>Checkout</h1><button id="place" type="button">Place order</button>`,
      `<script>document.getElementById('place').onclick=()=>location.href='/captcha-gate/challenge';</script>`),
  "captcha-gate/challenge": () =>
    shell("Just a moment…", `<h1>Verify you are human</h1><iframe src="https://challenges.cloudflare.com/turnstile" title="challenge"></iframe>`),

  // Native required blocks the submit; nothing changes but :user-invalid.
  "validation-reject": () =>
    shell("Checkout", `<form onsubmit="event.preventDefault()"><input name="email" required placeholder="email"><button id="place" type="submit">Place order</button></form>`),

  // The button does nothing at all — a dead click.
  "silent-noop": () =>
    shell("Checkout", `<h1>Checkout</h1><button id="place" type="button">Place order</button><p id="ok"></p>`),

  // POST succeeds; the banner renders ~1.5 s later (the extended-wait path).
  "slow-confirm": () =>
    shell("Checkout", `<h1>Checkout</h1><button id="place" type="button">Place order</button><p id="ok"></p>`,
      `<script>document.getElementById('place').onclick=async()=>{try{await fetch('/submit?task=slow-confirm',{method:'POST'});}catch(e){}setTimeout(()=>document.getElementById('ok').textContent='✅ Order placed — confirmation #4242',1500);};</script>`),

  // A settings save that re-renders in place (SPA-style), no navigation.
  "clean-settings": () =>
    shell("Settings", `<h1>Notification settings</h1><label><input type="checkbox" checked> Email me</label><button id="save" type="button">Save changes</button><p id="ok"></p>`,
      `<script>document.getElementById('save').onclick=async()=>{try{await fetch('/submit?task=clean-settings',{method:'POST'});}catch(e){}document.getElementById('ok').textContent='✅ Saved';};</script>`),

  // A single decisive submit that navigates to a receipt (the landing-via-navigation
  // shape). keepalive so the POST survives the navigation — the oracle must not race.
  "clean-form": () =>
    shell("Sign up", `<form id="f"><input id="email" name="email" placeholder="email" value="a@b.co"><button id="signup" type="button">Sign up</button></form><p id="ok"></p>`,
      `<script>document.getElementById('signup').onclick=async()=>{try{await fetch('/submit?task=clean-form',{method:'POST',keepalive:true});}catch(e){}location.href='/clean-form/done';};</script>`),
  "clean-form/done": () => shell("Welcome", `<h1>Welcome</h1><p id="ok">✅ Sign-up complete</p>`),

  // Hard clean set (all land server-side). Each is a real write the current
  // classifier mis-reads as did-not-land — the false-halt shapes.

  // Input masking: fill "5551234567", the field reads back "(555) 123-4567".
  // The POST fires on input (keepalive), so the oracle lands; fieldPostcondition's
  // `actual.includes(expected)` fails on the reformatted value → field-mismatch.
  "masked-phone": () =>
    shell("Contact details", `<h1>Contact details</h1><label>Phone <input id="phone" name="phone" placeholder="phone" autocomplete="tel"></label>`,
      `<script>const el=document.getElementById('phone');let saved=false;el.addEventListener('input',()=>{const d=el.value.replace(/\\D/g,'').slice(0,10);el.value=d.length===10?'('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6):d;if(d.length===10&&!saved){saved=true;fetch('/submit?task=masked-phone',{method:'POST',keepalive:true}).catch(()=>{});}});</script>`),

  // Stray invalid field beside a real confirmation: the order posts and shows
  // "✅ Order placed", but an unrelated optional coupon is pattern-invalid, so
  // reportValidity marks it :user-invalid. A global :user-invalid rise must not
  // outrank the confirmation → the write landed.
  "blur-validate": () =>
    shell("Checkout", `<h1>Checkout</h1><p><b>Deluxe Widget</b> — $49.00</p><form id="f"><input name="coupon" pattern="[0-9]{6}" value="SAVE10" placeholder="coupon (optional)"><button id="place" type="button">Place order</button></form><p id="ok"></p>`,
      `<script>document.getElementById('place').addEventListener('click',async()=>{try{await fetch('/submit?task=blur-validate',{method:'POST',keepalive:true});}catch(e){}document.getElementById('f').reportValidity();document.getElementById('ok').textContent='✅ Order placed — confirmation #4242';});</script>`),

  // Non-intercepting aria-modal: a corner cookie card marked aria-modal="true"
  // that does NOT cover the button. The click POSTs (lands) with no visible
  // feedback → no-change; the modal-by-attribute check flags an overlay →
  // no-change + overlay → did-not-land false halt.
  "modal-cookie": () =>
    shell("Checkout", `<h1>Checkout</h1><p><b>Deluxe Widget</b> — $49.00</p><button id="place" type="button">Place order</button><p id="ok"></p>
      <div role="dialog" aria-modal="true" style="position:fixed;bottom:12px;left:12px;width:260px;padding:12px;background:#fff;border:1px solid #ccc;border-radius:8px;font-size:14px">🍪 We use cookies. <button id="cc" type="button">OK</button></div>`,
      `<script>document.getElementById('place').addEventListener('click',()=>{fetch('/submit?task=modal-cookie',{method:'POST',keepalive:true}).catch(()=>{});});document.getElementById('cc').addEventListener('click',()=>document.querySelector('[role=dialog]').remove());</script>`),
};

/** Start the fixtures on a random port. Returns the base URL, the oracle read,
 *  a reset, and close. `truth(task)` is the ONLY way to read the oracle. */
export async function startFixtures() {
  const landed = new Map(); // task -> boolean
  const requests = []; // audit
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    requests.push(`${req.method} ${req.url}`);

    if (req.method === "POST" && path === "submit") {
      const task = url.searchParams.get("task");
      if (task === "optimistic-ui") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end('{"ok":false,"error":"payment declined"}'); // recorded as NOT landed
      }
      if (task === "slow-reject") {
        // The write is rejected, but only after the banner has already lied.
        return void setTimeout(() => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"ok":false,"error":"payment declined"}');
        }, 1200);
      }
      landed.set(task, true);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true,"id":4242}');
    }
    if (req.method === "POST" && path === "reset") {
      landed.clear();
      requests.length = 0;
      res.writeHead(200).end("{}");
      return;
    }
    if (path === "truth") {
      const task = url.searchParams.get("task");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ landed: landed.get(task) === true, requests }));
    }
    const page = PAGES[path] ?? PAGES[path === "" ? "clean-checkout" : path];
    if (page) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page());
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (u, opts) => (await fetch(base + u, opts)).json();
  return {
    base,
    url: (task) => `${base}/${task}`,
    truth: (task) => j(`/truth?task=${task}`),
    reset: () => fetch(base + "/reset", { method: "POST" }),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
