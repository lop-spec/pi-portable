// Applied after the pinned Desktop/file-context overlays; leaves their hashes intact.
export function integrateCetusCraft({ get, set, change, prepend, template }) {
  for (const [out, input] of Object.entries({
    'components/PortableFilePreview.tsx': 'PortableFilePreview.tsx',
    'components/PortableArtifactThumbnail.tsx': 'PortableArtifactThumbnail.tsx',
    'lib/portable-tool-intent.mjs': 'tool-intent.mjs',
    'app/cetus-craft.css': 'preview.css',
    'lib/portable-preview-html.ts': 'preview-html.ts',
    'public/licenses/cetus/LICENSE': 'CETUS-LICENSE',
    'public/licenses/cetus/provenance.json': 'provenance.json',
  })) set(out, template('cetus-craft/' + input));
  prepend('components/FileViewer.tsx', 'import { previewHtml } from "@/lib/portable-preview-html";\n');
  change('components/FileViewer.tsx', 'srcDoc={content}', 'srcDoc={previewHtml(content)}');
  prepend('app/layout.tsx', 'import "./cetus-craft.css";\n');
  prepend('lib/rpc-manager.ts', 'import { installToolIntent } from "./portable-tool-intent.mjs";\n');
  change('lib/rpc-manager.ts', '    this.exactSystemPrompt = options.exactSystemPrompt;', '    installToolIntent(this.inner);\n    this.exactSystemPrompt = options.exactSystemPrompt;');
  change('lib/session-reader.ts', 'const CHAT_VIEW_TOOL_INPUT_KEYS = ["path", "file_path"] as const;', 'const CHAT_VIEW_TOOL_INPUT_KEYS = ["path", "file_path", "_intent", "_displayName"] as const;');
  const row = 'components/desktop-transcript/ToolRow.tsx';
  change(row, '    {open?<div className="tool-row-body"', '    {typeof args?._intent === "string" && args._intent.trim() ? <div className="pw-tool-intent">{args._intent}</div> : null}\n    {open?<div className="tool-row-body"');
  change(row, '{t((status==="running"?TOOL_RUNNING_KEYS:TOOL_ACTION_KEYS)[action])}', '{typeof args?._displayName === "string" && args._displayName.trim() ? args._displayName : t((status==="running"?TOOL_RUNNING_KEYS:TOOL_ACTION_KEYS)[action])}');
  const shell = 'components/AppShell.tsx';
  prepend(shell, 'import { PortableFilePreview } from "./PortableFilePreview";\n');
  // The original file renderer (source/diff/preview, PDFs, media, line mentions)
  // moves, rather than being duplicated. Terminal panels keep their lifecycle.
  const s = get(shell);
  const start = s.indexOf('            <FileViewer\n');
  const end = s.indexOf('\n            />', start) + '\n            />'.length;
  if (start < 0 || end < start) throw new Error('FileViewer anchor missing');
  const viewer = s.slice(start, end);
  change(shell, viewer, '<span />');
  change(shell, 'className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}', 'className={`right-panel-container${rightPanelOpen && !activeFileTab?.filePath ? " right-panel-open" : " right-panel-closed"}');
  change(shell, 'className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}', 'className={`right-panel-overlay-backdrop${rightPanelOpen && !activeFileTab?.filePath ? " is-open" : ""}`}');
  change(shell, '      {rightPanelOpen && (\n        <div', '      {rightPanelOpen && !activeFileTab?.filePath && (\n        <div');
  change(shell, '  const [fileTabs, setFileTabs] = useState<Tab[]>([]);\n  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);', '');
  change(shell, '  const [rightPanelOpen, setRightPanelOpen] = useState(false);', '  const [fileTabs, setFileTabs] = useState<Tab[]>([]);\n  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);\n  const [rightPanelOpen, setRightPanelOpen] = useState(false);');
  // File modals must not trigger the side panel's full-width inert layout.
  change(shell, 'const rightPanelFullWidth = rightPanelOpen && rightPanelExpanded && !isMobile;', 'const rightPanelFullWidth = rightPanelOpen && rightPanelExpanded && !isMobile && !fileTabs.some(tab => tab.id === activeFileTabId && tab.filePath);');
  change(shell, '    {settingsSection && (', `    {rightPanelOpen && activeFileTab?.filePath && <PortableFilePreview file={activeFileTab} files={fileTabs.filter(tab => Boolean(tab.filePath) && tab.sourceSessionId === activeFileTab.sourceSessionId)} onSelect={setActiveFileTabId} onClose={() => setRightPanelOpen(false)}>
${viewer}
    </PortableFilePreview>}
    {settingsSection && (`);
  change(shell, '  const handleOpenLinkedFile = useCallback(', `  useEffect(() => {
    const addFiles = (event: Event) => {
      const detail = (event as CustomEvent<{ paths: string[] }>).detail;
      if (!Array.isArray(detail?.paths)) return;
      setFileTabs(previous => detail.paths.filter(path => typeof path === "string").reduce((tabs, path) => openFileTab(tabs, { fileName: getFileName(path), filePath: path, tabId: "file:" + path, sourceSessionId: selectedSession?.id }), previous));
    };
    window.addEventListener("pi-web:preview-files", addFiles);
    return () => window.removeEventListener("pi-web:preview-files", addFiles);
  }, [selectedSession?.id]);
  const handleOpenLinkedFile = useCallback(`);
  const written = 'components/TurnWrittenFiles.tsx';
  prepend(written, 'import { PortableArtifactThumbnail } from "./PortableArtifactThumbnail";\n');
  change(written, 'className="pw-turn-files"', 'className="pw-artifact-cards"');
  change(written, 'className="pw-chip"', 'className="pw-artifact-card"');
  change(written, 'onClick={() => onOpenFile?.(filePath)}', 'onClick={() => { window.dispatchEvent(new CustomEvent("pi-web:preview-files", { detail: { paths: files.map(file => file.filePath) } })); onOpenFile?.(filePath); }}');
  change(written, '            <FilePenIcon />', '            <PortableArtifactThumbnail path={filePath} name={name} />');
  set('public/licenses/pi-desktop/source/ToolRow.tsx.txt', get(row));
}
