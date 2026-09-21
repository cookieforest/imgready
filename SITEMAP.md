# imgready information architecture

69 URLs in `sitemap.xml` today. This places every one of them, names the gaps,
and fixes two structural problems that are currently costing us.

## The four jobs

Every page does exactly one of these. If a page does two, it is doing neither.

1. **Use the tool.** `/` is the tool. Nothing else needs to be.
2. **Arrive from search.** ~60 pages, each targeting one query. These are
   entry doors, not destinations. Nobody navigates *to* them.
3. **Decide to pay.** Developers evaluating the SDK.
4. **Trust us, or get unstuck.** Privacy, terms, help.

## The two structural problems

**`/support/` is a tip jar wearing a help page's name.** Its H1 is "imgready is
free" and its job is donations, but it sits in the header as the primary CTA.
A user whose HEIC failed clicks the most prominent thing in the nav and gets
asked for money. That is the worst possible moment to ask, and it means we have
no help page at all.

**`/about/` and `/why/` are near-duplicates.** Both carry why-it-exists,
who-it-is-for and free-and-why. Two pages competing for the same intent split
their own signal.

## Tree

```
/                                 the tool
│
├── /tools/                       directory of every tool  [hub]
│   ├── convert  (31)             {avif,bmp,gif,heic,ico,jfif,jpg,png,
│   │                              svg,tiff,webp}-to-{...}
│   ├── convert hubs (3)          /avif-converter/ /webp-converter/
│   │                             /batch-image-converter/
│   ├── compress (4)              /compress/ /compress-jpg/ /compress-png/
│   │                             /compress-webp/
│   ├── compress to size (6)      /compress-image-to-{20,50,100,200,500}kb/
│   │                             /compress-image-to-1mb/
│   ├── resize (4)                /resize/ /resize-image-to-1080x1080/
│   │                             /resize-image-to-1920x1080/
│   │                             /resize-image-for-instagram/
│   └── other (1)                 /pattern-generator/
│
├── /guides/                      NEW hub, currently orphaned content  [hub]
│   ├── explainers (4)            /what-is-{avif,heic,tiff,webp}/
│   ├── comparisons (4)           /jpg-vs-png/ /avif-vs-webp/ /tiff-vs-jpg/
│   │                             /webp-vs-png-vs-jpg/
│   └── how-to (5)                /optimize-images-for-web/
│                                 /compress-images-for-{email,wordpress}/
│                                 /social-media-image-sizes/
│                                 /youtube-thumbnail-size/
│
├── /developers/                  technical only: install, API, formats,
│   │                             browser support, limits
│   ├── /pricing/                 NEW, canonical for every price claim
│   └── /changelog/               NEW, makes "12 months of updates" real
│
├── /why/                         the privacy argument. Keep, it is the
│                                 opinionated one
├── /about/                       REWRITE to who-built-this only
├── /help/                        NEW, real help
├── /donate/                      RENAMED from /support/
├── /privacy/
└── /terms/
```

### New pages (5)

| Page | Why it has to exist |
| --- | --- |
| `/developers/pricing/` | Licence terms need room: what counts as one product, per-seat or per-company, what lapses when updates end, refunds, VAT. Those answers close sales and there is nowhere on a homepage to put them. Also the only clean buying signal in analytics. |
| `/developers/changelog/` | We sell "12 months of updates". A buyer will look for evidence that updates happen. No changelog means the promise is unverifiable. |
| `/guides/` | 13 explainer and how-to pages currently have no index. They are the pages most likely to earn links, and nothing collects them. |
| `/help/` | The tool has real failure modes: HEIC outside Safari, very large files, video frame extraction. There is no page for "it did not work". |
| `/donate/` | `/support/` renamed so the word means one thing. |

### Redirects

```
/support/   ->  /donate/      301
```

`/about/` keeps its URL. Do **not** redirect it to `/why/`: a genuine about
page is a trust signal Google reads, and the URL is indexed. Instead strip the
duplicated why-and-free material out of it and leave it as who-built-this,
what-it-is, how-to-reach-us.

## Header

Today: `Compress · Resize · Convert · HEIC to JPG` + `Developers` + `♥ Support`.

Four of those six link to pages that do the same thing as the page you are
already on. From the homepage, "Compress" leads to another drop zone. They are
in the header for the crawler, and the footer already carries 24 links, so they
are not even earning that.

```
imgready                          Tools    Developers    Help
```

Three links, one job each, none redundant with the tool on the page:

- **Tools** to `/tools/`, the whole directory, for someone who wants a
  different one
- **Developers** to `/developers/`, pricing one click further in
- **Help** to `/help/`, for someone stuck

**No header button.** The call to action is the drop zone. A tool page should
not have a second button competing with the thing it wants you to use.

**The tip jar leaves the header.** It goes to the footer, and to the moment
after a file has finished compressing, where there is something to be grateful
for. Asking before delivering is why it converts badly now.

Pricing is deliberately *not* in the header. The tool is free and always will
be; a consumer seeing "Pricing" wonders what it is going to cost them.
Developers find it from the SDK section and from `/developers/`.

## Footer

Keep as the link hub, 24 links is fine. Two changes: `♥ Support` becomes
`Donate`, and add `Guides` and `Pricing`.

## Pricing

### What the research says

| Product | Price | Shape |
| --- | --- | --- |
| Pintura (closest comparable, client-side JS image SDK) | EUR 169/yr one product, EUR 749/yr per seat unlimited | subscription, perpetual fallback |
| Cloudinary Plus | $89/mo | server-side SaaS |
| ImageKit Pro | $89/mo | server-side SaaS |
| Uploadcare Pro | $66/mo | server-side SaaS |
| browser-image-compression | free, MIT | **no HEIC support** |
| @jsquash | free, MIT | codecs only, assembly is yours |

Two things follow. The free libraries stop exactly where the pain starts:
HEIC, the format every iPhone produces, which no browser outside Safari
decodes. And the paid alternative to doing this client-side is $66 to $89 a
month, forever.

### Decision

| Tier | Price | Covers |
| --- | --- | --- |
| Free | $0 | Personal, open source, non-commercial. Attribution badge stays. |
| Commercial | **$149** once | One product. Badge off. Perpetual, 12 months of updates. |
| Unlimited | **$449** once | Every product you ship, client work included. Same terms. |
| Enterprise | talk to us | Indemnity, invoicing, custom terms. |

Continued updates after 12 months: $59 and $179. Optional; the version you
bought keeps working forever.

### Why, and why not $9/$29/$99

- **$9 is below the decision threshold.** Nobody raises a purchase order for
  $9. It costs more in support email than it earns, and it tells a buyer this
  is a hobby project.
- **One-time, not subscription.** Recurring revenue is better in theory, but
  running subscriptions means billing, dunning and renewal mail. The existing
  mint tool charges once. Perpetual-plus-12-months is the JetBrains shape and
  it operates with one-time charges only.
- **$149 undercuts the comparable and pays back fast.** Pintura asks EUR 169
  *every year* for one product. Against server-side image handling at $66 to
  $89 a month, a one-time $149 pays for itself inside two months.
- **3x gaps** between tiers, which is a legible ladder.
- **Lead the pitch with HEIC, not compression.** "Compress an image in the
  browser" is now a short prompt against free MIT packages. "Read the format an
  iPhone actually makes, on Chrome and Firefox" is not.

### On being copyable

The SDK is client-side JavaScript and WebAssembly. It can always be downloaded
and self-hosted, and no client-side key can block execution. That is equally
true of every competitor in this category, including the one charging EUR 749
per seat. Enforcement is the licence plus the attribution badge, which works
because the violation is visible on the infringer's own public site. For a
product whose whole claim is that nothing leaves your device, shipping an
obfuscated blob would contradict the pitch. Say so on the page.

### Three places that must agree

`sdk/mint-tool.html`, `dist/developers/index.html` and the homepage. Today they
do not: `/developers/` is titled "Free Image Optimization SDK" and says "free
forever" while quoting $9/$29/$99. After this change every price claim points
at `/developers/pricing/`.

## Not doing

- **No blog.** A blog nobody updates is worse than no blog. `/guides/` is the
  same idea with a finite, finishable scope.
- **No accounts on the consumer tool.** There is nothing to store. An account
  would contradict the product.
- **No `/compare/` competitor pages.** They rank badly from a low-authority
  domain and they date quickly.
