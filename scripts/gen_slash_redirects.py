"""Write a permanent trailing-slash redirect for every sitemapped page.

Cloudflare's automatic trailing-slash handling answers /compress-jpg with a
307, which is a TEMPORARY redirect. Google treats 301 and 308 as a strong
signal that the target is the canonical URL and 302/307 as a weak one, so
through a 307 the slash-less form stays a live candidate in its own right.
Search Console showed exactly that: /png-to-webp and /png-to-webp/ both
sitting in "Crawled, currently not indexed", as are /tiff-to-webp and
/tiff-to-webp/, and /jpg-to-png alongside the rest.

Explicit rules in _redirects are honoured ahead of the automatic handling
and return whatever status they declare (verified: /png-to-jpeg and
/privacy.html both answer 301). So one 301 per page, generated from
sitemap.xml, between markers, rewritten in place on every run.

    python scripts/gen_slash_redirects.py

scripts/toolpage.py calls this from register(), so a new tool page gets its
rule without anyone remembering to add it.
"""
import io
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
START = "# ---- BEGIN generated: permanent trailing-slash redirects ----"
END = "# ---- END generated: permanent trailing-slash redirects ----"


def main():
    sm = io.open(os.path.join(ROOT, "sitemap.xml"), encoding="utf-8").read()
    paths = sorted({m for m in re.findall(r"<loc>https://imgready\.app(/[^<]*)</loc>", sm)
                    if m != "/" and m.endswith("/")})

    rf = os.path.join(ROOT, "_redirects")
    text = io.open(rf, encoding="utf-8").read()

    # Rules someone wrote by hand win: never emit a second rule for a source
    # that already has one above the generated block.
    manual = text.split(START)[0] if START in text else text
    taken = {ln.split()[0] for ln in manual.splitlines()
             if ln.strip() and not ln.lstrip().startswith("#")}

    lines = [START,
             "# One 301 per sitemapped page, from scripts/gen_slash_redirects.py.",
             "# Replaces Cloudflare's automatic 307. Do not edit by hand.",
             ""]
    n = 0
    for p in paths:
        src = p.rstrip("/")
        if src in taken:
            continue
        lines.append("%-40s %-42s 301" % (src, p))
        n += 1
    lines.append(END)
    block = "\n".join(lines)

    if START in text:
        pre = text.split(START)[0].rstrip("\n")
        post = text.split(END, 1)[1] if END in text else ""
        text = pre + "\n\n" + block + post
    else:
        text = text.rstrip("\n") + "\n\n" + block + "\n"
    io.open(rf, "w", encoding="utf-8", newline="").write(text)
    return n


if __name__ == "__main__":
    print("wrote %d permanent trailing-slash rules into _redirects" % main())
