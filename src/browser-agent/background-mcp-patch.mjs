// Bounded in-memory changes to the installed official Playwright bundle.
// Unsupported upstream layouts fail closed instead of launching a foreground browser.
export function patchBackgroundBootstrap(source) {
  const marker='async _openConnectPageInBrowser(clientName) {';
  const start=source.indexOf(marker);
  if(start<0||source.indexOf(marker,start+marker.length)>=0)throw new Error('Unsupported Playwright bootstrap method layout');
  const end=source.indexOf('\n      stop() {',start);
  if(end<0||end-start>6000)throw new Error('Unsupported Playwright bootstrap method boundary');
  const body=source.slice(start,end);
  // 1.63 moved the same environment token into the relay constructor. Accept
  // that bounded layout as well, but still require authenticated invitations.
  const constructor=source.slice(Math.max(0,start-6000),start);
  const tokenInConstructor=constructor.includes('this._token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;') && body.includes('url3.searchParams.set("token", this._token);');
  if(!body.includes('url3.toString()')||!(body.includes('PLAYWRIGHT_MCP_EXTENSION_TOKEN')||tokenInConstructor))throw new Error('Unsupported Playwright extension invitation contract');
  const spawn=/\(0, import_child_process\d+\.spawn\)\(executablePath, args, \{\s*windowsHide: true,\s*detached: true,\s*shell: false,\s*stdio: "ignore"\s*\}\);/g;
  const matches=[...body.matchAll(spawn)];
  if(matches.length!==1)throw new Error('Unsupported Playwright browser launch shape; refusing foreground fallback');
  const replaced=body.replace(spawn,'await globalThis.__piOpenBackgroundExtension(href);');
  return source.slice(0,start)+replaced+source.slice(end);
}

// Extension CDP sets noDefaults=true, suppressing Playwright's standard page
// focus emulation. Restore only that override for the bridge's fixed target so
// background rAF/actionability can run; never activate a real tab or window.
export function patchBackgroundFocusEmulation(source) {
  const pattern=/if \(this\._isMainFrame\(\) && !skipDefaultOverrides\)(\s+promises\d*\.push\(this\._client\.send\("Emulation\.setFocusEmulationEnabled", \{ enabled: true \}\)\);)/g;
  if([...source.matchAll(pattern)].length!==1)throw new Error('Unsupported Playwright focus-emulation layout; refusing foreground or forced-click fallback');
  return source.replace(pattern,'if (this._isMainFrame())$1');
}
