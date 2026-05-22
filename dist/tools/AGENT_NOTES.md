# Truncation defense — agent operating notes

This repo lives on a Windows-mounted Cowork sandbox. Multiple known Cowork
issues silently truncate files when the agent edits them via the harness:

- [#53940](https://github.com/anthropics/claude-code/issues/53940) — Edit/Write
  byte-conservation: post-edit byte count equals pre-edit byte count, so any
  bytes added are subtracted from the end.
- [#41702](https://github.com/anthropics/claude-code/issues/41702) — OneDrive
  -backed paths cause silent truncation on write.
- [#41710](https://github.com/anthropics/claude-code/issues/41710) and
  [#55877](https://github.com/anthropics/claude-code/issues/55877) — stale FUSE
  cache: reads of the local file can return stale or truncated content for
  up to an hour after a write.
- [#52881](https://github.com/anthropics/claude-code/issues/52881) — Edit-tool
  truncation after multiple replacements.

This codebase has been repeatedly damaged by the above. Defenses are layered:

## Layer 0 — Agent discipline (do not skip)

1. **Never use the `Edit` tool on any file in this repo.** Edit is the proven
   offender. Use atomic Python writes via `mcp__workspace__bash` instead:
   ```python
   import os
   tmp = path + ".tmp"
   with open(tmp, "wb") as f: f.write(content.encode("utf-8"))
   os.replace(tmp, path)
   ```
2. **Never trust a local read after a write.** If you must verify, fetch the
   file from `https://api.github.com/repos/cookieforest/imgready/contents/...`
   after pushing. That bypasses the FUSE cache layer entirely.
3. **When recovering a truncated file, source from GitHub raw**
   (`raw.githubusercontent.com/cookieforest/imgready/main/<path>`) and apply
   edits to the recovered content via Python `str.replace` in one pass.

## Layer 1 — Tail sentinels (in `build.mjs`)

Every important source file ends with a known sentinel comment. `build.mjs`
calls `validateTailSentinels()` before bundling and fails the build with a
precise error if any sentinel is missing. Sentinels are listed in
`TAIL_SENTINELS` at the top of `build.mjs`.

When adding a new chunk, add a sentinel + register it in `TAIL_SENTINELS`.

## Layer 2 — Push verifier (`tools/verify-push.mjs`)

After pushing to GitHub, run:
```bash
node tools/verify-push.mjs main src/01-state-helpers.js src/app.css ...
```
This fetches each file from the GitHub Contents API and sha256-compares
against the local copy. The Contents API hits the post-push git tree
directly (not the CDN), so the bytes returned are the bytes on `main`.

## Layer 3 — CI structural checks (`.github/workflows/check.yml`)

Last line of defense. CI runs three structural checks beyond the existing
JS syntax check:
- Tail sentinel presence (mirror of Layer 1)
- CSS structural integrity (balanced braces, sane trailing char)
- File-size shrinkage guard (file shrinking >20% commit-over-commit fails
  unless `[skip-size-guard]` is in the commit message)

## Recovery when truncation happens anyway

1. `curl -sL https://raw.githubusercontent.com/cookieforest/imgready/main/<path>`
   to get the canonical version.
2. Apply your intended edit to the recovered content with Python `str.replace`.
3. Atomic-write the result back to the local file.
4. Build, push, run `verify-push.mjs`.

If the canonical itself is truncated (it has happened — see the May 2026
recovery from `index.html.bak`), check the `index.html.bak` and
`index.html.broken_truncated` files at the repo root for older intact
copies.

## UX-first rule (HARD — no exceptions)

For ANY change that touches what the user sees, the agent MUST:

1. Open the live site at https://imgready.app in Chrome (or local preview) at
   BOTH desktop (≥1280px) and mobile (375–414px) widths before proposing.
2. Walk the affected user journey end-to-end — cold visit, drop image,
   process, save. Look at the rendered DOM at every step.
3. Report concrete observations from that walkthrough in the proposal.
   Not "the slider would be useful" — "at 160px card width on mobile the
   handle competes with the savings stamp; on desktop 240px it works."
4. If a change adds visual density to the card or dropzone, also visually
   test the 2-up and 3-up grid at the same widths. Density is the most
   common UX failure mode for this app.
5. Skepticism toward dead code: if a function exists but its DOM target
   doesn't, default to "the previous engineer removed it on purpose"
   not "I should wire it up." Read git history before reviving.
6. Discovery → research → proposal → approval → implementation, in that
   order. Implementation FIRST then asking for forgiveness later costs
   the user time even when the revert is fast.

Failure mode to remember (May 7 2026): inline before/after slider
shipped on a result card, then reverted. Cards are 140–200px in the
grid; a drag handle on top of the existing savings stamp + format
chip + crop overlay was visually noisy and hard to use. The IIFE had
been there as dead code with a code comment literally explaining it
had been "previously removed" — the agent missed both signals because
it never opened the live page.

