import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { applyDraftPersistence, MARK } from "../tools/patch-piweb-draft-persist.mjs";

const patchSource = fs.readFileSync(new URL("../tools/patch-piweb-draft-persist.mjs", import.meta.url), "utf8");

// pi-web 0.8.11 产物中 lib/draft-store.ts 编译后的原文（page chunk 截取，含 rekeyDraft）。
// useAgentSession 的 unmount cleanup（原文结构：!mountedRef && !promotedRef -> clearDraft(newSessionDraftKey)）
const ABANDON_CLEANUP = "function pwUnmount(x,s,tx,tc,to){let tv=x?s:null;tv&&queueMicrotask(()=>{tx.current||tc.current||tD(tv)}),null!==to.current&&(to.current=null)}";

const UPSTREAM = ABANDON_CLEANUP + "let tN=new Map;function t$(e){return{value:e.value,images:e.images.map(e=>({...e}))}}function tz(e){return!e.value&&0===e.images.length}function tF(e){let t=tN.get(e);return t?t$(t):null}function tA(e,t){tz(t)?tN.delete(e):tN.set(e,t$(t))}function tD(e){tN.delete(e)}function tB(e,t){return e.trim()?t.trim()?`${e}\n\n${t}`:e:t}function tO(e,t,n,r){let i=[...t??[],...r].filter(tP).slice(0,10).map(({data:e,mimeType:t})=>({data:e,mimeType:t}));return{value:tB(e,n),images:i}}function tH(e,t,n){if(e===t)return n?t$(n):tF(t);let r=tF(e),i=n&&!tz(n)?t$(n):r??(n?t$(n):null),o=tF(t);if(tD(e),!i)return o;let s=o?tO(o.value,o.images,i.value,i.images):i;return tA(t,s),t$(s)}";

const STORAGE_KEY = "pi-web:drafts:v1";
const draft = (value, images = []) => ({ value, images });

function makeStorage(options = {}) {
  const data = new Map();
  return {
    data,
    failAll: Boolean(options.failAll),
    quota: options.quota ?? Infinity,
    getItem(key) {
      if (this.failAll) throw new Error("SecurityError");
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (this.failAll) throw new Error("SecurityError");
      if (String(value).length > this.quota) {
        const error = new Error("QuotaExceededError");
        error.name = "QuotaExceededError";
        throw error;
      }
      data.set(key, String(value));
    },
    removeItem(key) {
      if (this.failAll) throw new Error("SecurityError");
      data.delete(key);
    },
  };
}

// 每次调用 = 一次全新的页面加载（新 window、新内存 Map），storage 是跨加载存活的那一层。
function loadPage(storage, source = applyDraftPersistence(UPSTREAM).out, documentExtras = {}) {
  const listeners = new Map();
  const window = {
    localStorage: storage,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };
  const document = { visibilityState: "visible", querySelectorAll: () => [], ...documentExtras };
  const factory = new Function(
    "window", "document", "tP",
    `${source}\nreturn{get:tF,set:tA,clear:tD,rekey:tH,unmountNewSession:pwUnmount,dump:pwDS._dump,flush:pwDS.f};`,
  );
  const api = factory(window, document, () => true);
  return {
    ...api,
    window,
    document,
    emit(type, event) { (listeners.get(type) ?? []).forEach((fn) => fn(event)); },
    listenerTypes: () => [...listeners.keys()].sort(),
    stored: () => {
      const raw = storage.data.get(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

test("typed text survives a page reload (the actual failure the patch fixes)", () => {
  const storage = makeStorage();
  const first = loadPage(storage);
  first.set("session-1", draft("half written prompt"));
  first.flush();

  const reloaded = loadPage(storage);
  assert.equal(reloaded.get("session-1").value, "half written prompt");
});

test("upstream in-memory store loses the text on reload", () => {
  const storage = makeStorage();
  const first = loadPage(storage, `${UPSTREAM}\nvar pwDS={_dump(){return{}},f(){}};`);
  first.set("session-1", draft("half written prompt"));
  const reloaded = loadPage(storage, `${UPSTREAM}\nvar pwDS={_dump(){return{}},f(){}};`);
  assert.equal(reloaded.get("session-1"), null);
});

test("new-session draft keys are normalised so a reload can still find them", () => {
  const storage = makeStorage();
  const first = loadPage(storage);
  first.set("new:kb-1712345:C:\\work\\proj", draft("prompt typed in a brand new chat"));
  first.flush();

  // AppShell mints a fresh random id on every load, so the raw key never matches twice.
  const reloaded = loadPage(storage);
  assert.equal(reloaded.get("new:kb-9999999:C:\\work\\proj").value, "prompt typed in a brand new chat");
  assert.equal(reloaded.get("new:kb-9999999:D:\\other"), null, "a different cwd must not inherit the draft");
});

test("drafts stay isolated per session across reloads", () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  page.set("session-a", draft("aaa"));
  page.set("session-b", draft("bbb"));
  page.flush();

  const reloaded = loadPage(storage);
  assert.equal(reloaded.get("session-a").value, "aaa");
  assert.equal(reloaded.get("session-b").value, "bbb");
});

test("sent messages are not resurrected: clearDraft wipes the persisted copy immediately", () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  page.set("session-1", draft("about to send"));
  page.flush();
  assert.ok(page.stored().items["session-1"]);

  page.clear("session-1");
  assert.equal(page.stored(), null);
  assert.equal(loadPage(storage).get("session-1"), null);
});

test("emptying the composer clears the persisted draft too", () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  page.set("session-1", draft("typed"));
  page.flush();
  page.set("session-1", draft(""));
  assert.equal(loadPage(storage).get("session-1"), null);
});

test("images stay in memory only; text still survives the reload", () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  const image = { data: "AAAA", mimeType: "image/png" };
  page.set("session-1", draft("caption", [image]));
  page.flush();

  assert.deepEqual(page.get("session-1").images, [image], "same page keeps the attachment");
  assert.equal(storage.data.get(STORAGE_KEY).includes("AAAA"), false, "base64 must never reach localStorage");
  const reloaded = loadPage(storage);
  assert.equal(reloaded.get("session-1").value, "caption");
  assert.deepEqual(reloaded.get("session-1").images, []);
});

test("debounced write lands without an explicit flush", async () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  page.set("session-1", draft("debounced"));
  assert.equal(storage.data.has(STORAGE_KEY), false, "write must not be synchronous on every keystroke");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(page.stored().items["session-1"].t, "debounced");
});

test("pagehide/visibilitychange flush the pending draft (mobile background reclaim path)", () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  assert.deepEqual(page.listenerTypes(), ["beforeunload", "pagehide", "storage", "visibilitychange"]);

  page.set("session-1", draft("typed then backgrounded"));
  assert.equal(storage.data.has(STORAGE_KEY), false);
  page.document.visibilityState = "hidden";
  page.emit("visibilitychange", {});
  assert.equal(page.stored().items["session-1"].t, "typed then backgrounded");
});

test("leaving an unsent new chat keeps the draft (upstream discards it on unmount)", async () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  page.set("new:kb-1:C:\\work", draft("half typed, then went to look at another session"));
  page.flush();

  // isNew=true, never promoted, hook already unmounted — upstream would clearDraft here.
  page.unmountNewSession(true, "new:kb-1:C:\\work", { current: false }, { current: false }, { current: null });
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(page.get("new:kb-1:C:\\work").value, "half typed, then went to look at another session");
  assert.equal(loadPage(storage).get("new:kb-2:C:\\work").value, "half typed, then went to look at another session");
});

test("upstream cleanup would have discarded that draft", async () => {
  const storage = makeStorage();
  const page = loadPage(storage, `${UPSTREAM}\nvar pwDS={_dump(){return{}},f(){}};`);
  page.set("new:kb-1:C:\\work", draft("half typed"));
  page.unmountNewSession(true, "new:kb-1:C:\\work", { current: false }, { current: false }, { current: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(page.get("new:kb-1:C:\\work"), null);
});

test("rekey from provisional key to real session id keeps the text exactly once", () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  const moved = page.rekey("new:kb-1:C:\\work", "session-42", draft("carried over"));
  assert.equal(moved.value, "carried over");
  assert.equal(page.get("session-42").value, "carried over");
  assert.equal(page.get("new:kb-1:C:\\work"), null);
});

test("rekey between two provisional keys of the same cwd must not duplicate the text", () => {
  const page = loadPage(makeStorage());
  page.set("new:kb-1:C:\\work", draft("do not duplicate me"));
  const moved = page.rekey("new:kb-1:C:\\work", "new:kb-2:C:\\work", draft("do not duplicate me"));
  assert.equal(moved.value, "do not duplicate me");
  assert.equal(page.get("new:kb-2:C:\\work").value, "do not duplicate me");
});

test("expired drafts are dropped on hydrate", () => {
  const storage = makeStorage();
  const stale = Date.now() - 15 * 24 * 60 * 60 * 1000;
  storage.data.set(STORAGE_KEY, JSON.stringify({ v: 1, items: { old: { t: "two weeks ago", ts: stale } } }));
  assert.equal(loadPage(storage).get("old"), null);
});

test("corrupt or foreign payloads are ignored instead of throwing", () => {
  for (const payload of ["{not json", JSON.stringify({ v: 99, items: { a: { t: "x", ts: Date.now() } } }), JSON.stringify({ v: 1 })]) {
    const storage = makeStorage();
    storage.data.set(STORAGE_KEY, payload);
    const page = loadPage(storage);
    assert.equal(page.get("a"), null);
    page.set("a", draft("still works"));
    page.flush();
    assert.equal(page.get("a").value, "still works");
  }
});

test("storage failures degrade to the upstream in-memory behaviour instead of breaking typing", () => {
  const storage = makeStorage({ failAll: true });
  const page = loadPage(storage);
  page.set("session-1", draft("typed while storage is blocked"));
  page.flush();
  assert.equal(page.get("session-1").value, "typed while storage is blocked");
  assert.equal(storage.data.size, 0);
});

test("quota pressure sheds oldest drafts and still persists the newest", () => {
  const storage = makeStorage({ quota: 400 });
  const page = loadPage(storage);
  for (let i = 0; i < 12; i += 1) page.set(`session-${i}`, draft(`draft body number ${i}`.repeat(2)));
  page.flush();

  const stored = page.stored();
  assert.ok(stored, "a shrunken payload must still be written");
  const keys = Object.keys(stored.items);
  assert.ok(keys.length < 12 && keys.length > 0, `expected partial retention, got ${keys.length}`);
  assert.ok(keys.includes("session-11"), "the most recently touched draft must win");
});

test("another tab's newer draft is merged without clobbering newer local state", () => {
  const storage = makeStorage();
  const page = loadPage(storage);
  page.set("session-1", draft("local"));
  page.flush();

  const remoteTs = Date.now() + 5000;
  storage.data.set(STORAGE_KEY, JSON.stringify({ v: 1, items: { "session-1": { t: "from other tab", ts: remoteTs } } }));
  page.emit("storage", { key: STORAGE_KEY });
  assert.equal(page.get("session-1").value, "from other tab");

  storage.data.set(STORAGE_KEY, JSON.stringify({ v: 1, items: { "session-1": { t: "stale", ts: 1 } } }));
  page.emit("storage", { key: STORAGE_KEY });
  assert.equal(page.get("session-1").value, "from other tab", "older timestamps must not win");

  page.emit("storage", { key: "unrelated-key" });
  assert.equal(page.get("session-1").value, "from other tab");
});

test("patch is idempotent and fails closed on missing or ambiguous anchors", () => {
  const once = applyDraftPersistence(UPSTREAM);
  assert.equal(once.applied, true);
  assert.ok(once.out.includes(MARK));
  const twice = applyDraftPersistence(once.out);
  assert.equal(twice.applied, false);
  assert.equal(twice.out, once.out);

  assert.throws(() => applyDraftPersistence("nothing to see here", "missing"), /draft-store 锚点命中 0 次/);
  assert.throws(() => applyDraftPersistence(`${UPSTREAM}${UPSTREAM}`, "ambiguous"), /draft-store 锚点命中 2 次/);
  const withoutRekey = UPSTREAM.slice(0, UPSTREAM.indexOf("function tH("));
  assert.throws(() => applyDraftPersistence(withoutRekey, "no-rekey"), /rekeyDraft 锚点命中 0 次/);
});

test("patch keeps the untouched upstream helpers byte-for-byte", () => {
  const { out } = applyDraftPersistence(UPSTREAM);
  for (const helper of [
    "function t$(e){return{value:e.value,images:e.images.map(e=>({...e}))}}",
    "function tz(e){return!e.value&&0===e.images.length}",
    "function tO(e,t,n,r){let i=[...t??[],...r].filter(tP).slice(0,10)",
  ]) {
    assert.ok(out.includes(helper), `helper must survive verbatim: ${helper}`);
  }
});

test("script keeps the deployment guarantees the fold patch established", () => {
  assert.match(patchSource, /if \(pkgJson\.version !== VERSION\) die/, "version lock");
  assert.match(patchSource, /if \(src\.includes\(MARK\)\)/, "reentrancy guard");
  assert.match(patchSource, /if \(fs\.existsSync\(dst\)\) continue;/, "first backup must never be overwritten");
  assert.doesNotMatch(patchSource, /fs\.unlinkSync|fs\.rmSync/, "old chunks must be retained for running processes");
  assert.match(patchSource, /拒绝改名（会 404）/, "rename must fail closed when no reference is found");
  assert.match(patchSource, /\.slice\(0, CUR_HASH\.length\)/, "equal-length rename only");
  assert.match(patchSource, /createHash\("sha1"\)[\s\S]{0,120}\.update\(applyDraftPersistence\.toString\(\)\)/,
    "chunk url must change whenever any injected code changes, not just the runtime");
  assert.match(patchSource, /args\.includes\("--revert"\)/, "one-command rollback");
});

test("restored non-empty drafts re-measure the composer height (first-frame autosize lands on the 200px cap)", () => {
  const storage = makeStorage();
  const seeded = loadPage(storage);
  seeded.set("session-1", draft("restored text"));
  seeded.flush();

  const frames = [];
  global.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  const textarea = { value: "restored text", style: { height: "200px" }, scrollHeight: 24, clientWidth: 640 };
  const untouched = { value: "", style: { height: "" }, scrollHeight: 24, clientWidth: 640 };
  // 后台标签页里 clientWidth 是 0，scrollHeight 是按 1 字符宽折行的垃圾值，量了会把高度钉在上限。
  const unlaidOut = { value: "restored text", style: { height: "200px" }, scrollHeight: 1459, clientWidth: 0 };
  try {
    const reloaded = loadPage(storage, undefined, { querySelectorAll: () => [textarea, untouched, unlaidOut] });
    assert.equal(reloaded.get("session-1").value, "restored text");
    while (frames.length) frames.shift()();
    assert.equal(textarea.style.height, "24px", "height must be recomputed after layout settles");
    assert.equal(untouched.style.height, "", "empty composers must be left alone");
    assert.equal(unlaidOut.style.height, "200px", "unlaid-out composers must not be measured");
  } finally {
    delete global.requestAnimationFrame;
  }
});
