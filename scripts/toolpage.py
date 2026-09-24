"""Shared builder for standalone tool pages.

Every new tool is its own page under its own slug, the way
/pattern-generator/ is, and the main compressor on / is never touched.

The chrome (nav, footer) is lifted from a real page rather than retyped,
so a tool page cannot drift from the rest of the site, and the page
carries no inline <style> at all: styling lives in the LANDING PAGES
block of src/app.css like everything else.

    from toolpage import build
    build(slug="exif-viewer", title=..., desc=..., h1=..., lede=...,
          tool=HTML, prose=HTML, faqs=[(q, a), ...], related=[(href, label, blurb)],
          script="engine.js")
"""
import io
import json
import os
import re
from lxml import html as LH

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME_FROM = os.path.join(ROOT, "help", "index.html")


def _chrome():
    doc = LH.parse(CHROME_FROM).getroot()
    ser = lambda el: LH.tostring(el, encoding="unicode", with_tail=False).strip()
    return (ser(doc.xpath('//nav[contains(@class,"topnav")]')[0]),
            ser(doc.xpath('//footer[contains(@class,"site-footer")]')[0]))


def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def build(slug, title, desc, h1, lede, tool, prose="", faqs=(), related=(),
          script="", og_desc=None, vendor=()):
    nav, footer = _chrome()
    url = "https://imgready.app/%s/" % slug

    ld = [{
        "@context": "https://schema.org", "@type": "WebApplication",
        "name": re.sub(r"<[^>]+>", "", h1).strip(),
        "applicationCategory": "MultimediaApplication",
        "operatingSystem": "Any browser",
        "url": url,
        "description": desc,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "permissions": "No permissions required. No file upload.",
    }, {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://imgready.app/"},
            {"@type": "ListItem", "position": 2,
             "name": re.sub(r"<[^>]+>", "", h1).strip(), "item": url},
        ],
    }]
    if faqs:
        ld.append({
            "@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": q,
                            "acceptedAnswer": {"@type": "Answer",
                                               "text": re.sub(r"<[^>]+>", "", a).strip()}}
                           for q, a in faqs],
        })

    faq_html = ""
    if faqs:
        faq_html = "<h2>Common questions</h2>\n" + "\n".join(
            '<details class="faq-item"><summary>%s</summary><p>%s</p></details>'
            % (esc(q), a) for q, a in faqs)

    rel_html = ""
    if related:
        rel_html = '<h2>Related</h2>\n<div class="related">\n' + "\n".join(
            '  <a href="%s"><strong>%s</strong><small>%s</small></a>' % (h, esc(l), esc(b))
            for h, l, b in related) + "\n</div>"

    js = "".join('<script src="%s" defer></script>\n' % v for v in vendor)
    if script:
        js += "<script>\n%s\n</script>" % io.open(
            os.path.join(ROOT, "scripts", script), encoding="utf-8").read()

    page = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<link rel="preload" href="/fonts/nunito-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/poetsenone-latin.woff2" as="font" type="font/woff2" crossorigin>
<meta name="description" content="{desc}">
<meta property="og:title" content="{ogt}">
<meta property="og:description" content="{ogd}">
<meta property="og:type" content="website">
<meta property="og:url" content="{url}">
<meta property="og:site_name" content="imgready">
<link rel="canonical" href="{url}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#b84d1d">
<link rel="stylesheet" href="/app.css">
{ld}
</head>
<body>
<!-- imgready:standalone-tool -->
<div class="wrap">
  {nav}
  <div class="crumbs"><a href="/">Home</a> &raquo; <a href="/tools/">Tools</a> &raquo; <span aria-current="page">{crumb}</span></div>
  <main>
    <header class="page-head">
      <h1>{h1}</h1>
      <p class="lede">{lede}</p>
    </header>

    {tool}

    <section class="prose">
      {prose}
      {faq}
      {rel}
    </section>
  </main>
  {footer}
</div>
<script src="/app.js" defer></script>
{js}
</body>
</html>
""".format(
        title=esc(title), desc=esc(desc), url=url,
        ogt=esc(re.sub(r"<[^>]+>", "", h1).strip()),
        ogd=esc(og_desc or desc),
        ld="\n".join('<script type="application/ld+json">%s</script>'
                     % json.dumps(b, ensure_ascii=False, separators=(",", ":")) for b in ld),
        nav=nav, footer=footer,
        crumb=esc(re.sub(r"<[^>]+>", "", h1).strip()),
        h1=h1, lede=lede, tool=tool, prose=prose, faq=faq_html, rel=rel_html, js=js)

    d = os.path.join(ROOT, slug)
    os.makedirs(d, exist_ok=True)
    io.open(os.path.join(d, "index.html"), "w", encoding="utf-8", newline="").write(page)
    return len(page)


def register(slug, priority="0.7", changefreq="monthly", lastmod="2026-09-21"):
    """Add the page to sitemap.xml and llms.txt if it is not already there."""
    sm = os.path.join(ROOT, "sitemap.xml")
    s = io.open(sm, encoding="utf-8").read()
    loc = "https://imgready.app/%s/" % slug
    if loc not in s:
        anchor = "<loc>https://imgready.app/tools/</loc>"
        i = s.index(anchor)
        end = s.index("</url>", i) + len("</url>")
        blk = ('\n  <url><loc>%s</loc><lastmod>%s</lastmod>'
               '<changefreq>%s</changefreq><priority>%s</priority></url>'
               % (loc, lastmod, changefreq, priority))
        s = s[:end] + blk + s[end:]
        io.open(sm, "w", encoding="utf-8", newline="").write(s)

    lt = os.path.join(ROOT, "llms.txt")
    t = io.open(lt, encoding="utf-8").read()
    if loc not in t:
        # Match the URL, not a whole line: entries in llms.txt carry a
        # human label prefix, e.g. "- Every tool, indexed: https://...",
        # so an exact-line match silently did nothing and the page shipped
        # unlisted. The orphan check caught it.
        i = t.find("https://imgready.app/tools/")
        if i != -1:
            eol = t.index("\n", i) + 1
            t = t[:eol] + "- %s\n" % loc + t[eol:]
            io.open(lt, "w", encoding="utf-8", newline="").write(t)

    # A new page needs a permanent trailing-slash rule, or it inherits
    # Cloudflare's automatic 307. Regenerate the block from the sitemap.
    import gen_slash_redirects
    gen_slash_redirects.main()
