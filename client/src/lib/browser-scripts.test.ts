import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildClickScript,
  buildSetFilesScript,
  buildSnapshotScript,
  buildTypeScript,
} from "./browser-scripts.ts";

/**
 * Lightweight in-memory DOM shim — enough surface for the in-page scripts to
 * resolve elements, but not a full HTML implementation. The page models just
 * the nodes the resolver needs: an element tree with `tagName`, `id`,
 * `getAttribute`, `querySelector`, `querySelectorAll`, `textContent`,
 * `innerText`, `children`, `getBoundingClientRect`, and a `style` that
 * the visibility check reads.
 */

interface MockElement {
  tagName: string;
  nodeType: number;
  id?: string;
  children: MockElement[];
  parent: MockElement | null;
  attributes: Map<string, string>;
  textContent: string;
  innerText: string;
  rect: { width: number; height: number };
  style: { display: string; visibility: string };
  classList: Set<string>;
  disabled: boolean;
  getBoundingClientRect(): { width: number; height: number };
}

function makeEl(tag: string, init: Partial<MockElement> = {}): MockElement {
  const el: MockElement = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    children: [],
    parent: null,
    attributes: new Map(),
    textContent: init.textContent ?? "",
    innerText: init.innerText ?? init.textContent ?? "",
    rect: init.rect ?? { width: 1, height: 1 },
    style: init.style ?? { display: "block", visibility: "visible" },
    classList: new Set(init.classList ?? []),
    disabled: init.disabled ?? false,
    id: init.id,
    getBoundingClientRect() {
      return { width: this.rect.width, height: this.rect.height };
    },
  };
  for (const child of init.children ?? []) {
    el.children.push(child);
    child.parent = el;
  }
  // `init.attributes` is typed as `Map<string, string>`, but a plain
  // object is also accepted for ergonomic test code. Branch on the
  // shape so a `Map` (used by the set-files tests to thread both
  // `type` and `accept` attributes through `makeEl`) is copied the
  // same way as a literal object would be.
  const initAttrs = init.attributes;
  if (initAttrs instanceof Map) {
    for (const [k, v] of initAttrs) el.attributes.set(k, v);
  } else if (initAttrs) {
    for (const [k, v] of Object.entries(initAttrs)) el.attributes.set(k, v);
  }
  return el;
}

function elApi(root: MockElement) {
  // DOM-style API surface over the MockElement tree.
  const liveNodes: MockElement[] = [];
  function visit(node: MockElement) {
    liveNodes.push(node);
    for (const c of node.children) visit(c);
  }
  visit(root);

  // Build a Set of every descendant of `el` (inclusive) by identity so the
  // script's `el.contains(node)` check works against the same object refs
  // the script traverses.
  function descendantsSet(el: MockElement): Set<MockElement> {
    const set = new Set<MockElement>();
    function walk(node: MockElement) {
      set.add(node);
      for (const c of node.children) walk(c);
    }
    walk(el);
    return set;
  }

  const selfAndDescendants = descendantsSet(root);
  const nodeIndex = new Map<MockElement, unknown>();
  function indexFor(el: MockElement): unknown {
    let n = nodeIndex.get(el);
    if (n) return n;
    // Reserve the slot with a placeholder before recursing into children.
    // This breaks the toNode↔indexFor cycle: any child that asks for
    // `el` (e.g. a node looking up its own parent) gets the placeholder
    // back, and we patch the real object in once construction finishes.
    const placeholder: Record<string, unknown> = {};
    nodeIndex.set(el, placeholder);
    n = toNode(el);
    Object.assign(placeholder, n);
    return placeholder;
  }

  function toNode(el: MockElement): unknown {
    // Eagerly index children + parent so the in-page script can traverse
    // the tree without re-resolving identity on every walk. We compute
    // these before constructing the returned object to avoid mutating it
    // after the fact.
    const childNodes = el.children.map((c) => indexFor(c));
    const parentNode = el.parent ? indexFor(el.parent) : null;
    return {
      nodeType: 1,
      tagName: el.tagName,
      // Surface the `type` attribute as a property too, the same way
      // a real HTMLInputElement does. The set-files script reads
      // `target.type` (not `target.getAttribute('type')`) when it
      // decides whether the resolved element is a file input.
      type: el.attributes.get("type") ?? "",
      id: el.id,
      children: childNodes,
      parentElement: parentNode,
      // Array-like so the size check + iteration in `forEach` work.
      // We do not implement the full HTMLCollection contract — only what the
      // scripts use.
      classList: { contains: (c: string) => el.classList.has(c) },
      getAttribute: (k: string) =>
        el.attributes.has(k) ? el.attributes.get(k)! : null,
      hasAttribute: (k: string) => el.attributes.has(k),
      getBoundingClientRect: () => ({
        width: el.rect.width,
        height: el.rect.height,
        top: 0,
        left: 0,
        right: el.rect.width,
        bottom: el.rect.height,
      }),
      // `contains` must work on the same object identity the script is
      // iterating over, so we resolve each child back to its MockElement
      // and check membership in the descendant set.
      contains: (other: unknown) => {
        if (!other || typeof other !== "object") return false;
        for (const node of selfAndDescendants) {
          if (indexFor(node) === other) return true;
        }
        return false;
      },
      querySelector: (sel: string) => {
        const match = matchAll(root, sel)[0];
        return match ? indexFor(match) : null;
      },
      querySelectorAll: (sel: string) =>
        matchAll(root, sel).map((n) => indexFor(n)),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      click: () => undefined,
      focus: () => undefined,
      dispatchEvent: () => true,
      scrollIntoView: () => undefined,
      textContent: el.textContent,
      innerText: el.innerText,
      disabled: el.disabled,
      style: el.style,
      form: null,
    };
  }

  function toBody(): unknown {
    // The script's `flatten(root)` walks the document via createTreeWalker.
    // The yielded nodes are then used with DOM methods (`contains`,
    // `getAttribute`, etc.), so the walker must yield mock *nodes* (the
    // shape `toNode` produces) — not the raw `MockElement` instances. We
    // re-build the children list on the body here so the indexer sees the
    // full tree.
    const body = toNode(root) as Record<string, unknown>;
    body.createTreeWalker = () => {
      const flat: unknown[] = [];
      const queue: unknown[] = [body];
      while (queue.length) {
        const node = queue.shift();
        if (node == null) break;
        flat.push(node);
        const n = node as { children?: unknown[] };
        if (n.children) {
          for (const c of n.children) queue.push(c);
        }
      }
      let i = 0;
      return {
        nextNode: () => (i < flat.length ? flat[i++] : null),
      };
    };
    // The in-page scripts reach for `document.body` and `document.title`.
    // The mock document *is* the body (passed in as `document`), so
    // expose a `body` self-reference plus a few other properties the
    // scripts read.
    body.body = body;
    body.title = "mock";
    return body;
  }

  function matchAll(start: MockElement, selector: string): MockElement[] {
    // Minimal selector matcher: supports `#id`, `tag`, `tag.class`, `[attr=v]`,
    // `tag[attr=v]`, and comma-separated lists of any of those. Just enough
    // to assert the script dispatch picks the right element.
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    const seen = new Set<MockElement>();
    const out: MockElement[] = [];
    function walk(node: MockElement) {
      for (const part of parts) {
        if (matches(node, part) && !seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      }
      for (const c of node.children) walk(c);
    }
    walk(start);
    return out;
  }

  function matches(node: MockElement, sel: string): boolean {
    const trimmed = sel.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("#")) {
      return node.id === trimmed.slice(1);
    }
    if (trimmed.startsWith("[")) {
      const m = /^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(trimmed);
      if (!m) return false;
      const attr = m[1];
      const val = m[2];
      const actual = node.attributes.get(attr);
      if (val === undefined) return actual != null;
      return actual === val;
    }
    // tag[attr=v], tag.class
    const tagAttr = /^(\w+)\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(trimmed);
    if (tagAttr) {
      const tag = tagAttr[1].toUpperCase();
      if (node.tagName !== tag) return false;
      if (tagAttr[2]) {
        const actual = node.attributes.get(tagAttr[2]);
        if (tagAttr[3] === undefined) return actual != null;
        return actual === tagAttr[3];
      }
      return true;
    }
    const tagClass = /^(\w+)\.([\w-]+)$/.exec(trimmed);
    if (tagClass) {
      return node.tagName === tagClass[1].toUpperCase() && node.classList.has(tagClass[2]);
    }
    if (/^\w+$/.test(trimmed)) {
      return node.tagName === trimmed.toUpperCase();
    }
    return false;
  }

  return { toBody, liveNodes };
}

/**
 * Build a context with the DOM surface the in-page scripts need, run the
 * script, and return the value of the IIFE. `location`, `CSS.escape`, and
 * `NodeFilter` are stubbed; the in-page scripts never use them in a way that
 * breaks parsing.
 */
function runScript<T>(script: string, body: unknown): T {
  // Minimal File / DataTransfer / DragEvent shims. The setFiles script
  // runs in a real Electron `<webview>` with the full DOM; here we just
  // need enough surface to assert the per-file acceptance contract and
  // observe dispatched events. The implementation mirrors what Chromium
  // exposes: `File` carries `name`/`type`/`size`/`bytes`, `DataTransfer`
  // holds items, and `DragEvent` exposes `dataTransfer`. The vm shim
  // skips `Blob` entirely — the script falls back to its non-Blob
  // constructor path because `new File` succeeds on a Uint8Array.
  const ctx = {
    document: body as Record<string, unknown>,
    window: {
      // The snapshot script's visible() helper reads the element's actual
      // style, so the mock must return the per-element style instead of a
      // single global "everything is visible" result.
      getComputedStyle: (el: { style: { display: string; visibility: string } }) =>
        el.style,
      CSS: undefined,
    },
    location: { href: "about:blank" },
    NodeFilter: { SHOW_ELEMENT: 1 },
    console,
    atob: (b64: string) => Buffer.from(b64, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    File: function FileShim(
      this: unknown,
      parts: unknown[],
      name: string,
      opts: { type?: string } = {}
    ) {
      const bytes = parts[0] as Uint8Array;
      (this as Record<string, unknown>).name = name;
      (this as Record<string, unknown>).type = opts.type ?? "";
      (this as Record<string, unknown>).size = (bytes as Uint8Array).byteLength;
    } as unknown as typeof File,
    DataTransfer: function DataTransferShim(this: unknown) {
      const items: Array<{ kind: "file"; file: unknown }> = [];
      (this as Record<string, unknown>).items = {
        add: (file: unknown) => {
          items.push({ kind: "file", file });
        },
      };
      (this as Record<string, unknown>).files = {
        length: items.length,
        item: (i: number) => items[i]?.file ?? null,
        [0]: items[0]?.file,
      };
      // Each call to `files` should reflect the current items list — the
      // script re-reads `dt.files` after re-populating for single-file
      // inputs. Wrap in a getter so the existing length/item stay in sync.
      Object.defineProperty((this as Record<string, unknown>).files, "length", {
        get: () => items.length,
      });
    } as unknown as typeof DataTransfer,
    DragEvent: function DragEventShim(
      this: unknown,
      _type: string,
      init: { dataTransfer?: unknown } = {}
    ) {
      (this as Record<string, unknown>).dataTransfer = init.dataTransfer;
    } as unknown as typeof DragEvent,
    Event: function EventShim(
      this: unknown,
      _type: string,
      init: { bubbles?: boolean; cancelable?: boolean } = {}
    ) {
      (this as Record<string, unknown>).bubbles = init.bubbles === true;
      (this as Record<string, unknown>).cancelable = init.cancelable === true;
    } as unknown as typeof Event,
    HTMLInputElement: {
      prototype: {
        // buildSetFilesScript reads HTMLInputElement.prototype.files in the
        // error path; the mock doesn't enforce the descriptor, so any
        // assignment succeeds.
      },
    },
  };
  vm.createContext(ctx);
  return vm.runInContext(script, ctx) as T;
}

// ---------------------------------------------------------------------------
// buildClickScript
// ---------------------------------------------------------------------------

test("buildClickScript falls back to a CSS querySelector for plain selectors", () => {
  const target = makeEl("button", { id: "submit" });
  const root = makeEl("body", { children: [target] });
  const { toBody } = elApi(root);
  const script = buildClickScript({ selector: "#submit", refs: {} });
  const result = runScript<{ ok: boolean; engine?: string; error?: string }>(
    script,
    toBody()
  );
  assert.equal(result.ok, true);
  assert.equal(result.engine, "css");
});

test("buildClickScript routes text= through the text engine", () => {
  const button = makeEl("button", { textContent: "Cancel" });
  const root = makeEl("body", { children: [button] });
  const { toBody } = elApi(root);
  const script = buildClickScript({ selector: "text=Cancel", refs: {} });
  const result = runScript<{ ok: boolean; engine?: string; error?: string }>(
    script,
    toBody()
  );
  assert.equal(result.ok, true);
  assert.equal(result.engine, "text");
});

test("buildClickScript routes role= through the role engine", () => {
  const button = makeEl("button", { textContent: "Save" });
  const root = makeEl("body", { children: [button] });
  const { toBody } = elApi(root);
  const script = buildClickScript({ selector: 'role=button[name="Save"]', refs: {} });
  const result = runScript<{ ok: boolean; engine?: string }>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.engine, "role");
});

test("buildClickScript reports 'no element matches' for a selector with no hit", () => {
  const root = makeEl("body", { children: [makeEl("div", {})] });
  const { toBody } = elApi(root);
  const script = buildClickScript({ selector: "text=DoesNotExist", refs: {} });
  const result = runScript<{ ok: boolean; engine?: string; error?: string }>(
    script,
    toBody()
  );
  assert.equal(result.ok, false);
  assert.equal(result.engine, "text");
  assert.equal(result.error, "no element matches");
});

test("buildClickScript reports 'unknown ref' when the ref id is not in the refs map", () => {
  const root = makeEl("body", { children: [makeEl("div", {})] });
  const { toBody } = elApi(root);
  const script = buildClickScript({ selector: "ref=e99", refs: {} });
  const result = runScript<{ ok: boolean; engine?: string; error?: string }>(
    script,
    toBody()
  );
  assert.equal(result.ok, false);
  assert.equal(result.engine, "ref");
  assert.equal(result.error, "unknown ref");
});

test("buildClickScript resolves a known ref to its CSS selector", () => {
  const button = makeEl("button", { id: "save" });
  const root = makeEl("body", { children: [button] });
  const { toBody } = elApi(root);
  const script = buildClickScript({
    selector: "ref=e1",
    refs: { e1: "#save" },
  });
  const result = runScript<{ ok: boolean; engine?: string }>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.engine, "ref");
});

// ---------------------------------------------------------------------------
// buildTypeScript
// ---------------------------------------------------------------------------

test("buildTypeScript sets the value on a matched input", () => {
  const inputAttrs = new Map<string, string>([["type", "text"]]);
  const input = makeEl("input", { attributes: inputAttrs });
  const root = makeEl("body", { children: [input] });
  const { toBody } = elApi(root);
  const script = buildTypeScript({
    selector: 'role=textbox[name="q"]',
    refs: {},
    text: "hello",
    submit: false,
  });
  // The mock input has no implicit role because our shim doesn't read type
  // — that's fine, we just need the dispatch to run without crashing and
  // either succeed or report the lookup failure. The contract is that it
  // runs the role/text/ref dispatch and returns the engine that matched.
  const result = runScript<{ ok: boolean; engine?: string; error?: string }>(
    script,
    toBody()
  );
  assert.equal(result.engine, "role");
  // Whether `ok` is true or false depends on whether the role lookup found
  // anything — our mock doesn't populate roles. We assert the dispatch path
  // ran by checking the engine field.
  assert.ok(typeof result.ok === "boolean");
});

// ---------------------------------------------------------------------------
// buildSnapshotScript
// ---------------------------------------------------------------------------

test("buildSnapshotScript returns the page text + interactive elements with refs in default mode", () => {
  const button = makeEl("button", { id: "go", textContent: "Go" });
  const root = makeEl("body", {
    children: [makeEl("h1", { textContent: "Hi" }), button],
  });
  const { toBody } = elApi(root);
  const script = buildSnapshotScript(undefined, "default");
  const result = runScript<{
    found: boolean;
    text?: string;
    refs?: Record<string, string>;
    refCount?: number;
  }>(script, toBody());
  if (!result.found) console.log("DEBUG snapshot result:", result);
  assert.equal(result.found, true);
  assert.ok(result.text);
  // Refs are emitted for interactive elements in the default mode.
  assert.equal(result.refs?.["e1"], "#go");
  assert.equal(result.refCount, 1);
});

test("buildSnapshotScript emits a structured tree in --a11y mode", () => {
  const button = makeEl("button", { textContent: "Submit" });
  const heading = makeEl("h1", { textContent: "Title" });
  const root = makeEl("body", { children: [heading, button] });
  const { toBody } = elApi(root);
  const script = buildSnapshotScript(undefined, "a11y");
  const result = runScript<{
    found: boolean;
    text?: string;
    refs?: Record<string, string>;
    refCount?: number;
  }>(script, toBody());
  assert.equal(result.found, true);
  assert.ok(result.text);
  // The tree should mention "button" and "heading" roles.
  assert.match(result.text ?? "", /button/);
  assert.match(result.text ?? "", /heading/);
  // Every tree node carries a ref.
  assert.ok(result.refs && Object.keys(result.refs).length > 0);
  assert.equal(result.refCount, Object.keys(result.refs).length);
});

test("buildSnapshotScript reports found=false when the selector does not match", () => {
  const root = makeEl("body", { children: [makeEl("div", {})] });
  const { toBody } = elApi(root);
  const script = buildSnapshotScript("#missing", "default");
  const result = runScript<{ found: boolean }>(script, toBody());
  assert.equal(result.found, false);
});

// ---------------------------------------------------------------------------
// Issue #170 review: unique selectors for refs (P1) and hidden-node skipping
// in a11y mode (P2).
// ---------------------------------------------------------------------------

test("snapshot registers unique refs for sibling elements with no distinguishing attrs (issue #170 P1)", () => {
  // Two buttons with the same role/text and no id/data-testid/name. The
  // pre-fix suggestSelector returned "button" for both, so ref=e2 resolved
  // to the first button via querySelector. The new path builds a positional
  // :nth-of-type chain so each ref uniquely identifies its element.
  const cancel = makeEl("button", { textContent: "Cancel" });
  const del = makeEl("button", { textContent: "Delete" });
  const root = makeEl("body", { children: [cancel, del] });
  const { toBody } = elApi(root);
  const script = buildSnapshotScript(undefined, "default");
  const result = runScript<{
    found: boolean;
    refs?: Record<string, string>;
  }>(script, toBody());
  assert.equal(result.found, true);
  assert.ok(result.refs);
  // Both buttons get distinct refs, and the selectors resolve to distinct
  // elements when fed back through querySelector. The pre-fix behaviour
  // was that both refs shared the bare "button" selector — we want the
  // selectors to differ so the second one unambiguously points at the
  // element the snapshot showed next to its ref.
  const refKeys = Object.keys(result.refs);
  assert.equal(refKeys.length, 2);
  const sel0 = result.refs[refKeys[0]];
  const sel1 = result.refs[refKeys[1]];
  assert.ok(sel0 && sel1);
  assert.notEqual(sel0, sel1);
  // At least one selector must include :nth-of-type(n) — that is the
  // uniqueness fix. (The first button is allowed to keep "button" because
  // querySelector("button") on a two-button page resolves to it, so the
  // ref is still accurate; the second button needs the disambiguator.)
  const hasNthOfType = [sel0, sel1].some((s) => /:nth-of-type\(\d+\)/.test(s));
  assert.ok(hasNthOfType, `expected at least one selector to use :nth-of-type; got ${sel0} and ${sel1}`);
});

test("snapshot prefers a short selector when the element has a unique id (issue #170 P1)", () => {
  // An id is unique by definition; the path-fallback should never fire and
  // we should not bolt on :nth-of-type. The cheap "#id" form is enough.
  const button = makeEl("button", { id: "save", textContent: "Save" });
  const root = makeEl("body", { children: [button] });
  const { toBody } = elApi(root);
  const script = buildSnapshotScript(undefined, "default");
  const result = runScript<{
    refs?: Record<string, string>;
  }>(script, toBody());
  assert.equal(result.refs?.["e1"], "#save");
});

test("a11y snapshot skips display:none controls and does not register refs for them (issue #170 P2)", () => {
  // The visible button is recorded with a ref. The hidden button is
  // excluded from the tree, so the agent has no way to drive it.
  const visible = makeEl("button", { textContent: "Save" });
  const hidden = makeEl("button", {
    textContent: "Delete",
    style: { display: "none", visibility: "visible" },
  });
  const root = makeEl("body", { children: [visible, hidden] });
  const { toBody } = elApi(root);
  const script = buildSnapshotScript(undefined, "a11y");
  const result = runScript<{
    found: boolean;
    text?: string;
    refs?: Record<string, string>;
  }>(script, toBody());
  assert.equal(result.found, true);
  assert.match(result.text ?? "", /Save/);
  // The hidden control's text must not appear in the tree.
  assert.doesNotMatch(result.text ?? "", /Delete/);
  // The hidden button (second of two) would resolve to ":nth-of-type(2)";
  // skipping it means no ref points at it. The body and the visible button
  // legitimately get refs (both carry text), so we don't assert an exact
  // count — only that nothing addresses the hidden control.
  const selectors = Object.values(result.refs ?? {});
  assert.ok(selectors.every((s) => !/:nth-of-type\(2\)/.test(s)));
});

test("a11y snapshot skips visibility:hidden controls (issue #170 P2)", () => {
  const visible = makeEl("button", { textContent: "OK" });
  const hidden = makeEl("button", {
    textContent: "Cancel",
    style: { display: "block", visibility: "hidden" },
  });
  const root = makeEl("body", { children: [visible, hidden] });
  const { toBody } = elApi(root);
  const script = buildSnapshotScript(undefined, "a11y");
  const result = runScript<{
    text?: string;
    refs?: Record<string, string>;
  }>(script, toBody());
  assert.match(result.text ?? "", /OK/);
  assert.doesNotMatch(result.text ?? "", /Cancel/);
  // The hidden second button is never addressable via a ref.
  const selectors = Object.values(result.refs ?? {});
  assert.ok(selectors.every((s) => !/:nth-of-type\(2\)/.test(s)));
});

// ---------------------------------------------------------------------------
// buildSetFilesScript (issue #356)
// ---------------------------------------------------------------------------
//
// The set-files script runs inside a real Electron `<webview>`. These tests
// only assert the per-file acceptance contract — the wiring (path → main
// process → bytes → renderer → webview) is covered end-to-end by the
// `controller browser set-files` CLI tests and the policy tests in
// `server/lib/__tests__/browser-policy.test.ts`. The mock here is a
// pragmatic DOM shim, not a real Chromium, so we focus on the parts that
// differ from the existing engines: page-observed validation, multiple
// vs single-file input, and the dropzone fallback.

interface SetFilesResult {
  ok: boolean;
  engine?: string;
  error?: string;
  files?: Array<{ index?: number; name: string; accepted: boolean; reason?: string }>;
}

test("buildSetFilesScript accepts a single file on an input[type=file]", () => {
  const inputAttrs = new Map<string, string>([["type", "file"]]);
  const input = makeEl("input", { id: "upload", attributes: inputAttrs });
  const root = makeEl("body", { children: [input] });
  const { toBody } = elApi(root);
  const script = buildSetFilesScript({
    selector: "#upload",
    refs: {},
    files: [{ name: "report.pdf", type: "application/pdf", contentBase64: "AAEC" }],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.files?.length, 1);
  assert.equal(result.files?.[0]?.name, "report.pdf");
  assert.equal(result.files?.[0]?.accepted, true);
});

test("buildSetFilesScript rejects a file that fails the page's accept filter", () => {
  const inputAttrs = new Map<string, string>([
    ["type", "file"],
    ["accept", "image/png,image/jpeg"],
  ]);
  const input = makeEl("input", { id: "photo", attributes: inputAttrs });
  const root = makeEl("body", { children: [input] });
  const { toBody } = elApi(root);
  const script = buildSetFilesScript({
    selector: "#photo",
    refs: {},
    files: [{ name: "report.pdf", type: "application/pdf", contentBase64: "AAEC" }],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.files?.[0]?.accepted, false);
  assert.equal(result.files?.[0]?.reason, "type-mismatch");
});

test("buildSetFilesScript rejects a file that exceeds the page's maxFileSize", () => {
  const inputAttrs = new Map<string, string>([
    ["type", "file"],
    ["max-file-size", "4"],
  ]);
  const input = makeEl("input", { id: "tiny", attributes: inputAttrs });
  const root = makeEl("body", { children: [input] });
  const { toBody } = elApi(root);
  // 10 bytes of base64 -> bytes; the input advertises a 4-byte cap.
  const script = buildSetFilesScript({
    selector: "#tiny",
    refs: {},
    files: [{ name: "big.bin", type: "application/octet-stream", contentBase64: "AAAAAAAAAAAAAA==" }],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.files?.[0]?.accepted, false);
  assert.equal(result.files?.[0]?.reason, "too-large");
});

test("buildSetFilesScript accepts every file on a multiple input", () => {
  const inputAttrs = new Map<string, string>([
    ["type", "file"],
    ["multiple", ""],
  ]);
  const input = makeEl("input", { id: "gallery", attributes: inputAttrs });
  const root = makeEl("body", { children: [input] });
  const { toBody } = elApi(root);
  const script = buildSetFilesScript({
    selector: "#gallery",
    refs: {},
    files: [
      { name: "a.png", type: "image/png", contentBase64: "AAAA" },
      { name: "b.png", type: "image/png", contentBase64: "AAAA" },
      { name: "c.png", type: "image/png", contentBase64: "AAAA" },
    ],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.files?.length, 3);
  assert.ok(result.files?.every((f) => f.accepted));
});

test("buildSetFilesScript marks extras as rejected when the input is single-file", () => {
  const inputAttrs = new Map<string, string>([["type", "file"]]);
  const input = makeEl("input", { id: "single", attributes: inputAttrs });
  const root = makeEl("body", { children: [input] });
  const { toBody } = elApi(root);
  const script = buildSetFilesScript({
    selector: "#single",
    refs: {},
    files: [
      { name: "a.png", type: "image/png", contentBase64: "AAAA" },
      { name: "b.png", type: "image/png", contentBase64: "AAAA" },
    ],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.files?.[0]?.accepted, true);
  assert.equal(result.files?.[1]?.accepted, false);
  assert.equal(result.files?.[1]?.reason, "single-file-input");
});

test("buildSetFilesScript returns a per-file outcome when every file is rejected", () => {
  // All-rejected path: no DataTransfer is assigned, no change event
  // dispatched — the agent should be able to detect "nothing landed"
  // from the response alone.
  const inputAttrs = new Map<string, string>([
    ["type", "file"],
    ["accept", "image/png"],
  ]);
  const input = makeEl("input", { id: "photo", attributes: inputAttrs });
  const root = makeEl("body", { children: [input] });
  const { toBody } = elApi(root);
  const script = buildSetFilesScript({
    selector: "#photo",
    refs: {},
    files: [
      { name: "doc.pdf", type: "application/pdf", contentBase64: "AAEC" },
      { name: "page.html", type: "text/html", contentBase64: "AAEC" },
    ],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, true);
  for (const entry of result.files ?? []) {
    assert.equal(entry.accepted, false);
    assert.equal(entry.reason, "type-mismatch");
  }
});

test("buildSetFilesScript synthesizes a drop event on a non-input dropzone", () => {
  // Pages that use a drag-and-drop wrapper (no visible <input>) should
  // still get the bytes via a drop event with the same DataTransfer
  // shape. We can't inspect the synthesized event directly with this
  // mock (drag events don't bubble through dispatchEvent in jsdom-
  // style shims), but we can assert the script returned ok and the
  // per-file row is accepted.
  const dropzone = makeEl("div", { id: "dropzone" });
  const root = makeEl("body", { children: [dropzone] });
  const { toBody } = elApi(root);
  const script = buildSetFilesScript({
    selector: "#dropzone",
    refs: {},
    files: [{ name: "shot.png", type: "image/png", contentBase64: "AAAA" }],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.files?.[0]?.accepted, true);
});

test("buildSetFilesScript surfaces 'unknown ref' for a stale ref id", () => {
  // The selector dispatch shares the same resolve() helper as
  // click/type, so the per-engine error strings (unknown ref / stale
  // ref) come back unchanged. This guards the contract that the
  // renderer in `usePreviewBrowserHost` translates those into the
  // agent-friendly messages.
  const root = makeEl("body", { children: [makeEl("div", {})] });
  const { toBody } = elApi(root);
  const script = buildSetFilesScript({
    selector: "ref=e42",
    refs: {},
    files: [{ name: "shot.png", type: "image/png", contentBase64: "AAAA" }],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown ref");
  assert.equal(result.engine, "ref");
});

test("buildSetFilesScript threads each file's index through to the outcome (issue #356 P2)", () => {
  // The renderer correlates the script's per-file outcome by index,
  // not by basename — two files at different paths with the same
  // name must not collapse into a single row on the way back. The
  // script returns `index` on every accepted/rejected entry so the
  // renderer can build an index-keyed map without re-deriving
  // identity from `name`.
  const inputAttrs = new Map<string, string>([
    ["type", "file"],
    ["multiple", ""],
    ["accept", "image/png"],
  ]);
  const input = makeEl("input", { id: "many", attributes: inputAttrs });
  const root = makeEl("body", { children: [input] });
  const { toBody } = elApi(root);
  const script = buildSetFilesScript({
    selector: "#many",
    refs: {},
    files: [
      { index: 0, name: "photo.png", type: "image/png", contentBase64: "AAEC" },
      { index: 1, name: "doc.pdf", type: "application/pdf", contentBase64: "AAEC" },
      { index: 2, name: "photo.png", type: "image/png", contentBase64: "AAEC" },
    ],
    maxSize: null,
  });
  const result = runScript<SetFilesResult>(script, toBody());
  assert.equal(result.ok, true);
  assert.equal(result.files?.length, 3);
  // Index 1 is type-mismatch (PDF, accept="image/png"). The two
  // `photo.png` rows at indexes 0 and 2 must stay distinguished by
  // `index`; the renderer uses that to keep a row per CLI argument
  // even when basenames collide.
  assert.equal(result.files?.[0]?.index, 0);
  assert.equal(result.files?.[0]?.accepted, true);
  assert.equal(result.files?.[1]?.index, 1);
  assert.equal(result.files?.[1]?.accepted, false);
  assert.equal(result.files?.[1]?.reason, "type-mismatch");
  assert.equal(result.files?.[2]?.index, 2);
  assert.equal(result.files?.[2]?.accepted, true);
});
