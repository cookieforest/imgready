"""Extract the content model from every landing page into build/pages.json.

READ ONLY. Writes one JSON file and touches nothing else.

This exists because the 68 landing pages each carry their own ~5KB inline
<style> that duplicates and overrides app.css, so a fix in the shared
stylesheet silently does nothing on any page that redeclares the rule.
Three separate alignment bugs came from that in one sitting. The way out is
to regenerate the pages from one template, which means first pulling out
everything that must survive:

    title, description, canonical, OG tags, every JSON-LD block,
    breadcrumb, H1, lede, the tool config, and the unique prose

Everything NOT extracted is, by definition, what we are deleting: the inline
styles, the hand-rolled chrome, and the filler card rows.

lxml, not regex. Counting tags in the source has already produced two wrong
answers today, because `<div` appears inside inline <style> text and inside
JSON-LD strings.

    python scripts/extract_pages.py
"""
import io
import json
import os
import sys
from lxml import html as LH

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

SKIP = {"archive", "dist", "node_modules", "fonts", "og", "samples",
        "scripts", "src", "tests", "vendor", "beta", "sdk", "build"}

# Chrome, or a block captured separately below. Either way it must not leak
# into `sections`, or the prose model fills up with tool UI and with the
# headings of the filler cards.
CHROME = {
    # rebuilt by the template
    "topnav", "site-footer", "crumbs", "app", "dropzone",
    "settings-trigger", "advanced-panel", "support-block",
    # captured as structured fields instead of prose
    "features", "feat", "faq-item", "related", "callout",
    "bottom-cta", "hero-cta",
}


def inner_html(el):
    """Serialise an element's children, not the element itself."""
    parts = [el.text or ""]
    for c in el:
        parts.append(LH.tostring(c, encoding="unicode", with_tail=True))
    return "".join(parts).strip()


def classes(el):
    return set((el.get("class") or "").split())


def is_chrome(el):
    cur = el
    while cur is not None:
        if classes(cur) & CHROME:
            return True
        cur = cur.getparent()
    return False


def strip_presentational(root):
    """Drop inline style attributes that fight the stylesheet.

    An inline style beats any rule in app.css, so a <pre> carrying
    style="background:var(--surface2)" stayed light tan while the
    stylesheet set cream text on it. Unreadable, and invisible to every
    check we have.

    `display` is kept wherever it appears, because the tool's panels use it
    to show and hide themselves. Everything else in the content region is
    presentation that app.css now owns.
    """
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        style = el.get("style")
        if not style:
            continue
        keep = [d.strip() for d in style.split(";")
                if d.strip() and d.split(":")[0].strip() == "display"]
        if keep:
            el.set("style", "; ".join(keep))
        else:
            del el.attrib["style"]


def unwrap_containers(node):
    """Descend through pass-through wrappers to the real content.

    /help/ and /developers/pricing/ were authored as <main class="wrap">
    and later had the nav moved inside, so their content sits under
    main > section.hero. Left alone that <main> gets re-emitted inside the
    template's own <main>, and the page ends up with two.
    """
    WRAPPERS = ("main", "section", "div", "article")
    for _ in range(6):
        kids = [k for k in node if isinstance(k.tag, str)]
        if len(kids) != 1:
            break
        only = kids[0]
        cl = (only.get("class") or "")
        if only.tag in WRAPPERS and (only.tag == "main" or "hero" in cl or "wrap" in cl):
            node = only
            continue
        break
    return node


def drop_header_dupes(node):
    """Remove an h1 (and its lede) from a content region.

    A page has one h1 and the template renders it in header.page-head. Any
    h1 still inside the prose is the duplicate left by a page that had no
    .hero wrapper to separate them.
    """
    for el in node.xpath(".//h1"):
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
    for el in node.xpath('.//*[contains(@class,"lede")]|.//*[contains(@class,"hero-sub")]'):
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
    # the tool is re-emitted by the template from build/parts/tool.html
    for el in node.xpath('.//*[contains(@class,"app")]'):
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)


def extract(path, slug):
    doc = LH.parse(path).getroot()
    out = {"slug": slug, "file": path}

    def meta(name=None, prop=None):
        q = ('//meta[@name="%s"]' % name) if name else ('//meta[@property="%s"]' % prop)
        n = doc.xpath(q)
        return n[0].get("content") if n else None

    t = doc.xpath("//title")
    out["title"] = t[0].text.strip() if t and t[0].text else None
    out["description"] = meta(name="description")
    can = doc.xpath('//link[@rel="canonical"]')
    out["canonical"] = can[0].get("href") if can else None
    out["og"] = {k: meta(prop="og:" + k) for k in
                 ("title", "description", "image", "type", "url")}
    out["og"] = {k: v for k, v in out["og"].items() if v}

    out["jsonld"] = []
    for s in doc.xpath('//script[@type="application/ld+json"]'):
        raw = (s.text or "").strip()
        try:
            out["jsonld"].append(json.loads(raw))
        except ValueError:
            out.setdefault("jsonld_unparsed", []).append(raw[:200])

    crumbs = doc.xpath('//*[contains(@class,"crumbs")]')
    out["breadcrumb"] = []
    if crumbs:
        for a in crumbs[0].xpath(".//a"):
            out["breadcrumb"].append({"href": a.get("href"),
                                      "text": (a.text_content() or "").strip()})
        # Verbatim, because reconstructing it went wrong: the tail was split
        # on », but 11 pages separate with ›, so the whole crumb line
        # ended up inside the current-page span as "Home › What is WebP"
        # and the rendered trail read "Home » Home › What is WebP".
        out["breadcrumb_html"] = inner_html(crumbs[0])

    h1 = doc.xpath("//h1")
    out["h1"] = inner_html(h1[0]) if h1 else None

    # Everything in the hero except the H1 and the tool, verbatim.
    #
    # Taking only .lede was not enough: some pages put a second line in
    # p.hero-sub ("No upload. No account. Works in your browser.") and
    # /developers/ and /support/ use a plain unclassed <p>. verify_pages.py
    # found the same three words missing from six pages, which is what a
    # shared block being dropped looks like.
    hero = doc.xpath('//*[contains(@class,"hero")][not(contains(@class,"hero-"))]')
    intro = []
    if hero:
        for el in hero[0]:
            if not isinstance(el.tag, str):
                continue
            if el.tag == "h1" or (classes(el) & {"app"}):
                continue
            intro.append(LH.tostring(el, encoding="unicode", with_tail=False).strip())
    out["hero_intro"] = "\n".join(intro)

    # Tool configuration, so the template can re-emit the right widget.
    inp = doc.xpath("//input[@type='file']")
    out["tool"] = {
        "present": bool(doc.xpath('//*[contains(@class,"dropzone")]')),
        "accept": inp[0].get("accept") if inp else None,
        "multiple": bool(inp and inp[0].get("multiple") is not None),
    }

    # The four-across card row, on 54 pages, 53 of them with exactly four.
    # The claims inside are real and page-specific; it is the four equal
    # boxes around them that read as filler, so keep the text as data and
    # let the template render it without cards.
    out["highlights"] = []
    # Exact class token, not a substring: contains(@class,"feat") also
    # matches "featured", so the pricing page's highlighted price card was
    # being scraped into the highlights list as a phantom entry.
    for card in doc.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," feat ")]'):
        h = card.xpath(".//h3|.//h4")
        p = card.xpath(".//p")
        if not h and not p:
            continue
        out["highlights"].append({
            "title": (h[0].text_content() or "").strip() if h else None,
            "text": (p[0].text_content() or "").strip() if p else None,
        })

    out["faqs"] = []
    for d in doc.xpath('//*[contains(@class,"faq-item")]'):
        q = d.xpath(".//summary")
        if not q:
            continue
        ans = [inner_html(x) for x in d.xpath("./p|./div|./ul|./ol")]
        out["faqs"].append({
            "q": (q[0].text_content() or "").strip(),
            "a": "\n".join(a for a in ans if a),
        })

    out["related"] = []
    for box in doc.xpath('//*[contains(@class,"related")]'):
        for a in box.xpath(".//a"):
            out["related"].append({"href": a.get("href"),
                                   "text": (a.text_content() or "").strip()})

    out["callouts"] = [inner_html(c) for c in doc.xpath('//*[contains(@class,"callout")]')]

    # The content region, VERBATIM.
    #
    # An earlier version rebuilt prose from a parsed h2/h3 model, and
    # verify_pages.py caught it dropping 256 words from /developers/, the
    # <pre> examples containing <picture> markup, content sitting before
    # the first heading, and an outbound link. Reconstructing markup is
    # the wrong job. The shell and the stylesheet are what get remade; the
    # prose is carried across untouched and CSS restyles it in place.
    #
    # TWO INPUT SHAPES, because this has to be idempotent. Running the
    # generator twice fed this function its own output, <main> matched
    # neither list below, and the entire previous render was swallowed
    # into content_html and then wrapped again. 71 pages ended up with two
    # H1s and two dropzones.
    main = doc.xpath('//div[contains(@class,"wrap")]/main')
    inner_prose = doc.xpath(
        '//section[contains(@class,"prose")]'
        '[not(.//section[contains(@class,"prose")])]')

    if main and inner_prose:
        # ALREADY GENERATED. Read from the innermost prose, which is the
        # only copy that is not itself a re-wrap of an earlier render.
        node = unwrap_containers(inner_prose[0])
        # /why/ never had a .hero, so its lede lives inside the content
        # rather than in a page-head. Rescue it before drop_header_dupes
        # removes it, or it vanishes with nothing rendering it.
        stray = node.xpath('.//*[contains(@class,"lede")]')
        if stray and not out["hero_intro"]:
            out["hero_intro"] = LH.tostring(
                stray[0], encoding="unicode", with_tail=False).strip()
        drop_header_dupes(node)
        out["content_html"] = inner_html(node)
        # and take the highlights back out of the list they were rendered
        # into, since .feat no longer exists on a generated page
        if not out["highlights"]:
            for li in doc.xpath('//ul[contains(@class,"highlights")]/li'):
                b = li.xpath("./b")
                title = (b[0].text_content() or "").strip() if b else None
                text = (li.text_content() or "").strip()
                if title and text.startswith(title):
                    text = text[len(title):].strip()
                out["highlights"].append({"title": title, "text": text or None})
        # the hero intro likewise lives in header.page-head now
        # The page-head NEAREST the real content, not the first in the
        # document. On a doubled page the outer page-head carries only the
        # h1 while the inner one carries the h1 and the lede, so reading
        # the outer one and then dropping the inner lede from the content
        # lost the lede entirely.
        heads = doc.xpath('//*[contains(@class,"page-head")]')
        head = sorted(
            heads,
            key=lambda h: len([k for k in h if isinstance(k.tag, str) and k.tag != "h1"]),
        )[-1:] if heads else []
        if head and not out["hero_intro"]:
            bits = []
            for el in head[0]:
                if not isinstance(el.tag, str) or el.tag == "h1":
                    continue
                bits.append(LH.tostring(el, encoding="unicode", with_tail=False).strip())
            out["hero_intro"] = "\n".join(bits)
    else:
        # ORIGINAL HAND-BUILT SHAPE. Inside .wrap the order is always
        #     nav, crumbs, hero (h1 + lede + tool), features, CONTENT,
        #     bottom-cta, footer
        # so the content region is everything between the hero or the
        # feature row and the trailing chrome. bottom-cta stays IN: it is
        # a real closing line plus a link, not chrome, and excluding it
        # dropped "nothing is ever uploaded" from 20 pages.
        STOP_AT = {"site-footer"}
        START_AFTER = {"hero", "features", "crumbs", "topnav", "app"}
        wrap = doc.xpath('//*[contains(@class,"wrap")]')
        region = []
        if wrap:
            started = False
            for el in wrap[0]:
                if not isinstance(el.tag, str):
                    continue
                cl = classes(el)
                if cl & STOP_AT or el.tag == "footer":
                    break
                if cl & START_AFTER or el.tag == "nav":
                    started = True
                    continue
                if not started:
                    continue
                # /why/, /about/, /privacy/ and /terms/ have no .hero
                # wrapper, so their h1 and lede sit directly in .wrap and
                # fell into the content region as well as into the header.
                # Two H1s per page, from the very first generation.
                if el.tag == "h1" or (classes(el) & {"lede", "hero-sub"}):
                    continue
                strip_presentational(el)
                region.append(LH.tostring(el, encoding="unicode", with_tail=False).strip())
        out["content_html"] = "\n".join(region)

    out["prose_chars"] = len(out["content_html"])
    out["inline_style_bytes"] = sum(
        len(s.text or "") for s in doc.xpath("//style"))
    return out


def main():
    pages = []
    if os.path.exists("index.html"):
        pages.append(("index.html", "/"))
    for name in sorted(os.listdir(".")):
        if not os.path.isdir(name) or name in SKIP or name.startswith("."):
            continue
        f = os.path.join(name, "index.html")
        if os.path.exists(f):
            pages.append((f, "/%s/" % name))
        for sub in sorted(os.listdir(name)):
            sf = os.path.join(name, sub, "index.html")
            if os.path.isdir(os.path.join(name, sub)) and os.path.exists(sf):
                pages.append((sf, "/%s/%s/" % (name, sub)))

    data, bad = [], []
    for f, slug in pages:
        try:
            data.append(extract(f, slug))
        except Exception as e:                      # noqa: BLE001
            bad.append((f, repr(e)[:120]))

    os.makedirs("build", exist_ok=True)
    io.open("build/pages.json", "w", encoding="utf-8", newline="").write(
        json.dumps(data, ensure_ascii=False, indent=1))

    print("extracted %d pages -> build/pages.json" % len(data))
    if bad:
        print("FAILED:")
        for f, e in bad:
            print("   ", f, e)

    nosec = [d["slug"] for d in data if not d["content_html"]]
    noh1 = [d["slug"] for d in data if not d["h1"]]
    print("no content region:", nosec or "none")
    print("no h1:", noh1 or "none")
    print("total prose chars:", sum(d["prose_chars"] for d in data))
    print("inline style bytes to be deleted:",
          sum(d["inline_style_bytes"] for d in data))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
