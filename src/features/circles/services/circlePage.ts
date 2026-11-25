// Follows webcli circles.js rewritePublicAssetRefs; remote https references are left to the page policy.

import { bytesToB64 } from "src/features/circles/services/circleAsset";

export type PageAsset = { contentType: string; bytes: Uint8Array };
type LoadPageAsset = (circleId: string, path: string) => Promise<PageAsset | null>;

type Target = { circleId: string; path: string };

const KEPT = /^(?:data:|blob:|#|javascript:|mailto:|about:)/i;
const REMOTE = /^(?:https?:)?\/\//i;
const SCRIPT_TYPES = new Set([
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
]);

const mediaType = (contentType: string) => contentType.split(";")[0].trim().toLowerCase();
const dataUrl = (asset: PageAsset) =>
  `data:${asset.contentType || "application/octet-stream"};base64,${bytesToB64(asset.bytes)}`;
const text = (asset: PageAsset) => new TextDecoder().decode(asset.bytes);
const octUri = (t: Target) => `oct://${t.circleId}${t.path}`;

function targetOf(spec: string, at: Target): Target | null {
  const ref = spec.trim();
  if (!ref || KEPT.test(ref) || REMOTE.test(ref)) return null;
  const oct = /^oct:\/\/([^/?#]+)([^?#]*)/i.exec(ref);
  if (oct) return { circleId: oct[1], path: oct[2] || "/index.html" };
  try {
    const base = `https://circle.local${at.path.startsWith("/") ? at.path : `/${at.path}`}`;
    return { circleId: at.circleId, path: new URL(ref, base).pathname };
  } catch {
    return null;
  }
}

async function wholeCss(
  css: string,
  at: Target,
  load: LoadPageAsset,
  seen: ReadonlySet<string>,
): Promise<string> {
  const key = octUri(at);
  if (seen.has(key)) return "";
  const inside = new Set(seen).add(key);

  const pieces: (string | Promise<string>)[] = [];
  const pattern =
    /@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*;|url\(\s*(['"]?)([^"')]+)\2\s*\)/gi;
  let last = 0;
  for (let m = pattern.exec(css); m; m = pattern.exec(css)) {
    pieces.push(css.slice(last, m.index));
    last = m.index + m[0].length;
    const whole = m[0];
    const target = targetOf(m[1] ?? m[3], at);
    if (!target) {
      pieces.push(whole);
    } else if (m[1] !== undefined) {
      pieces.push(
        load(target.circleId, target.path).then((asset) =>
          asset && mediaType(asset.contentType) === "text/css"
            ? wholeCss(text(asset), target, load, inside)
            : "",
        ),
      );
    } else {
      pieces.push(
        load(target.circleId, target.path).then((asset) =>
          asset ? `url("${dataUrl(asset)}")` : whole,
        ),
      );
    }
  }
  pieces.push(css.slice(last));
  return (await Promise.all(pieces)).join("").replace(/<\/(style)/gi, "<\\/$1");
}

export async function wholeCirclePage(
  html: string,
  circleId: string,
  path: string,
  load: LoadPageAsset,
): Promise<string> {
  const at: Target = { circleId, path };
  const loaded = new Map<string, Promise<PageAsset | null>>();
  const once: LoadPageAsset = (id, p) => {
    const key = `${id}${p}`;
    let hit = loaded.get(key);
    if (!hit) {
      hit = load(id, p).catch(() => null);
      loaded.set(key, hit);
    }
    return hit;
  };
  const fetched = async (spec: string | null) => {
    const target = spec === null ? null : targetOf(spec, at);
    const asset = target ? await once(target.circleId, target.path) : null;
    return target && asset ? { target, asset } : null;
  };

  const doc = new DOMParser().parseFromString(html, "text/html");
  const jobs: Promise<void>[] = [];

  for (const node of Array.from(doc.querySelectorAll("style"))) {
    jobs.push(
      wholeCss(node.textContent ?? "", at, once, new Set()).then((css) => {
        node.textContent = css;
      }),
    );
  }
  for (const node of Array.from(doc.querySelectorAll("[style]"))) {
    jobs.push(
      wholeCss(node.getAttribute("style") ?? "", at, once, new Set()).then((css) =>
        node.setAttribute("style", css),
      ),
    );
  }
  for (const node of Array.from(doc.querySelectorAll("link[href]"))) {
    const sheet = (node.getAttribute("rel") ?? "").toLowerCase().includes("stylesheet");
    jobs.push(
      fetched(node.getAttribute("href")).then(async (got) => {
        if (!got) return;
        if (!sheet) return node.setAttribute("href", dataUrl(got.asset));
        if (mediaType(got.asset.contentType) !== "text/css") return node.remove();
        const style = doc.createElement("style");
        style.textContent = await wholeCss(text(got.asset), got.target, once, new Set());
        node.replaceWith(style);
      }),
    );
  }
  for (const node of Array.from(doc.querySelectorAll("[src]"))) {
    const script = node.tagName.toLowerCase() === "script";
    jobs.push(
      fetched(node.getAttribute("src")).then((got) => {
        if (!got) return;
        if (script && !SCRIPT_TYPES.has(mediaType(got.asset.contentType))) return node.remove();
        node.setAttribute("src", dataUrl(got.asset));
      }),
    );
  }
  for (const node of Array.from(doc.querySelectorAll("[poster]"))) {
    jobs.push(
      fetched(node.getAttribute("poster")).then((got) => {
        if (got) node.setAttribute("poster", dataUrl(got.asset));
      }),
    );
  }
  for (const node of Array.from(doc.querySelectorAll("a[href]"))) {
    const target = targetOf(node.getAttribute("href") ?? "", at);
    if (target) node.setAttribute("href", octUri(target));
  }

  await Promise.all(jobs);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
