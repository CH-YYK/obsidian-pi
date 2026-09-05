import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const view = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");

const BODY_SCOPE = ".note-pi-message-assistant .note-pi-message-body";

/** Return the declaration block of the rule whose selector ends the selector list. */
function ruleBlock(cssText, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cssText.match(new RegExp("(?:^|[},]\\s*)" + escaped + "\\s*\\{([^}]*)\\}", "m"));
  return match?.[1] ?? "";
}

// --- Relative heading scale -------------------------------------------------

test("assistant headings use a compact descending em scale against the response font", () => {
  const expected = { h1: "1.5em", h2: "1.35em", h3: "1.2em", h4: "1.1em", h5: "1em", h6: "0.9em" };
  const sizes = [];
  for (const [tag, size] of Object.entries(expected)) {
    const rule = new RegExp(
      "^" + BODY_SCOPE.replace(/[.]/g, "\\.") + " " + tag + " \\{ font-size: " + size.replace(".", "\\.") + "; \\}$",
      "m"
    );
    assert.match(css, rule, tag + " must be " + size + " relative to the response font");
    sizes.push(parseFloat(size));
  }
  // em only: no scoped heading rule may fall back to the theme's absolute sizes.
  assert.doesNotMatch(css, /note-pi-message-body h[1-6][^{]*\{[^}]*font-size: [^;}]*(px|rem|--font-)/);
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] < sizes[i - 1], "heading scale must strictly descend");
  }
});

test("shared heading rule keeps disciplined margins and line-height", () => {
  const group = new RegExp(
    ["h1", "h2", "h3", "h4", "h5", "h6"]
      .map((tag) => "\\.note-pi-message-assistant \\.note-pi-message-body " + tag)
      .join(",\\s*") +
      " \\{([^}]*)\\}"
  );
  const match = css.match(group);
  assert.ok(match, "expected one grouped rule for h1-h6 under the assistant body scope");
  assert.match(match[1], /margin: 0[.]8em 0 0[.]4em;/);
  assert.match(match[1], /line-height: 1[.]3;/);
  assert.match(match[1], /font-weight: 600;/);
});

test("heading rules are platform-shared, with no mobile-specific override", () => {
  assert.doesNotMatch(css, /[.]note-pi-mobile[^{}]*\bh[1-6]\b/, "mobile must inherit the shared em scale");
  // The body font stays the em basis for the heading scale.
  assert.match(ruleBlock(css, BODY_SCOPE), /font-size: var[(]--note-pi-response-font-size, 14px[)];/);
  // Top-level first heading keeps the existing flush-top reset.
  assert.match(css, /note-pi-message-body > :first-child \{ margin-top: 0; \}/);
});

// --- Copy raw Markdown ------------------------------------------------------

test("copy button is labelled Copy Markdown", () => {
  assert.match(view, /"aria-label": "Copy Markdown"/);
  assert.match(view, /title: "Copy Markdown"/);
  assert.doesNotMatch(view, /"aria-label": "Copy message text"/);
});

test("the view tracks the latest raw Markdown source per message body", () => {
  assert.match(view, /messageSources = new WeakMap<HTMLElement, string>[(][)]/);
  // renderMarkdownInto refreshes the body source on every render, before
  // returning, so restored messages and every stream re-render stay current.
  const method = view.match(
    /renderMarkdownInto[(]body: HTMLElement, markdown: string[^{]*\{([\s\S]*?)return \{ el: body/
  );
  assert.ok(method, "renderMarkdownInto signature changed");
  assert.match(method[1], /this[.]messageSources[.]set[(]body, markdown[)]/);
});

test("copy reads the latest source at click time, not a captured value", () => {
  const handler = view.match(/copy[.]onclick = async [(][)] => \{([\s\S]*?)\};/);
  assert.ok(handler, "copy click handler not found");
  assert.match(
    handler[1],
    /navigator[.]clipboard[.]writeText[(]this[.]messageSources[.]get[(]body[)] [?][?] body[.]innerText[)]/,
    "click handler must read the WeakMap at click time with an innerText fallback"
  );
  // Never copy the addMessage argument captured at creation: streams start
  // with an empty string, so a captured value would freeze the empty text.
  assert.doesNotMatch(handler[1], /writeText[(]\s*text\s*[)]/);
  // Existing success/error affordances are preserved.
  assert.match(handler[1], /setIcon[(]copy, "check"[)]/);
  assert.match(handler[1], /new Notice[(]"Could not copy the message[.]"[)]/);
});

test("live streams feed the latest accumulated Markdown into renderMarkdownInto", () => {
  // The stream entry starts empty; only click-time reads of the WeakMap
  // (updated on every scheduled/final stream render) can copy real content.
  assert.match(view, /addMessage[(]"assistant", ""[)]/);
  const render = view.match(/renderStreamMarkdown[(]final: boolean[)] \{([\s\S]*?)\n  \}/);
  assert.ok(render, "renderStreamMarkdown not found");
  assert.match(render[1], /renderMarkdownInto[(]this[.]streamBody, this[.]streamMarkdown, this[.]streamRender[)]/);
});

test("a failed stream drops the stale partial source before showing error text", () => {
  // When the submit catch path replaces the streamed body with visible error
  // text, it must delete the body's messageSources entry first so Copy
  // Markdown falls back to the visible innerText, not stale partial Markdown.
  const catchBlock = view.match(/\} catch [(]error[)] \{([\s\S]*?)\} finally/);
  assert.ok(catchBlock, "submit catch block not found");
  assert.match(catchBlock[1], /this[.]messageSources[.]delete[(]body[)]/);
  assert.ok(
    catchBlock[1].indexOf("this.messageSources.delete(body)") < catchBlock[1].indexOf("body.setText("),
    "the source entry must be deleted before the error text replaces the body"
  );
});
