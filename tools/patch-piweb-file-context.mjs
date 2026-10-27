// Final source overlay: one context menu across conversation file renderers.
import crypto from 'node:crypto';
export function integrateFileContext({ get, set, change, prepend, template }) {
  set('components/PortableFileContextMenu.tsx', template('file-context/PortableFileContextMenu.tsx'));
  set('app/api/open-local-file/route.ts', template('file-context/open-local-file-route.ts'));
  set('lib/portable-windows-file-links.ts', template('file-context/portable-windows-file-links.ts'));
  set('lib/portable-windows-folder-focus.ts', `export const windowsFolderFocusScript = ${JSON.stringify(template('file-context/windows-folder-focus.ps1'))};\n`);

  prepend('lib/markdown.ts', 'import { portableWindowsFileLinks } from "./portable-windows-file-links";\n');
  change('lib/markdown.ts', '      [portableImageUrls, { cwd }],', '      portableWindowsFileLinks,\n      [portableImageUrls, { cwd }],');

  const message = 'components/MessageView.tsx';
  prepend(message, 'import { PortableFileSession } from "./PortableFileContextMenu";\n');
  for (const line of [
    '    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} onEditContent={onEditContent} />;',
    '    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} searchBlock={searchBlock} writtenFiles={writtenFiles} />;',
    '    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;',
  ]) change(message, line, line.replace('return <', 'return <PortableFileSession.Provider value={sessionId}><').replace(' />;', ' /></PortableFileSession.Provider>;'));

  const written = 'components/TurnWrittenFiles.tsx';
  prepend(written, 'import { PortableFileContextMenu, usePortableFileMenu } from "./PortableFileContextMenu";\n');
  change(written, '  const [showAll, setShowAll] = useState(false);', '  const [showAll, setShowAll] = useState(false);\n  const fileMenu = usePortableFileMenu(cwd, undefined, onOpenFile);');
  change(written, '            onClick={() => onOpenFile?.(filePath)}', '            onClick={() => onOpenFile?.(filePath)}\n            onContextMenu={(event) => fileMenu.open(event, filePath)}');
  change(written, '      {hidden > 0 && (', '      <PortableFileContextMenu menu={fileMenu} />\n      {hidden > 0 && (');

  const markdown = 'components/MarkdownBody.tsx';
  prepend(markdown, 'import { PortableFileContextMenu, usePortableFileMenu, localFilePathFromImageApi, localFilePathFromInlineCode } from "./PortableFileContextMenu";\n');
  change(markdown, '  const { cwd } = useContext(MarkdownRenderContext);\n  delete props.node;', '  const { cwd, onOpenFile } = useContext(MarkdownRenderContext);\n  const fileMenu = usePortableFileMenu(cwd, undefined, onOpenFile);\n  delete props.node;');
  change(markdown, '  const filePath = href ? resolveLocalFileHref(href, cwd) : null;', '  const filePath = href ? resolveLocalFileHref(href, cwd) ?? localFilePathFromImageApi(href) : null;');
  change(markdown, `  if (!imageSrc || insideLink) return image;
  return <PortableOutputImage src={imageSrc} alt={alt ?? ""} {...props} />;`, `  const output = !imageSrc || insideLink ? image : <PortableOutputImage src={imageSrc} alt={alt ?? ""} {...props} />;
  return filePath ? <span onContextMenu={(event) => fileMenu.open(event, filePath)}>{output}<PortableFileContextMenu menu={fileMenu} /></span> : output;`);
  change(markdown, '  const { isStreaming } = useContext(MarkdownRenderContext);\n  const lang', '  const { isStreaming, cwd, onOpenFile } = useContext(MarkdownRenderContext);\n  const fileMenu = usePortableFileMenu(cwd, undefined, onOpenFile);\n  const lang');
  change(markdown, `  return (
    <code
      className="markdown-inline-code"
      {...props}
    >
      {children}
    </code>
  );`, `  // Inline code that is itself a path is another common way of delivering files.
  const filePath = typeof children === "string" ? localFilePathFromInlineCode(children, cwd) : null;
  return <><code className="markdown-inline-code" {...props} onContextMenu={filePath ? (event) => fileMenu.open(event, filePath) : undefined}>{children}</code><PortableFileContextMenu menu={fileMenu} /></>;`);
  change(markdown, '  const { cwd, onOpenFile } = useContext(MarkdownRenderContext);\n  // `node`', '  const { cwd, onOpenFile } = useContext(MarkdownRenderContext);\n  const fileMenu = usePortableFileMenu(cwd, undefined, onOpenFile);\n  // `node`');
  change(markdown, '      <a href={href} {...props} onClick={handleClick}>\n        {children}\n      </a>', '      <a href={href} {...props} onClick={handleClick} onContextMenu={(event) => fileMenu.open(event, filePath)}>\n        {children}\n      </a>\n      <PortableFileContextMenu menu={fileMenu} />');

  const host = 'components/desktop-transcript/host.tsx';
  prepend(host, 'import { PortableFileContextMenu, usePortableFileMenu, localFilePathFromImageApi, localFilePathFromInlineCode, type PortableFileMenuState } from "../PortableFileContextMenu";\nimport { encodeFilePathForApi } from "@/lib/file-paths";\n');
  const menuStart = `type Menu={x:number;y:number;path:string}|null;
export function useChatFileMenu(){
  const [fileMenu,setMenu]=useState<Menu>(null);
  return {fileMenu,openFileMenu:(event:MouseEvent,target:{path:string})=>{event.preventDefault();setMenu({x:event.clientX,y:event.clientY,path:target.path});},closeFileMenu:()=>setMenu(null)};
}
export function ContextMenu({state,onClose}:{state:Menu;onClose:()=>void}){
  const host=useContext(HostContext);
  useEffect(()=>{if(!state)return;const close=()=>onClose();window.addEventListener("pointerdown",close);return()=>window.removeEventListener("pointerdown",close);},[state,onClose]);
  if(!state)return null;
  return <div role="menu" className="pd-file-menu" style={{position:"fixed",left:Math.min(state.x,window.innerWidth-160),top:Math.min(state.y,window.innerHeight-80),zIndex:90}} onPointerDown={e=>e.stopPropagation()}>
    <button role="menuitem" onClick={()=>{host.onOpenFile?.(state.path);onClose();}}>打开文件</button>
    <button role="menuitem" onClick={()=>{void navigator.clipboard.writeText(state.path);onClose();}}>复制路径</button>
  </div>;
}`;
  const menuEnd = `export function useChatFileMenu(){
  const host=useContext(HostContext),fileMenu=usePortableFileMenu(host.cwd,host.sessionId,host.onOpenFile);
  return {fileMenu,openFileMenu:(event:MouseEvent<HTMLElement>,target:{path:string})=>fileMenu.open(event,target.path),closeFileMenu:fileMenu.close};
}
export function ContextMenu({state}:{state:PortableFileMenuState;onClose:()=>void}){
  return <PortableFileContextMenu menu={state}/>;
}
function DesktopMarkdownLink({href,children}:{href?:string;children?:ReactNode}){
  const host=useContext(HostContext),menu=usePortableFileMenu(host.cwd,host.sessionId,host.onOpenFile);
  const file=resolveLocalFileHref(href,host.cwd);
  return <><a href={href} target={file?undefined:"_blank"} rel={file?undefined:"noopener noreferrer"} onClick={file&&host.onOpenFile?event=>{event.preventDefault();host.onOpenFile?.(file);}:undefined} onContextMenu={file?event=>menu.open(event,file):undefined}>{children}</a><PortableFileContextMenu menu={menu}/></>;
}
function DesktopMarkdownImage({src,alt}:{src?:string;alt?:string}){
  const host=useContext(HostContext),menu=usePortableFileMenu(host.cwd,host.sessionId,host.onOpenFile);
  const file=src?(resolveLocalFileHref(src,host.cwd)??localFilePathFromImageApi(src)):null;
  const image=<img src={file?\`/api/files/\${encodeFilePathForApi(file)}?type=read\`:src} alt={alt??""}/>;
  return file?<span onContextMenu={event=>menu.open(event,file)}>{image}<PortableFileContextMenu menu={menu}/></span>:image;
}
function DesktopMarkdownCode({className,children}:{className?:string;children?:ReactNode}){
  const host=useContext(HostContext),menu=usePortableFileMenu(host.cwd,host.sessionId,host.onOpenFile);
  const raw=String(children),file=localFilePathFromInlineCode(raw,host.cwd);
  if(className||raw.includes("\\n"))return <CodeBlock code={raw.replace(/\\n$/,"")} lang={className?.replace("language-","")??""}/>;
  return <><code onContextMenu={file?event=>menu.open(event,file):undefined}>{children}</code><PortableFileContextMenu menu={menu}/></>;
}`;
  change(host, menuStart, menuEnd);
  change(host, '      a:({href,children})=>{const file=resolveLocalFileHref(href,host.cwd);return <a href={href} target="_blank" rel="noopener noreferrer" onClick={file&&host.onOpenFile?event=>{event.preventDefault();host.onOpenFile?.(file);}:undefined}>{children}</a>;},', '      a:({href,children})=><DesktopMarkdownLink href={href}>{children}</DesktopMarkdownLink>,');
  change(host, '      img:({src,alt})=><img src={typeof src==="string"?src:undefined} alt={alt??""}/>,', '      img:({src,alt})=><DesktopMarkdownImage src={typeof src==="string"?src:undefined} alt={alt}/>,');
  change(host, '      code:({className,children})=>{const raw=String(children);return className||raw.includes("\\n")?<CodeBlock code={raw.replace(/\\n$/,"")} lang={className?.replace("language-","")??""}/>:<code>{children}</code>;},', '      code:({className,children})=><DesktopMarkdownCode className={className}>{children}</DesktopMarkdownCode>,');
  set('public/licenses/pi-desktop/source/host.tsx.txt', get(host));

  const toolRow = 'components/desktop-transcript/ToolRow.tsx';
  prepend(toolRow, 'import { PortableFileContextMenu, usePortableFileMenu } from "../PortableFileContextMenu";\n');
  change(toolRow, '  const openTarget=useOpenPreviewTarget();', '  const openTarget=useOpenPreviewTarget();\n  const fileMenu=usePortableFileMenu(host.cwd,host.sessionId,host.onOpenFile);');
  change(toolRow, 'onClick={previewTarget?(event)=>{event.stopPropagation();openTarget(previewTarget);}:undefined}>{summary}</span>', 'onClick={previewTarget?(event)=>{event.stopPropagation();openTarget(previewTarget);}:undefined} onContextMenu={previewTarget?.kind==="file"?event=>fileMenu.open(event,path):undefined}>{summary}</span>');
  change(toolRow, '      {runHead&&command?<ToolCommandCopy command={command}/>:null}', '      <PortableFileContextMenu menu={fileMenu}/>\n      {runHead&&command?<ToolCommandCopy command={command}/>:null}');
  set('public/licenses/pi-desktop/source/ToolRow.tsx.txt', get(toolRow));
  const pinned = JSON.parse(template('file-context/manifest.json'));
  for (const [name, expected] of Object.entries(pinned.files)) {
    if (crypto.createHash('sha256').update(get(name)).digest('hex') !== expected) throw new Error(`${name}: file context final-stage hash mismatch; zero writes`);
  }
}
