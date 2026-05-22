#!/usr/bin/env node
/**
 * verify-push.mjs — Layer 2 of the truncation defense.
 *
 * After pushing to GitHub, this fetches every file we just pushed back from
 * raw.githubusercontent.com and compares its sha256 against the locally
 * computed sha256. GitHub is the only source of truth that's downstream of
 * every Windows / FUSE / OneDrive / Edit-tool layer, so if these hashes
 * match we know the bytes that landed on `main` are the bytes we intended.
 *
 * Why this matters (see https://github.com/anthropics/claude-code/issues/53940
 * and #41702 for context): the local Cowork sandbox can silently truncate
 * files mid-write, and reads of the local file can return cached/stale
 * content for up to an hour. Trust nothing local; verify against GitHub.
 *
 * Usage:
 *   node tools/verify-push.mjs <branch> <file1> [<file2> ...]
 *
 * Exit code:
 *   0 — all files match
 *   1 — any file mismatched (or fetch failed)
 *
 * Notes:
 *   - We use the GitHub Contents API (api.github.com/repos/.../contents/...)
 *     rather than raw.githubusercontent.com because the raw CDN can serve a
 *     stale copy for several minutes after a push. The Contents API hits the
 *     same git tree the API just produced — no CDN in front of it.
 *   - Set GITHUB_TOKEN if the repo is private or you hit rate limits.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPO = process.env.IMGREADY_REPO || 'cookieforest/imgready';
const TOKEN = process.env.GITHUB_TOKEN || '';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function fetchRemote(branch, path) {
  /* Contents API returns base64-encoded content + the git blob SHA. The blob
     SHA is computed by GitHub when our push landed; matching SHAs is itself
     proof the bytes are correct. We still hash the decoded bytes for an
     end-to-end check (defends against any future protocol change). */
  const url = `https://api.github.com/repos/${REPO}/contents/${path}?ref=${branch}`;
  const headers = { 'Accept': 'application/vnd.github.v3+json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.encoding !== 'base64') throw new Error(`${path}: unexpected encoding ${j.encoding}`);
  return Buffer.from(j.content, 'base64');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: verify-push.mjs <branch> <file1> [<file2> ...]');
    process.exit(2);
  }
  const [branch, ...files] = args;

  let failed = 0;
  for (const path of files) {
    let local, remote;
    try {
      local = readFileSync(path);
      remote = await fetchRemote(branch, path);
    } catch (e) {
      console.log(`✗ ${path}: ${e.message}`);
      failed++;
      continue;
    }
    const localHash = sha256(local).slice(0, 12);
    const remoteHash = sha256(remote).slice(0, 12);
    const ok = localHash === remoteHash && local.length === remote.length;
    const tag = ok ? 'OK ' : 'FAIL';
    console.log(`  ${tag}  ${path}  local=${localHash}/${local.length}B  remote=${remoteHash}/${remote.length}B`);
    if (!ok) failed++;
  }
  if (failed > 0) {
    console.error(`\n[verify-push] ${failed} mismatch(es) — what GitHub has does not match what we tried to send. Re-push.`);
    process.exit(1);
  }
  console.log(`\n[verify-push] ${files.length} file(s) verified: GitHub bytes match local bytes.`);
}

main().catch(e => { console.error(e); process.exit(1); });
