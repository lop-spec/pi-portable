// Keep AskUserQuestion's Other screen inside the pending select: Back is local,
// preserves its draft, and cannot submit/cancel the question or lose multi-selects.
export function integrateAskBack({ change }) {
  const chat = 'components/ChatWindow.tsx';
  change(chat,
    '  const [collapsed, setCollapsed] = useState(false);\n  const [now, setNow] = useState(() => Date.now());',
    '  const [collapsed, setCollapsed] = useState(false);\n  const [customInput, setCustomInput] = useState(false);\n  const chooseOption = (option: string) => {\n    if (option === "其他（自己输入）") setCustomInput(true);\n    else onRespond(request, { value: option });\n  };\n  const [now, setNow] = useState(() => Date.now());');
  change(chat,
    '    if (request.method === "confirm") {\n      onRespond(request, { confirmed: true });',
    '    if (customInput) {\n      if (value.trim()) onRespond(request, { value: value.trim() });\n    } else if (request.method === "confirm") {\n      onRespond(request, { confirmed: true });');
  change(chat, '{request.method === "select" && (\n            <div', '{request.method === "select" && !customInput && (\n            <div');
  change(chat, 'onClick={() => onRespond(request, { value: option })}', 'onClick={() => chooseOption(option)}');
  change(chat, '                    onRespond(request, { value: option });', '                    chooseOption(option);');
  change(chat, '{request.method === "input" && (\n            <input', '{(request.method === "input" || customInput) && (\n            <input');
  change(chat, '              placeholder={request.placeholder}', '              placeholder={request.method === "input" ? request.placeholder : "输入你的答案"}');
  const footer = '        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>';
  change(chat, footer, footer + `
          {customInput && (
            <button
              type="button"
              data-extension-back
              title="返回推荐选项"
              aria-label="Back"
              onClick={() => setCustomInput(false)}
              style={{ marginRight: "auto", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
            >
              ← Back
            </button>
          )}`);
  change(chat, ') : request.method !== "select" ? (', ') : request.method !== "select" || customInput ? (');
}
