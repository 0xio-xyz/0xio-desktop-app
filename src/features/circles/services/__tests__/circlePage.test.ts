// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { wholeCirclePage, type PageAsset } from "src/features/circles/services/circlePage";

const ID = "octBqsZH2c1GBnBrYhUJPJHdmLuT8YMPXFpEKsPKqEYYYfi";
const at = (p: string) => `oct://${ID}${p}`;
const file = (contentType: string, body: string): PageAsset => ({
  contentType,
  bytes: new TextEncoder().encode(body),
});
const b64 = (body: string) => btoa(body);

function circle(files: Record<string, PageAsset>) {
  return vi.fn(async (id: string, path: string) => (id === ID ? (files[path] ?? null) : null));
}

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("wholeCirclePage", () => {
  it("loads a site in folders: stylesheet, scripts, logo and page links", async () => {
    const load = circle({
      "/css/style.css": file("text/css; charset=utf-8", ":root{--loaded:1}"),
      "/js/main.js": file("text/javascript; charset=utf-8", "window.ran=1"),
      "/img/logo.svg": file("image/svg+xml", "<svg/>"),
    });
    const html = await wholeCirclePage(
      [
        '<html><head><link rel="icon" href="img/logo.svg" type="image/svg+xml">',
        '<link rel="stylesheet" href="css/style.css"></head>',
        '<body><a href="how.html">How</a><img src="img/logo.svg">',
        '<script src="js/main.js" defer></script></body></html>',
      ].join(""),
      ID,
      "/index.html",
      load,
    );
    const doc = parse(html);
    expect(doc.querySelector("style")?.textContent).toBe(":root{--loaded:1}");
    expect(doc.querySelector('link[rel="stylesheet"]')).toBeNull();
    expect(doc.querySelector("script")?.getAttribute("src")).toBe(
      `data:text/javascript; charset=utf-8;base64,${b64("window.ran=1")}`,
    );
    expect(doc.querySelector("script")?.hasAttribute("defer")).toBe(true);
    expect(doc.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/svg+xml;base64,${b64("<svg/>")}`,
    );
    expect(doc.querySelector('link[rel="icon"]')?.getAttribute("href")).toMatch(/^data:image/);
    expect(doc.querySelector("a")?.getAttribute("href")).toBe(at("/how.html"));
    expect(load.mock.calls.filter((c) => c[1] === "/img/logo.svg")).toHaveLength(1);
  });

  it("resolves against the page's own folder and reads other circles by address", async () => {
    const load = vi.fn(async (_id: string, _path: string) => file("image/png", "x"));
    const html = await wholeCirclePage(
      '<img src="../up.png"><img src="/root.png"><img src="oct://other/x.png"><a href="next.html#top">n</a>',
      ID,
      "/site/docs/index.html",
      load,
    );
    expect(load.mock.calls.map((c) => `${c[0]}${c[1]}`).sort()).toEqual(
      [`${ID}/site/up.png`, `${ID}/root.png`, "other/x.png"].sort(),
    );
    expect(parse(html).querySelector("a")?.getAttribute("href")).toBe(at("/site/docs/next.html"));
  });

  it("makes a stylesheet whole: imports inlined once, url() loaded from the sheet's folder", async () => {
    const load = circle({
      "/css/site.css": file(
        "text/css",
        '@import "base.css";@import url(site.css);b{background:url(../img/t.png)}',
      ),
      "/css/base.css": file("text/css", "a{color:red}"),
      "/img/t.png": file("image/png", "png"),
    });
    const html = await wholeCirclePage(
      '<link rel="stylesheet" href="css/site.css"><div style="background:url(img/t.png)"></div>',
      ID,
      "/index.html",
      load,
    );
    const png = `url("data:image/png;base64,${b64("png")}")`;
    expect(parse(html).querySelector("style")?.textContent).toBe(
      `a{color:red}b{background:${png}}`,
    );
    expect(parse(html).querySelector("div")?.getAttribute("style")).toBe(`background:${png}`);
  });

  it("drops a script or stylesheet served as another type", async () => {
    const load = circle({
      "/a.js": file("text/html", "<p>"),
      "/a.css": file("text/plain", "x"),
    });
    const doc = parse(
      await wholeCirclePage(
        '<link rel="stylesheet" href="a.css"><script src="a.js"></script><p>kept</p>',
        ID,
        "/index.html",
        load,
      ),
    );
    expect(doc.querySelector("script,link,style")).toBeNull();
    expect(doc.querySelector("p")?.textContent).toBe("kept");
  });

  it("leaves script text, remote references, data URLs and missing files as written", async () => {
    const script = 'const src = a ? b : c;img.src = src[k];el.style.background="url(" + src + ")";';
    const load = circle({});
    const doc = parse(
      await wholeCirclePage(
        [
          `<script>${script}</script>`,
          '<link rel="stylesheet" href="https://fonts.example/f.css">',
          '<script src="//cdn.example/x.js"></script><img src="data:image/png;base64,AA==">',
          '<img id="gone" src="gone.png"><a href="https://example.org/">out</a><a href="#top">top</a>',
        ].join(""),
        ID,
        "/index.html",
        load,
      ),
    );
    expect(doc.querySelector("script")?.textContent).toBe(script);
    expect(doc.querySelector("link")?.getAttribute("href")).toBe("https://fonts.example/f.css");
    expect(doc.querySelectorAll("script")[1].getAttribute("src")).toBe("//cdn.example/x.js");
    expect(doc.querySelector("#gone")?.getAttribute("src")).toBe("gone.png");
    expect(Array.from(doc.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([
      "https://example.org/",
      "#top",
    ]);
    expect(load.mock.calls.map((c) => c[1])).toEqual(["/gone.png"]);
  });

  it("a stylesheet cannot close its own tag", async () => {
    const load = circle({ "/a.css": file("text/css", "a{}</style><script>alert(1)</script>") });
    const doc = parse(
      await wholeCirclePage('<link rel="stylesheet" href="a.css">', ID, "/index.html", load),
    );
    expect(doc.querySelector("script")).toBeNull();
  });
});
