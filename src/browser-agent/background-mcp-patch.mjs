// One bounded source change to the installed official Playwright bundle.
// Unsupported upstream layouts fail closed instead of launching a foreground browser.
export function patchBackgroundBootstrap(source) {
  const marker='async _openConnectPageInBrowser(clientName) {';
  const start=source.indexOf(marker);
  if(start<0||source.indexOf(marker,start+marker.length)>=0)throw new Error('Unsupported Playwright bootstrap method layout');
  const end=source.indexOf('\n      stop() {',start);
  if(end<0||end-start>6000)throw new Error('Unsupported Playwright bootstrap method boundary');
  const body=source.slice(start,end);
  if(!body.includes('url3.toString()')||!body.includes('PLAYWRIGHT_MCP_EXTENSION_TOKEN'))throw new Error('Unsupported Playwright extension invitation contract');
  const spawn=/\(0, import_child_process\d+\.spawn\)\(executablePath, args, \{\s*windowsHide: true,\s*detached: true,\s*shell: false,\s*stdio: "ignore"\s*\}\);/g;
  const matches=[...body.matchAll(spawn)];
  if(matches.length!==1)throw new Error('Unsupported Playwright browser launch shape; refusing foreground fallback');
  const replaced=body.replace(spawn,'await globalThis.__piOpenBackgroundExtension(href);');
  return source.slice(0,start)+replaced+source.slice(end);
}
