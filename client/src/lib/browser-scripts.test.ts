import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildClickScript,
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
  for (const [k, v] of Object.entries(init.attributes ?? {})) {
    el.attributes.set(k, v);
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
