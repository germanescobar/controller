import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DestructiveConfirmButton } from "../sidebar.tsx";

function render(loading: boolean): string {
  return renderToStaticMarkup(
    <DestructiveConfirmButton loading={loading} onClick={() => {}} />,
  );
}

test("DestructiveConfirmButton renders a 'Delete' label when not loading", () => {
  const html = render(false);
  assert.match(html, /Delete/);
  assert.doesNotMatch(html, /Deleting/);
  assert.doesNotMatch(html, /animate-spin/);
});

test("DestructiveConfirmButton disables the button while loading", () => {
  const html = render(true);
  // The base-ui Button primitive serializes the `disabled` prop as a
  // `disabled=""` attribute on the rendered <button>. We assert that
  // explicit attribute (and not just any "disabled" substring), because
  // Tailwind's `disabled:opacity-50` class name always ships in the
  // Button's className regardless of state.
  assert.match(html, /\sdisabled=""/);
});

test("DestructiveConfirmButton swaps the label for a spinner and 'Deleting…' while loading", () => {
  const html = render(true);
  assert.match(html, /Deleting/);
  // The spinner is a lucide-react SVG with the animate-spin class.
  assert.match(html, /animate-spin/);
  // The static "Delete" label is hidden while loading.
  assert.doesNotMatch(html, />Delete</);
});

test("DestructiveConfirmButton does not serialize a disabled attribute when not loading", () => {
  const html = render(false);
  // Tailwind's `disabled:opacity-50` className variant is always present,
  // so we only assert the absence of an actual `disabled=""` HTML
  // attribute on the rendered <button>.
  assert.doesNotMatch(html, /\sdisabled=""/);
});
