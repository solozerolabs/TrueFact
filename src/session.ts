// Session-state detection + settle, as pure functions over Stagehand's Page.
// Nothing here ever sees the agent's claim. It reads the live page and reports
// what it sees. See docs/DAY2.md §3-§7.
import type { Page } from "@browserbasehq/stagehand";

export type Obstruction = "blank" | "captcha" | "login-wall" | "overlay";
export type Confidence = "high" | "heuristic";

export interface SessionEvidence {
  obstruction: Obstruction | null;
  confidence: Confidence;
  detail: string;
  checked: Obstruction[]; // detectors that ran; "clear" is not "not checked"
}

export interface Fingerprint {
  href: string;
  readyState: string;
  bodyTextLength: number;
  elementCount: number;
  title: string;
}

export interface DetectContext {
  navStatus?: number | null; // goto Response.status(), for login-wall corroboration
  point?: { x: number; y: number }; // the attempt point, for overlay
}

/** page.evaluate that returns null instead of throwing (mid-navigation, detached). */
export async function safeRead<T>(
  page: Page,
  fn: (arg: unknown) => T,
  arg?: unknown,
): Promise<T | null> {
  try {
    return (await page.evaluate(fn as never, arg as never)) as T;
  } catch {
    return null;
  }
}

async function currentUrl(page: Page): Promise<string> {
  try {
    return await page.url();
  } catch {
    return "";
  }
}

export async function fingerprint(page: Page): Promise<Fingerprint | null> {
  return safeRead(page, () => ({
    href: location.href,
    readyState: document.readyState,
    bodyTextLength: (document.body?.textContent || "").length,
    elementCount: document.getElementsByTagName("*").length,
    title: document.title,
  })) as Promise<Fingerprint | null>;
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.href === b.href &&
    a.readyState === b.readyState &&
    a.bodyTextLength === b.bodyTextLength &&
    a.elementCount === b.elementCount &&
    a.title === b.title
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Settle by fingerprinting until two consecutive reads match. Replaces
 * waitForLoadState, which resolves immediately on an already-loaded document
 * and so cannot see a navigation that has not committed yet (docs/DAY2.md §3).
 */
export async function settle(
  page: Page,
  budgetMs = 1500,
): Promise<{ settled: boolean; after: Fingerprint | null }> {
  let prev = await fingerprint(page);
  if (!prev) {
    // read threw => a navigation is in flight; wait for the new document, then read.
    try {
      await page.waitForLoadState("domcontentloaded", 3000);
    } catch {
      /* rejects on timeout; the loop below still bounds us */
    }
    prev = await fingerprint(page);
  }
  const start = Date.now();
  let stable = 0;
  while (Date.now() - start < budgetMs) {
    await sleep(100);
    const cur = await fingerprint(page);
    if (cur && prev && sameFingerprint(cur, prev)) {
      if (++stable >= 2) return { settled: true, after: cur };
    } else {
      stable = 0;
    }
    prev = cur ?? prev;
  }
  return { settled: false, after: prev };
}

const clear = (checked: Obstruction[]): SessionEvidence => ({
  obstruction: null,
  confidence: "high",
  detail: "",
  checked,
});

export async function detectSession(
  page: Page,
  ctx: DetectContext = {},
): Promise<SessionEvidence> {
  const checked: Obstruction[] = [];

  // 1. blank / never-navigated (high) --------------------------------------
  checked.push("blank");
  const url = await currentUrl(page);
  if (url === "" || url === "about:blank") {
    return { obstruction: "blank", confidence: "high", detail: "never-navigated", checked };
  }
  const emptyBody = await safeRead(
    page,
    () =>
      document.readyState === "complete" &&
      !!document.body &&
      document.body.children.length === 0 &&
      (document.body.textContent || "").trim() === "",
  );
  if (emptyBody) {
    return { obstruction: "blank", confidence: "high", detail: "empty-body", checked };
  }

  // 2. captcha / challenge (high) ------------------------------------------
  checked.push("captcha");
  const captcha = await safeRead(page, () => {
    const rx = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i;
    const iframes = Array.prototype.slice.call(document.querySelectorAll("iframe[src]"));
    const frame = iframes.find((f: HTMLIFrameElement) => rx.test(f.src));
    if (frame) return "iframe:" + (frame as HTMLIFrameElement).src.slice(0, 80);
    const title = document.title || "";
    if (title.slice(0, 13) === "Just a moment") return "cloudflare-title";
    if (document.querySelector('#challenge-running, [id^="cf-chl"]')) return "cloudflare-challenge";
    return null;
  });
  if (captcha) {
    return { obstruction: "captcha", confidence: "high", detail: captcha, checked };
  }

  // 3. login wall (heuristic; promoted to high on a 401/403 nav) -----------
  checked.push("login-wall");
  // Plain loop, no nested-function reference: a `.find(namedFn)` does not survive
  // Stagehand's function serialization the way an inline `.find(arrow)` does.
  const login = await safeRead(page, () => {
    const pws = document.querySelectorAll('input[type="password"]');
    let pw: HTMLElement | null = null;
    for (let i = 0; i < pws.length; i++) {
      const e = pws[i] as HTMLElement & { checkVisibility?: () => boolean };
      const vis =
        typeof e.checkVisibility === "function"
          ? e.checkVisibility()
          : !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
      if (vis) {
        pw = e;
        break;
      }
    }
    const form = pw ? pw.closest("form") : null;
    const hasNew = form ? form.querySelector('input[autocomplete="new-password"]') : null;
    if (pw && !hasNew) return "password-field";
    const seg = location.pathname.toLowerCase().split("/").filter(Boolean);
    const authSeg = ["login", "signin", "sign-in", "auth", "sso", "oauth"];
    for (let i = 0; i < seg.length; i++) {
      if (authSeg.indexOf(seg[i]) !== -1) return "path:" + location.pathname;
    }
    return null;
  });
  if (login) {
    const corroborated = ctx.navStatus === 401 || ctx.navStatus === 403;
    return {
      obstruction: "login-wall",
      confidence: corroborated ? "high" : "heuristic",
      detail: corroborated ? `${login}+http${ctx.navStatus}` : login,
      checked,
    };
  }

  // 4. click-intercepting overlay (heuristic) ------------------------------
  checked.push("overlay");
  const overlay = await safeRead(
    page,
    (pt) => {
      const p = pt as { x: number; y: number } | undefined;
      const x = p ? p.x : Math.floor(window.innerWidth / 2);
      const y = p ? p.y : Math.floor(window.innerHeight / 2);
      const area = window.innerWidth * window.innerHeight;
      // A declared modal counts only if it actually obstructs — it covers most
      // of the viewport, or it sits over the attempt point. A corner cookie card
      // marked aria-modal that intercepts nothing is not an obstruction.
      const modal = document.querySelector('dialog[open], [aria-modal="true"]');
      if (modal) {
        const r = modal.getBoundingClientRect();
        const covers = r.width * r.height >= 0.8 * area;
        const overPoint = modal.contains(document.elementFromPoint(x, y));
        if (covers || overPoint) return "modal:" + modal.tagName.toLowerCase();
      }
      let el: Element | null = document.elementFromPoint(x, y);
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if ((cs.position === "fixed" || cs.position === "sticky") && cs.pointerEvents !== "none") {
          const r = el.getBoundingClientRect();
          if (r.width * r.height >= 0.8 * area) {
            return "overlay:" + (el.id || (el as HTMLElement).className || el.tagName);
          }
        }
        el = el.parentElement;
      }
      return null;
    },
    ctx.point,
  );
  if (overlay) {
    return { obstruction: "overlay", confidence: "heuristic", detail: overlay, checked };
  }

  return clear(checked);
}
