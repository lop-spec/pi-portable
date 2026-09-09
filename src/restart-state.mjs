import fs from "node:fs";
import path from "node:path";

const normalized = (s) => String(s || "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

// Use current process identity, not stale ledger PIDs. Never kill the supervising host
// or a daily browser. Collapse owned descendants so taskkill runs once, not per PID.
export function selectSweepRoots(processes, { home, data, selfPid, parentPid, bridgeOwned, webInternalPort }) {
  const table = new Map(processes.map(p => [Number(p.ProcessId), p]));
  const keep = new Set([selfPid, parentPid]);
  function protectAncestors(pid) {
    const seen = new Set();
    while (pid > 4 && !seen.has(pid)) {
      seen.add(pid); keep.add(pid); pid = Number(table.get(pid)?.ParentProcessId);
    }
  }
  protectAncestors(selfPid);
  const root = normalized(home) + "/";
  const profile = normalized(data) + "/browser-profile";
  for (const p of processes) {
    const cmd = normalized(p.CommandLine);
    if ((/^(thorium|chrome|msedge)\.exe$/i.test(p.Name) && !cmd.includes(profile))
      || (!bridgeOwned && cmd.includes(root + "src/bridge/codex-responses-proxy.mjs"))) {
      protectAncestors(Number(p.ProcessId));
    }
  }
  const owned = processes.filter(p => {
    const pid = Number(p.ProcessId), cmd = normalized(p.CommandLine);
    if (pid <= 4 || keep.has(pid) || !cmd.includes(root)) return false;
    if (/^(thorium|chrome|msedge)\.exe$/i.test(p.Name)) return cmd.includes(profile);
    if (!/^(node|powershell|pi-portable-launcher)\.exe$/i.test(p.Name)) return false;
    return ["src/launcher.mjs", "src/piweb-ui-proxy.mjs", "src/run-supervisor.mjs", "src/tray.ps1",
      ...(bridgeOwned ? ["src/bridge/codex-responses-proxy.mjs"] : []),
      "app/node_modules/@agegr/pi-web/bin/pi-web.js", "app/node_modules/@agegr/pi-web/dist/server.js"]
      .some(entry => cmd.includes(root + entry))
      || (cmd.includes(root + "releases/") && cmd.includes("/node_modules/next/dist/bin/next start -p " + webInternalPort));
  });
  const pids = new Set(owned.map(p => Number(p.ProcessId)));
  const roots = owned.filter(p => {
    let pid = Number(p.ParentProcessId); const seen = new Set();
    while (pid > 4 && !seen.has(pid)) {
      if (pids.has(pid)) return false;
      seen.add(pid); pid = Number(table.get(pid)?.ParentProcessId);
    }
    return true;
  }).map(p => Number(p.ProcessId));
  return { roots, pids: [...pids], protectedPids: [...keep] };
}

const ticketPath = data => path.join(data, "restart-handoff.json");
export function saveRestartHandoff(data, ticket) {
  const file = ticketPath(data), temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(ticket) + "\n"); fs.renameSync(temp, file);
}
export function consumeRestartHandoff(data, { parentPid, now = Date.now(), log = console.error } = {}) {
  const file = ticketPath(data);
  if (!fs.existsSync(file)) return null;
  let ticket;
  try { ticket = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { log(`restart-handoff invalid: ${e.name}`); fs.unlinkSync(file); return null; }
  if (!ticket || !Number.isFinite(ticket.at) || now - ticket.at < 0 || now - ticket.at > 60000
    || ticket.openWindow !== true || typeof ticket.swept !== "boolean"
    || !Number.isInteger(ticket.supervisorPid) || ticket.supervisorPid < 0
    || (ticket.swept && (!Array.isArray(ticket.ports) || !ticket.ports.length
      || ticket.ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)))) {
    log("restart-handoff expired/invalid; normal startup applies"); fs.unlinkSync(file); return null;
  }
  if (ticket.supervisorPid && ticket.supervisorPid !== parentPid) {
    log("restart-handoff belongs to another supervisor; not consumed"); return null;
  }
  fs.unlinkSync(file);
  return ticket;
}
