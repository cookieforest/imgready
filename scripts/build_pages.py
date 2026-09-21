"""Regenerate every landing page from build/pages.json and one template.

    python scripts/extract_pages.py      # read only, writes build/pages.json
    python scripts/build_pages.py        # renders to build/out/ by default
    python scripts/build_pages.py --write   # overwrites the real pages

Renders to a staging directory unless --write is passed, so the output can
be diffed before anything is overwritten.

WHY THIS EXISTS
Each landing page carried its own ~5KB inline <style>, 607KB across the
site, duplicating and overriding app.css. A fix in the shared stylesheet
silently did nothing on any page that redeclared the rule, which produced
three separate alignment bugs in one sitting. Pages are now rendered from
one template against one stylesheet, so a restyle is a one-file change.

WHAT SURVIVES, because it is the entire SEO asset:
    title, description, canonical, OG tags, every JSON-LD block verbatim,
    breadcrumb, H1, lede, all prose, FAQs, related links

WHAT GOES:
    the inline <style> blocks, the hand-rolled chrome, and the row of four
    identical cards that appeared on 54 pages
"""
import argparse
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

TOOL = io.open("build/parts/tool.html", encoding="utf-8").read().strip()

NAV = '''<nav class="topnav" aria-label="Primary">
    <a class="nav-brand" href="/">img<i class="brand-mark" aria-hidden="true"></i><span class="g">ready</span></a>
    <span class="nav-grow">
      <a class="nav-link" href="/tools/">Tools</a>
      <a class="nav-link" href="/developers/">Developers</a>
      <a class="nav-link" href="/help/">Help</a>
    </span>
  </nav>'''

FOOTER = '''<footer class="site-footer">
    <div class="footer-brand">img<i class="brand-mark" aria-hidden="true"></i><span class="g">ready</span></div>
    <div>Image tools that run in your browser. Your files never leave your device.</div>
    <div>
      <a href="/">Home</a><a href="/tools/">All tools</a><a href="/developers/">Developers</a>
      <a href="/developers/pricing/">Pricing</a><a href="/help/">Help</a><a href="/why/">Why</a>
      <a href="/about/">About</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a>
      <a href="mailto:hello@imgready.app">Contact</a><a href="/support/">Donate</a>
    </div>
    <div class="footer-row2">
      <a href="/compress/">Compress</a><a href="/resize/">Resize</a>
      <a href="/webp-converter/">WebP</a><a href="/avif-converter/">AVIF</a>
      <a href="/heic-to-jpg/">HEIC to JPG</a><a href="/webp-vs-png-vs-jpg/">WebP vs PNG vs JPG</a>
    </div>
    <div class="footer-row2">
      <a href="/privacy/#do-not-sell">Do Not Sell or Share My Personal Information</a>
    </div>
    <div class="footer-row2">&copy; 2026 imgready. All rights reserved.</div>
  </footer>'''

HEAD = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<link rel="preload" href="/fonts/nunito-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/poetsenone-latin.woff2" as="font" type="font/woff2" crossorigin>
<meta name="description" content="{description}">
{og}
<link rel="canonical" href="{canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#b84d1d">
<link rel="stylesheet" href="/app.css">
{jsonld}
</head>
<body>
'''


def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def render(p):
    og_lines = []
    for k, v in (p.get("og") or {}).items():
        og_lines.append('<meta property="og:%s" content="%s">' % (k, esc(v)))
    og_lines.append('<meta property="og:site_name" content="imgready">')

    jsonld = "\n".join(
        '<script type="application/ld+json">%s</script>'
        % json.dumps(b, ensure_ascii=False, separators=(",", ":"))
        for b in p.get("jsonld", []))

    head = HEAD.format(
        title=esc(p["title"] or "imgready"),
        description=esc(p.get("description") or ""),
        og="\n".join(og_lines),
        canonical=esc(p.get("canonical") or ""),
        jsonld=jsonld)

    # Everything lives inside .wrap. It supplies the max-width and the page
    # gutter, and every block inside it inherits that one left edge. Leaving
    # it out rendered the whole page full bleed and unstyled.
    body = [head, '<div class="wrap">', "  " + NAV]

    if p.get("breadcrumb_html"):
        body.append('  <div class="crumbs">%s</div>' % p["breadcrumb_html"])

    body.append("  <main>")
    body.append('    <header class="page-head">')
    body.append("      <h1>%s</h1>" % (p["h1"] or ""))
    if p.get("hero_intro"):
        body.append("      " + p["hero_intro"])
    body.append("    </header>")

    if p.get("tool", {}).get("present"):
        body.append("    " + TOOL)

    # The four-card row becomes a divided list. Same claims, no boxes.
    hl = [h for h in (p.get("highlights") or []) if h.get("title") or h.get("text")]
    if hl:
        body.append('    <ul class="highlights">')
        for h in hl:
            body.append("      <li><b>%s</b> %s</li>" % (esc(h.get("title") or ""),
                                                         esc(h.get("text") or "")))
        body.append("    </ul>")

    # The content region, carried across untouched. Restyling happens in
    # app.css, not by rewriting this markup: an earlier version rebuilt it
    # from a parsed model and verify_pages.py caught it dropping 256 words
    # on one page alone, plus <pre> blocks and an outbound link.
    if p.get("content_html"):
        body.append('    <section class="prose">')
        body.append(p["content_html"])
        body.append("    </section>")

    body.append("  </main>")
    body.append("  " + FOOTER)
    body.append("</div>")
    body.append('<script src="/app.js" defer></script>')
    body.append("</body>")
    body.append("</html>")
    return "\n".join(body) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true",
                    help="overwrite the real pages instead of rendering to build/out/")
    ap.add_argument("--only", help="render just this slug, e.g. /heic-to-jpg/")
    args = ap.parse_args()

    pages = json.load(io.open("build/pages.json", encoding="utf-8"))
    # The homepage and pattern-generator are hand-built and not landing pages.
    EXCLUDE = {"/", "/pattern-generator/"}
    todo = [p for p in pages if p["slug"] not in EXCLUDE]
    if args.only:
        todo = [p for p in todo if p["slug"] == args.only]
        if not todo:
            print("no such slug"); return 1

    written = 0
    for p in todo:
        out = render(p)
        dest = p["file"] if args.write else os.path.join(
            "build", "out", p["slug"].strip("/") or "index", "index.html")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        io.open(dest, "w", encoding="utf-8", newline="").write(out)
        written += 1

    where = "IN PLACE" if args.write else "build/out/"
    print("rendered %d pages -> %s" % (written, where))
    return 0


if __name__ == "__main__":
    sys.exit(main())
