import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")), "..");
const localRules = "C:/Users/lop/.pi/agent/data/rules-pretool.mjs";
const rulesFile = process.env.PI_PRETOOL_RULES || (fs.existsSync(localRules) ? localRules : "");
const extensionFile = process.env.PI_PRETOOL_EXTENSION || path.join(repoRoot, "src", "lop-pretool.ts");
const rules = rulesFile ? await import(`${pathToFileURL(rulesFile).href}?t=${Date.now()}`) : null;
const ids = rules ? rules._RULES.map((rule) => rule.id) : [];
if (rules) {
  assert.equal(ids.length, 22);
  assert.equal(ids.includes("F1-resident-context-reread"), false);
  assert.equal(ids.includes("D13-foreground-wait"), false);
  assert.equal(ids.some((id) => id.startsWith("H1-")), false);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pretool-contract-"));
try {
  if (rules) {
  const heredoc = rules.checkPreTool({
    session_id: "contract",
    transcript_path: "",
    tool_name: "bash",
    tool_input: { command: "node --input-type=module - <<'NODE'\nconsole.log('ok')\nNODE" },
  });
  assert.equal(heredoc.length, 1);
  assert.equal(heredoc[0].id, "D8-heredoc-inline-script");
  assert.equal(typeof heredoc[0].fixup, "function");
  const fixed = heredoc[0].fixup({ command: "node --input-type=module - <<'NODE'\nconsole.log('ok')\nNODE" });
  assert.ok(fixed.input.command.includes(".mjs"));
  assert.equal(fixed.input.command.includes("<<"), false);
  const generated = fixed.input.command.match(/'([^']+\.mjs)'/)?.[1];
  if (generated && fs.existsSync(generated)) fs.rmSync(generated, { force: true });

  const wait = rules.checkPreTool({
    session_id: "contract",
    transcript_path: "",
    tool_name: "bash",
    tool_input: { command: "sleep 3600" },
  });
  assert.equal(wait, null);
  }

  const extension = fs.readFileSync(extensionFile, "utf8");
  assert.ok(extension.includes("pretool-only-v3"));
  assert.ok(extension.includes("lop-pretool.log"));
  assert.equal(extension.includes("\"lop-chain.log\""), false);
  assert.ok(extension.includes("getSessionId"));
  assert.ok(extension.includes("getSessionFile"));
  assert.ok(extension.includes("S7 FIXUP_BLOCK"));
  assert.equal(extension.includes("PI_PORTABLE_DATA || path.join(HOME"), false);

  console.log(JSON.stringify({ ok: true, rules: rules ? ids.length : "private-runtime-only", heredocFixup: Boolean(rules), foregroundWaitPolicy: false }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
