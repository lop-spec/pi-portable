// Import in the browser against the isolated fixture proxy, never production.
const check = (condition, message) => { if (!condition) throw new Error(message); };
const wait = async (test, message, ms = 12000) => {
  const end = performance.now() + ms;
  while (!test()) { check(performance.now() < end, message); await new Promise(r => setTimeout(r, 40)); }
};
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
const visible = element => !!element && !element.hidden && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getBoundingClientRect().height > 0;
const click = element => { check(element, 'missing click target'); element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); element.click(); };
const escape = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
function guard() { check(location.origin === 'http://127.0.0.1:30151', 'fixture proxy only'); }

export async function panels() {
  guard(); escape(); await frame();
  const quota = document.querySelector('#pi-account-usage-panel'), tier = document.querySelector('#pi-service-tier-panel');
  if (visible(quota)) click(document.querySelector('#pi-account-usage-button'));
  click(document.querySelector('#pi-account-usage-button')); await frame();
  check(visible(quota), 'quota did not open');
  await wait(() => quota.querySelectorAll('[data-account-id]').length === 8, 'fixture accounts missing');
  const rows = [...quota.querySelectorAll('[data-account-id]')];
  check(!quota.querySelector('[data-account-id] .pi-account-usage-meta [style*="ellipsis"]'), 'truncated metadata');
  click(document.querySelector('#pi-service-tier-button')); await frame();
  check(visible(tier) && !visible(quota), 'quota/TIER overlap');
  const items = [...tier.querySelectorAll('button[data-tier]')];
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  check(document.activeElement === items.at(-1), 'TIER keyboard End failed');
  escape(); await frame();
  check(!visible(tier) && document.activeElement.id === 'pi-service-tier-button', 'TIER Escape/focus failed');
  click(document.querySelector('#pi-account-usage-button')); await frame();
  check(rows.every((row, i) => row === quota.querySelectorAll('[data-account-id]')[i]), 'unchanged quota rows reconstructed');
  const bounds = quota.getBoundingClientRect();
  check(bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth, 'quota outside viewport');
  const model = document.querySelector('.model-selector.is-toolbar button');
  check(model.getAttribute('aria-label').includes('Fixture A'), 'icon-only model lacks current model label');
  check(model.getBoundingClientRect().width === 32, 'model icon CSS was not applied');
  escape();
  return { accounts: rows.length, rowIdentityPreserved: true, mutualExclusion: true, keyboardAndFocus: true, modelIcon: true };
}

export async function conversation() {
  guard(); check(location.search.includes('upstream-mixed'), 'mixed fixture required');
  const toggle = document.querySelector('.pw-node-toggle');
  check(toggle.textContent.includes('36'), 'full Q/A index missing');
  if (toggle.getAttribute('aria-expanded') === 'true') click(toggle);
  click(toggle); await frame();
  const nodes = [...document.querySelectorAll('[data-conversation-node-entry]')];
  check(nodes.length === 24, 'Q/A list must render only 24 rows');
  check(nodes.filter(n => n.dataset.conversationNodeRole === 'assistant').length === 12, 'A nodes missing');
  click(document.querySelector('[data-conversation-node-entry="q0"]'));
  await wait(() => document.querySelector('[data-entry-id="q0"]'), 'native history navigation failed');
  await frame();
  const question = document.querySelector('[data-entry-id="q0"]').getBoundingClientRect();
  check(question.bottom > 0 && question.top < innerHeight, 'Q/A did not scroll to old question');
  const tools = () => [...document.querySelectorAll('button')].filter(b => b.getAttribute('title') === 'read fixture.txt' || b.getAttribute('aria-label') === 'read fixture.txt' || b.textContent.trim() === 'readfixture.txt');
  check(tools().length === 18, 'collapsed process groups hide/duplicate tools');
  const group = [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === '展开处理详情');
  click(group); await frame();
  check(tools().length === 18, 'expanded process group duplicates tools');
  click(group); await frame();
  check(document.documentElement.scrollWidth <= innerWidth, 'page-level horizontal overflow');
  return { fullNodes: 36, renderedNodeRows: nodes.length, toolCards: tools().length, oldQuestionNavigation: true };
}

export async function clipboard() {
  guard();
  const textarea = document.querySelector('textarea');
  check(!textarea.value, 'clipboard test requires an empty fixture draft');
  const data = new DataTransfer();
  const name = `clipboard-fixture-${Date.now()}.txt`;
  data.items.add(new File(['isolated clipboard fixture'], name, { type: 'text/plain' }));
  textarea.focus(); textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  await wait(() => textarea.value.includes(name), 'clipboard file reference missing');
  check(!document.querySelector('.pw-paste-status[role="alert"]'), 'clipboard upload error');
  const first = textarea.value;
  const second = new DataTransfer(); second.items.add(new File(['do not overwrite original'], name, { type: 'text/plain' }));
  textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: second, bubbles: true, cancelable: true }));
  await wait(() => textarea.value.includes('.pasted-'), 'clipboard collision not renamed');
  check(textarea.value.startsWith(first), 'second paste replaced existing draft');
  return { uploaded: name, collisionRenamed: true, existingDraftPreserved: true, draft: textarea.value };
}

export async function idle() {
  guard(); escape(); await frame();
  const counts = { documentQueries: 0, layoutReads: 0 };
  const q = Document.prototype.querySelector, qa = Document.prototype.querySelectorAll, r = Element.prototype.getBoundingClientRect;
  Document.prototype.querySelector = function(...args) { counts.documentQueries++; return q.apply(this, args); };
  Document.prototype.querySelectorAll = function(...args) { counts.documentQueries++; return qa.apply(this, args); };
  Element.prototype.getBoundingClientRect = function(...args) { counts.layoutReads++; return r.apply(this, args); };
  try { await new Promise(resolve => setTimeout(resolve, 2500)); }
  finally { Document.prototype.querySelector = q; Document.prototype.querySelectorAll = qa; Element.prototype.getBoundingClientRect = r; }
  return { durationMs: 2500, ...counts };
}
