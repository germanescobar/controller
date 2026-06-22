/*
 * In-page scripts the renderer executes against the preview `<webview>`
 * (issue #170).
 *
 * The agent-controlled preview is a guest page in an Electron `<webview>`, so
 * "find an element" means running JS inside that page. The scripts here are
 * the payloads `executeJavaScript` ships across the IPC boundary — they must
 * be self-contained, serializable strings, and they must not depend on any
 * framework on the page. They speak only DOM APIs.
 *
 * Three responsibilities:
 *
 * 1. `buildClickScript` / `buildTypeScript` — resolve a selector (using
 *    locator-style engines: `text=`, `role=`, `label=`, `placeholder=`,
 *    `ref=`, or plain CSS) and perform the action in a single round-trip.
 *    Resolving and acting in the same script keeps the action in sync with
 *    the page state — a separate `lookup` script could match an element that
 *    disappears before the click fires.
 *
 * 2. `buildSnapshotScript` — emit the page as either the existing visible-text
 *    plus interactive-elements listing (default) or a structured accessibility
 *    tree (`--a11y`) where every interesting node carries a stable ref.
 *
 * 3. `parseSelector` — exposed so callers (CLI help text, tests) can recognize
 *    a selector prefix without re-implementing the dispatch table.
 *
 * The accessibility tree is the same source of truth for the refs: each
 * element picked for inclusion gets a sequential ref id (`e1`, `e2`, ...) and
 * a CSS selector the renderer can re-`querySelector` later. The default
 * snapshot mode also emits refs for the elements it lists, so the agent never
 * needs to ask for both.
 */

/** Bound values the action scripts need to do their work. */
export interface ScriptBindings {
  selector: string;
  refs: Record<string, string>;
  /** `type` only. */
  text?: string;
  /** `type` only. */
  submit?: boolean;
}

/** Result shape returned by the action scripts. */
export interface ActionResult {
  ok: boolean;
  engine?: string;
  error?: string;
}

/** Shared JS body for resolving a selector to an element. */
const RESOLVE_BODY = `
    function cssEscape(value){
      if (window.CSS && CSS.escape) return CSS.escape(value);
      return String(value).replace(/(["\\\\\\[\\]\\:\\.\\#\\>\\+\\~\\*\\=\\^\\$\\|\\?\\(\\)])/g, '\\\\$1');
    }
    function visible(el){
      if (!el) return false;
      if (el.nodeType !== 1) return false;
      if (el.disabled) return false;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return true;
    }
    function flatten(root){
      var out = [];
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
      var n;
      while ((n = walker.nextNode())) out.push(n);
      return out;
    }
    function implicitRole(el){
      switch (el.tagName) {
        case 'A': return el.hasAttribute('href') ? 'link' : null;
        case 'BUTTON': return 'button';
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
        case 'IMG': return el.hasAttribute('alt') ? 'img' : null;
        case 'INPUT': {
          var t = (el.getAttribute('type') || 'text').toLowerCase();
          if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'range') return 'slider';
          if (t === 'search') return 'searchbox';
          return 'textbox';
        }
        case 'NAV': return 'navigation';
        case 'SELECT': return 'combobox';
        case 'TEXTAREA': return 'textbox';
        default: return null;
      }
    }
    function byText(query){
      var needle = String(query).trim().toLowerCase();
      if (!needle) return null;
      var exact = null, partial = null;
      var nodes = flatten(document.body);
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        var t = (el.innerText || el.textContent || '').trim();
        if (!t) continue;
        // Skip if this node has a more specific descendant with overlapping
        // text (we want the most specific match).
        var hasDescendant = false;
        for (var j = 0; j < nodes.length; j++) {
          if (nodes[j] === el) continue;
          if (el.contains(nodes[j]) && visible(nodes[j])) {
            var dt = (nodes[j].innerText || nodes[j].textContent || '').trim();
            if (dt && dt.length < t.length && t.toLowerCase().indexOf(dt.toLowerCase()) >= 0) {
              hasDescendant = true; break;
            }
          }
        }
        if (hasDescendant) continue;
        var tl = t.toLowerCase();
        if (tl === needle) { exact = el; break; }
        if (tl.indexOf(needle) >= 0 && !partial) partial = el;
      }
      return exact || partial;
    }
    function byRole(role, name){
      var r = String(role || '').toLowerCase();
      if (!r) return null;
      var matchName = name ? String(name).toLowerCase() : null;
      var nodes = flatten(document.body);
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        var explicit = el.getAttribute('role');
        var implicit = implicitRole(el);
        var actual = (explicit || implicit || '').toLowerCase();
        if (actual !== r) continue;
        if (matchName != null) {
          var n = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().toLowerCase();
          if (n !== matchName) continue;
        }
        return el;
      }
      return null;
    }
    function byLabel(query){
      var needle = String(query).trim().toLowerCase();
      if (!needle) return null;
      var nodes = flatten(document.body);
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        var aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (aria === needle) return el;
        if (el.id) {
          var lab = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
          if (lab && (lab.textContent || '').trim().toLowerCase() === needle) return el;
        }
        if (el.tagName === 'LABEL' && (el.textContent || '').trim().toLowerCase() === needle) {
          var control = el.htmlFor ? document.getElementById(el.htmlFor) : el.querySelector('input,textarea,select');
          if (control && visible(control)) return control;
        }
      }
      return null;
    }
    function byPlaceholder(query){
      var needle = String(query).trim().toLowerCase();
      if (!needle) return null;
      var nodes = flatten(document.body);
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        var p = (el.getAttribute('placeholder') || '').toLowerCase();
        if (p === needle) return el;
      }
      return null;
    }
    function resolve(selector, refs){
      if (selector == null || selector === '') return { ok: false, error: 'empty selector' };
      var raw = String(selector);
      var lower = raw.toLowerCase();
      if (lower.indexOf('text=') === 0) {
        var el = byText(raw.slice(5));
        return el ? { ok: true, engine: 'text', element: el } : { ok: false, engine: 'text', error: 'no element matches' };
      }
      if (lower.indexOf('role=') === 0) {
        var rest = raw.slice(5);
        var m = /^(.+?)\\[name=(["'])(.*?)\\2\\]\\s*$/.exec(rest);
        var role, name;
        if (m) { role = m[1]; name = m[3]; } else { role = rest; }
        var rel = byRole(role, name);
        return rel ? { ok: true, engine: 'role', element: rel } : { ok: false, engine: 'role', error: 'no element matches' };
      }
      if (lower.indexOf('label=') === 0) {
        var ll = byLabel(raw.slice(6));
        return ll ? { ok: true, engine: 'label', element: ll } : { ok: false, engine: 'label', error: 'no element matches' };
      }
      if (lower.indexOf('placeholder=') === 0) {
        var pp = byPlaceholder(raw.slice(12));
        return pp ? { ok: true, engine: 'placeholder', element: pp } : { ok: false, engine: 'placeholder', error: 'no element matches' };
      }
      if (lower.indexOf('ref=') === 0) {
        var id = raw.slice(4);
        var sel = refs && refs[id];
        if (!sel) return { ok: false, engine: 'ref', error: 'unknown ref' };
        var re = document.querySelector(sel);
        return re ? { ok: true, engine: 'ref', element: re } : { ok: false, engine: 'ref', error: 'stale ref' };
      }
      var ce = document.querySelector(raw);
      return ce ? { ok: true, engine: 'css', element: ce } : { ok: false, engine: 'css', error: 'no element matches' };
    }
`;

/**
 * Build a script that resolves `selector` and clicks the result.
 * Returns `{ ok, engine?, error? }`. Resolving and acting in one script keeps
 * the action in sync with the page state.
 */
export function buildClickScript(b: ScriptBindings): string {
  return `(function(selector, refs){
    ${RESOLVE_BODY}
    var r = resolve(selector, refs);
    if (!r.ok) return { ok: false, engine: r.engine, error: r.error };
    r.element.scrollIntoView({ block: 'center', inline: 'center' });
    r.element.click();
    return { ok: true, engine: r.engine };
  })(${JSON.stringify(b.selector)}, ${JSON.stringify(b.refs)})`;
}

/** Build a script that resolves `selector`, focuses it, types `text`, and
 *  optionally submits its form. */
export function buildTypeScript(b: ScriptBindings): string {
  const text = b.text ?? "";
  const submit = Boolean(b.submit);
  return `(function(selector, refs, value, submit){
    ${RESOLVE_BODY}
    var r = resolve(selector, refs);
    if (!r.ok) return { ok: false, engine: r.engine, error: r.error };
    var el = r.element;
    el.focus();
    var proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit && el.form) {
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
    }
    return { ok: true, engine: r.engine };
  })(${JSON.stringify(b.selector)}, ${JSON.stringify(b.refs)}, ${JSON.stringify(text)}, ${JSON.stringify(submit)})`;
}

/**
 * Build the snapshot script. `mode` selects between the text-plus-interactive
 * default and the structured accessibility tree. Both modes return refs.
 */
export function buildSnapshotScript(
  selector: string | undefined,
  mode: "default" | "a11y"
): string {
  return `(function(sel, mode){
    ${SNAPSHOT_BODY}
  })(${JSON.stringify(selector ?? null)}, ${JSON.stringify(mode)})`;
}

/**
 * JS body shared by the snapshot script. Exposed for tests so they can assert
 * the contract without parsing the whole serialised function.
 */
export const SNAPSHOT_BODY = `
    function suggestSelector(el){
      if (el.id) return '#' + el.id;
      var name = el.getAttribute && el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
      var tab = el.getAttribute && el.getAttribute('data-testid');
      if (tab) return '[data-testid="' + tab + '"]';
      // Last-ditch: a structural CSS selector based on tag + a single
      // distinguishing attribute. The renderer re-runs this to resolve refs.
      var role = el.getAttribute && el.getAttribute('role');
      if (role) return '[role="' + role + '"]';
      return el.tagName.toLowerCase();
    }
    function implicitRole(el){
      switch (el.tagName) {
        case 'A': return el.hasAttribute('href') ? 'link' : null;
        case 'BUTTON': return 'button';
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
        case 'IMG': return el.hasAttribute('alt') ? 'img' : null;
        case 'INPUT': {
          var t = (el.getAttribute('type') || 'text').toLowerCase();
          if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'range') return 'slider';
          if (t === 'search') return 'searchbox';
          return 'textbox';
        }
        case 'NAV': return 'navigation';
        case 'SELECT': return 'combobox';
        case 'TEXTAREA': return 'textbox';
        default: return null;
      }
    }
    function accessibleName(el){
      var aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();
      if (el.tagName === 'IMG') {
        var alt = el.getAttribute('alt');
        if (alt && alt.trim()) return alt.trim();
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        var placeholder = el.getAttribute('placeholder');
        if (placeholder && placeholder.trim()) return placeholder.trim();
        var v = el.value;
        if (v && el.getAttribute('type') === 'submit') return v;
      }
      var text = (el.innerText || el.textContent || '').trim();
      return text.length > 80 ? text.slice(0, 80).trim() + '…' : text;
    }
    function visible(el){
      if (!el || el.nodeType !== 1) return false;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return true;
    }
    function collectInteractive(root){
      return Array.prototype.slice.call(
        root.querySelectorAll('a,button,input,textarea,select,[role="button"]')
      );
    }
    var root = sel ? document.querySelector(sel) : document.body;
    if (!root) return { found: false };
    var refs = Object.create(null);
    var counter = 0;
    function refId(){ counter += 1; return 'e' + counter; }
    function record(el){
      var id = refId();
      refs[id] = suggestSelector(el);
      return id;
    }
    if (mode === 'a11y') {
      function walk(el, depth, lines){
        if (!el || el.nodeType !== 1) return;
        // Skip pure-presentation subtrees.
        if (el.getAttribute('aria-hidden') === 'true') return;
        var children = Array.from(el.children);
        var interactive = collectInteractive(el).length > 0;
        var hasText = (el.textContent || '').trim().length > 0;
        if (!interactive && !hasText) {
          children.forEach(function(c){ walk(c, depth, lines); });
          return;
        }
        var role = (el.getAttribute('role') || implicitRole(el) || el.tagName.toLowerCase());
        var name = accessibleName(el);
        var id = record(el);
        var indent = '  '.repeat(depth);
        var label = name ? ' "' + name.replace(/"/g, "'") + '"' : '';
        lines.push(indent + '- ' + role + label + ' [ref=' + id + ']');
        children.forEach(function(c){ walk(c, depth + 1, lines); });
      }
      var lines = [];
      walk(root, 0, lines);
      return { found: true, url: location.href, title: document.title, text: lines.join('\\n'), refs: refs, refCount: counter };
    }
    // Default: visible text + a flat list of interactive elements (with refs).
    var text = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000);
    var nodes = collectInteractive(root).slice(0, 80);
    var interactiveLines = [];
    nodes.forEach(function(el){
      if (!visible(el)) return;
      var s = suggestSelector(el);
      if (!s) return;
      var id = record(el);
      var label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 60);
      interactiveLines.push('- ' + el.tagName.toLowerCase() + ' ' + s + (label ? ' — ' + label : '') + ' [ref=' + id + ']');
    });
    var full = text + (interactiveLines.length ? '\\n\\nInteractive elements:\\n' + interactiveLines.join('\\n') : '');
    return { found: true, url: location.href, title: document.title, text: full, refs: refs, refCount: counter };
  `;

export { parseSelector } from "./selectors.ts";
