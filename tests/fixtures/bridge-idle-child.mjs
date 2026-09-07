import tls from "node:tls";
// Only this isolated child replaces TLS. The parent owns a loopback HTTP fixture.
tls.connect = (options) => {
  const socket = options.socket;
  process.nextTick(() => socket.emit("secureConnect"));
  return socket;
};
await import("../../src/bridge/codex-responses-proxy.mjs");
