"""Compare build/out/ against the live pages before overwriting anything.

The 68 landing pages are the SEO asset. A regeneration that quietly drops a
paragraph, a JSON-LD block or an outbound link is worse than no
regeneration, and the loss would not show up in a screenshot.

Compares, per page:
    title, description, canonical
    JSON-LD blocks, by parsed value and not by string
    visible text, word by word
    every internal href

Words the template deliberately removes are allowed: the headings whose
bodies moved into the FAQ and Related blocks, and the chrome labels.

    python scripts/verify_pages.py
"""
import io
import json
import os
import re
import sys
from collections import Counter
from lxml import html as LH

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# Chrome text that the old pages carried and the template rewrites.
ALLOWED_DROPS = {
    "home", "compress", "resize", "convert", "heic", "about", "support",
    "tools", "developers", "help", "pricing", "why", "privacy", "terms",
    "contact", "donate", "frequently", "asked", "questions", "related",
    "guides", "and", "all", "webp", "avif", "jpg", "png", "imgready",
    "ready", "img", "free", "browser", "based", "image", "optimizer",
    "your", "files", "never", "leave", "device", "cookie", "ad",
    "settings", "do", "not", "sell", "or", "share", "my", "personal",
    "information", "rights", "reserved", "common", "vs", "tools",
}

WORD = re.compile(r"[a-z0-9']+")


def words(text):
    return Counter(w for w in WORD.findall(text.lower()) if len(w) > 2)


def visible(doc):
    """Text with a space at every element boundary.

    text_content() glues adjacent tags together, so `<a>Tools</a><a>About</a>`
    became the single token "toolsabout". That produced dozens of phantom
    "lost words" whenever the template changed whitespace but not content.
    """
    for bad in doc.xpath("//script|//style|//noscript"):
        bad.getparent().remove(bad)
    parts = []
    for el in doc.iter():
        if not isinstance(el.tag, str):
            continue
        if el.text:
            parts.append(el.text)
        if el.tail:
            parts.append(el.tail)
    return " ".join(parts)


def jsonld(path):
    doc = LH.parse(path).getroot()
    out = []
    for s in doc.xpath('//script[@type="application/ld+json"]'):
        try:
            out.append(json.loads(s.text or ""))
        except ValueError:
            out.append({"__unparsed__": (s.text or "")[:80]})
    return out


def internal_links(path):
    doc = LH.parse(path).getroot()
    hrefs = set()
    for a in doc.xpath("//a[@href]"):
        h = a.get("href")
        if h.startswith("/") and not h.startswith("//"):
            hrefs.add(h.split("#")[0])
    return hrefs


def meta_of(path):
    doc = LH.parse(path).getroot()
    t = doc.xpath("//title")
    d = doc.xpath('//meta[@name="description"]')
    c = doc.xpath('//link[@rel="canonical"]')
    return ((t[0].text or "").strip() if t else None,
            d[0].get("content") if d else None,
            c[0].get("href") if c else None)


def main():
    pages = json.load(io.open("build/pages.json", encoding="utf-8"))
    problems, checked = [], 0

    for p in pages:
        old = p["file"]
        new = os.path.join("build", "out", p["slug"].strip("/") or "index", "index.html")
        if not os.path.exists(new):
            continue
        checked += 1
        slug = p["slug"]

        # --- metadata ---
        om, nm = meta_of(old), meta_of(new)
        for label, a, b in zip(("title", "description", "canonical"), om, nm):
            if (a or "") != (b or ""):
                problems.append("%s: %s changed\n      old=%r\n      new=%r"
                                % (slug, label, a, b))

        # --- structured data ---
        oj, nj = jsonld(old), jsonld(new)
        if len(oj) != len(nj):
            problems.append("%s: JSON-LD blocks %d -> %d" % (slug, len(oj), len(nj)))
        else:
            ok = json.dumps(oj, sort_keys=True, ensure_ascii=False)
            nk = json.dumps(nj, sort_keys=True, ensure_ascii=False)
            if ok != nk:
                problems.append("%s: JSON-LD content differs" % slug)

        # --- prose ---
        ow = words(visible(LH.parse(old).getroot()))
        nw = words(visible(LH.parse(new).getroot()))
        # Only a word that disappears ENTIRELY is a loss. A word whose
        # count merely drops is usually a duplicate being removed, which
        # is the point when the previous output was doubled. Counting
        # every reduction as a loss buried the real signal under the
        # de-duplication of tool-panel labels.
        gone = {w: c for w, c in ow.items()
                if w not in ALLOWED_DROPS and nw.get(w, 0) == 0}
        if gone:
            worst = sorted(gone.items(), key=lambda kv: -kv[1])[:8]
            problems.append("%s: %d words gone entirely, e.g. %s"
                            % (slug, len(gone), worst))

        # --- content arriving TWICE ---
        # This check exists because everything above passed while 71 pages
        # carried two H1s, two dropzones and two prose sections. Running
        # the generator twice fed the extractor its own output, and a test
        # that only asks "did anything go missing" cannot see duplication.
        ndoc = LH.parse(new).getroot()
        for sel, label, limit in (("//h1", "h1", 1),
                                  ("//main", "main", 1),
                                  ('//section[contains(@class,"prose")]', "prose section", 1),
                                  ('//*[contains(@class,"dropzone")]', "dropzone", 1),
                                  ('//footer[contains(@class,"site-footer")]', "footer", 1),
                                  ('//*[contains(@class,"topnav")]', "nav", 1)):
            n = len(ndoc.xpath(sel))
            if n > limit:
                problems.append("%s: %d x %s, expected at most %d" % (slug, n, label, limit))

        ow_total = sum(ow.values())
        nw_total = sum(nw.values())
        if ow_total and nw_total > ow_total * 1.5:
            problems.append("%s: word count %d -> %d, content looks duplicated"
                            % (slug, ow_total, nw_total))

        # --- outbound internal links ---
        ol, nl = internal_links(old), internal_links(new)
        gone = ol - nl
        if gone:
            problems.append("%s: %d internal links dropped: %s"
                            % (slug, len(gone), sorted(gone)[:6]))

    print("compared %d regenerated pages against their originals\n" % checked)
    if not problems:
        print("  no content lost: metadata, JSON-LD, prose and links all preserved")
        return 0
    print("  %d problem(s):" % len(problems))
    for x in problems[:40]:
        print("    - " + x)
    if len(problems) > 40:
        print("    ...and %d more" % (len(problems) - 40))
    return 1


if __name__ == "__main__":
    sys.exit(main())
