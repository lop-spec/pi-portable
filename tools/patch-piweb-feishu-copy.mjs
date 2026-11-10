// Standard clipboard HTML, not Feishu API post JSON or an undocumented private MIME.
export function integrateFeishuCopy({ get, set, change, prepend, template }) {
  const original = `export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}
`;
  change('lib/clipboard.ts', original, template('feishu-copy/clipboard.ts'));
  set('components/ClipboardSelection.tsx', template('feishu-copy/ClipboardSelection.tsx'));
  prepend('app/layout.tsx', 'import { ClipboardSelection } from "@/components/ClipboardSelection";\n');
  change('app/layout.tsx', '        <PwaRegistration />', '        <PwaRegistration />\n        <ClipboardSelection />');
  const message = 'components/MessageView.tsx';
  change(message, 'copyText(copyTarget)', 'copyText(copyTarget, commandText ? "code" : "markdown")');
  change(message, 'copyText(textContent)', 'copyText(textContent, "markdown")');
  change(message, 'copyText(text || detailsText)', 'copyText(text || detailsText, "code")');
  change('components/MermaidBlock.tsx', 'copyText(code)', 'copyText(code, "code")');
  const host = 'components/desktop-transcript/host.tsx';
  prepend(host, 'import { copyText } from "@/lib/clipboard";\n');
  change(host, 'navigator.clipboard.writeText(text)', 'copyText(text, "code")');
  const hook = 'hooks/useAgentSession.ts';
  prepend(hook, 'import { copyText } from "@/lib/clipboard";\n');
  change(hook, 'navigator.clipboard.writeText(textToCopy)', 'copyText(textToCopy, "markdown")');
  const timeline = 'components/PortableProcessTimeline.tsx';
  prepend(timeline, 'import { copyText } from "@/lib/clipboard";\n');
  change(timeline, 'navigator.clipboard.writeText(', 'copyText(', 2);
  const preview = 'components/PortableFilePreview.tsx';
  prepend(preview, 'import { copyText, fileCopyFormat } from "@/lib/clipboard";\n');
  change(preview, 'navigator.clipboard.writeText(await response.text())', 'copyText(await response.text(), fileCopyFormat(path))');
  change(preview, 'title="复制文件原文"', 'title="复制为飞书富文本（同时保留原文）"');
  // Explicit direct deps from the existing unified/remark/HAST ecosystem; CI installs before renderer tests.
  const pkg = JSON.parse(get('package.json'));
  Object.assign(pkg.devDependencies, { unified: '^11.0.5', 'remark-parse': '^11.0.0', 'remark-rehype': '^11.1.2', 'hast-util-to-html': '^9.0.5' });
  pkg.piPortable.feishuClipboard = 1;
  set('package.json', JSON.stringify(pkg, null, 2) + '\n');
  // Publish modified LGPL host source alongside the existing license/provenance.
  set('public/licenses/pi-desktop/source/host.tsx.txt', get(host));
}
