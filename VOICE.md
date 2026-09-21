# imgready voice

## Who is talking

A competent friend who is mildly annoyed on your behalf. They have already hit
this problem, they know why it happens, and they are handing you the fix without
a speech about it.

Not a brand. Not a startup. Not a wizard. The red panda is the entire charm
budget for this product; the words stay dry.

## Five rules

**1. Name the annoyance, then remove it.**
Open on the irritation, not the feature. The reader recognises their own problem
in the first clause and the sentence resolves it in the second.

> Your phone shoots HEIC. Half the web will not take it.

not

> Comprehensive support for modern image formats.

**2. Proof, not adjectives.**
Never assert a quality you can instead demonstrate. Give a number, a byte size,
or a way for the reader to check without trusting us. Anything a competitor
could copy-paste into their own page is not a claim, it is filler.

> Open the Network tab and drop a file. Nothing goes out.

not

> Completely private and secure.

**3. Second person, active verbs.**
Their file, their phone, their bill, their users. Verbs carry the meaning;
nominalisations hide it.

> You set the quality.

not

> Quality settings are configurable.

**4. One idea per sentence, and short ones.**
If a comma is doing the work of a full stop, use the full stop. Fragments are
allowed when they land.

**5. Understate the win.**
Deadpan beats enthusiastic. The reader is suspicious of image tools, correctly,
because most of them upload your files. Confidence reads as calm.

> It does not wreck the photo.

not

> Stunning quality, every time.

## Banned

**Words:** seamless, powerful, effortless, blazing, lightning, unleash,
revolutionary, magic, supercharge, robust, leverage, solution, simply, just,
easy, cutting-edge, next-generation, game-changing.

**Punctuation:** em-dash and en-dash anywhere visible (enforced by
`tests/site-checks.mjs` check 20). Exclamation marks.

**Openers:** "We're excited to", "Introducing", "In today's world".

## Say / do not say

| Do not say | Say |
| --- | --- |
| Lightning-fast compression | 848 KB to 66 KB, in about a second |
| Enterprise-grade privacy | Nothing leaves your device |
| Supports a wide range of formats | Reads the one your phone actually makes |
| Powerful quality controls | You set the quality, not a preset |
| Seamless integration | One script tag, no build step |
| Unlimited free usage | Two files or two hundred, same price |

## Where the exceptions are

**Headings** get one word in rust (`--accent`) carrying the meaning of the
sentence. Pick the verb or the noun the sentence turns on, never a filler word.
The hero H1 is the exception to the exception: it highlights a whole clause,
because it is the brand statement and it only appears once.

**Legal and licence copy** drops the voice and states the terms plainly. Being
charming about what someone is allowed to do with your code is a way of being
unclear about it.
