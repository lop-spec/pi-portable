// CommonMark 的 flanking 规则让「**说明：**后文」「**验证结果：**7 项通过」这类中文加粗保持字面星号。
// 这个 remark 插件只补救同一个文本节点内成对的 **…**：
// - 不碰代码、公式、HTML 节点（它们没有 children）；
// - 内容首尾不能是空白，也不能含 *（不处理嵌套强调）；
// - 文本里含转义或实体时，节点值与源码片段长度不同，整节点跳过，不改写用户写成 \*\* 的字面星号。
const PAIR = /\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/gu;

/** 把一段文本拆成 text / strong 节点；没有可补救的成对星号时返回 null。 */
export function splitCjkStrong(value) {
  if (typeof value !== 'string' || !value.includes('**')) return null;
  const nodes = [];
  let last = 0;
  let matched = false;
  for (const match of value.matchAll(PAIR)) {
    matched = true;
    if (match.index > last) nodes.push({ type: 'text', value: value.slice(last, match.index) });
    nodes.push({ type: 'strong', children: [{ type: 'text', value: match[1] }] });
    last = match.index + match[0].length;
  }
  if (!matched) return null;
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
}

function alignedWithSource(node, source) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  // 手工构造的树没有位置信息：无从核对，按未转义处理；真实解析总有位置。
  if (typeof source !== 'string' || typeof start !== 'number' || typeof end !== 'number') return true;
  return source.slice(start, end) === node.value;
}

function visit(parent, source) {
  const children = parent.children;
  let next = null;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    let replacement = null;
    if (child.type === 'text') {
      if (alignedWithSource(child, source)) replacement = splitCjkStrong(child.value);
    } else if (Array.isArray(child.children)) {
      visit(child, source);
    }
    if (replacement) {
      next ??= children.slice(0, index);
      next.push(...replacement);
    } else if (next) {
      next.push(child);
    }
  }
  if (next) parent.children = next;
}

/** remark 插件：`remarkPlugins={[…, portableCjkEmphasis]}`。 */
export function portableCjkEmphasis() {
  return (tree, file) => {
    if (!tree || !Array.isArray(tree.children)) return;
    visit(tree, typeof file?.value === 'string' ? file.value : null);
  };
}
