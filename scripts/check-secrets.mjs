#!/usr/bin/env node
// Fails (exit 1) if any file looks like it contains an API key or other secret.
//   node scripts/check-secrets.mjs           -> scan every tracked file (used in CI)
//   node scripts/check-secrets.mjs --staged  -> scan only staged changes (pre-commit hook)
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["ACS API key (v1)", /acs-bm-[A-Za-z0-9]{4,}-[A-Za-z0-9_\-]{8,}/],
  ["ACS API key (v2)", /\bsk-acs-[A-Za-z0-9_\-]{8,}/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_\-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Bearer token literal", /Bearer\s+[A-Za-z0-9_\-\.]{24,}/],
];

// Lines containing this marker are ignored (for documented fake examples).
const ALLOW = "secret-scan: allow";
const SKIP_FILES = [/^scripts\/check-secrets\.mjs$/, /\.(png|jpg|jpeg|gif|ico|woff2?)$/i];

const staged = process.argv.includes("--staged");
const sh = (cmd) => execSync(cmd, { encoding: "utf8" });

let files;
if (staged) {
  files = sh("git diff --cached --name-only --diff-filter=ACMR").split("\n").filter(Boolean);
} else {
  files = sh("git ls-files").split("\n").filter(Boolean);
}

let problems = 0;
for (const file of files) {
  if (SKIP_FILES.some((re) => re.test(file))) continue;
  let text;
  try {
    text = staged ? sh(`git show ":${file}"`) : readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) {
        problems++;
        console.error(`  ${file}:${i + 1}  looks like a ${name}`);
      }
    }
  });
}

if (problems) {
  console.error(`\nSecret check FAILED: ${problems} suspicious line(s). Remove the secret before committing.`);
  console.error(`(If it is a harmless fake example, add the comment "${ALLOW}" on that line.)`);
  process.exit(1);
}
console.log(`Secret check passed (${files.length} file(s) scanned).`);
