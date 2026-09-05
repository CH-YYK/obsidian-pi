import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RESPONSE_FONT_SIZE_DEFAULT,
  RESPONSE_FONT_SIZE_MAX,
  RESPONSE_FONT_SIZE_MIN,
  normalizeResponseFontSize
} from "../src/shared/response-font-size.mjs";

test("response font size defaults to 14px within the 12-20 range", () => {
  assert.equal(RESPONSE_FONT_SIZE_DEFAULT, 14);
  assert.equal(RESPONSE_FONT_SIZE_MIN, 12);
  assert.equal(RESPONSE_FONT_SIZE_MAX, 20);
});

test("normalizeResponseFontSize clamps and sanitizes stored values", () => {
  assert.equal(normalizeResponseFontSize(14), 14);
  assert.equal(normalizeResponseFontSize(12), 12);
  assert.equal(normalizeResponseFontSize(20), 20);
  assert.equal(normalizeResponseFontSize(8), 12);
  assert.equal(normalizeResponseFontSize(99), 20);
  assert.equal(normalizeResponseFontSize(15.6), 16);
  assert.equal(normalizeResponseFontSize(undefined), 14);
  assert.equal(normalizeResponseFontSize(null), 14);
  assert.equal(normalizeResponseFontSize(Number.NaN), 14);
  assert.equal(normalizeResponseFontSize("18"), 14);
});

test("settings tab exposes the slider only through the optional host methods", async () => {
  const source = await readFile(new URL("../src/settings.ts", import.meta.url), "utf8");

  assert.match(source, /responseFontSize[?][(][)]: number/);
  assert.match(source, /setResponseFontSize[?][(]size: number[)]: Promise<void>/);
  assert.match(source, /name: "Response font size"/);
  assert.match(source, /type: "slider" as const/);
  assert.match(source, /key: "response-font-size"/);
  assert.match(source, /min: RESPONSE_FONT_SIZE_MIN/);
  assert.match(source, /max: RESPONSE_FONT_SIZE_MAX/);
  assert.match(source, /step: 1/);
  assert.match(source, /displayFormat: [(]value: number[)] => /);
  // The General tab must stay available when only the font-size host exists.
  assert.match(source, /typeof this[.]plugin[.]responseFontSize === "function" && typeof this[.]plugin[.]setResponseFontSize === "function"/);
});

test("plugin persists a normalized responseFontSize and refreshes open views", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

  assert.match(source, /responseFontSize: number/);
  assert.match(source, /responseFontSize: RESPONSE_FONT_SIZE_DEFAULT/);
  assert.match(source, /const responseFontSize = normalizeResponseFontSize[(]savedConfiguration[.]responseFontSize[)]/);
  assert.match(source, /this[.]settings[.]responseFontSize = normalizeResponseFontSize[(]size[)]/);
  assert.match(source, /getLeavesOfType[(]VIEW_TYPE_NOTE_PI[)]/);
  assert.match(source, /view[.]applyResponseFontSize[(][)]/);
});

test("view applies the size as a scoped CSS variable on its own element", async () => {
  const source = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");

  assert.match(source, /applyResponseFontSize[(][)]/);
  assert.match(source, /this[.]viewPrefs[?][.]responseFontSize[?][.][(][)]/);
  assert.match(source, /this[.]contentEl[.]style[.]setProperty[(]"--note-pi-response-font-size"/);
  // No global document/body variable.
  assert.doesNotMatch(source, /document[.](body|documentElement)[.]style/);
});

test("only assistant message bodies consume the response font size", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(css, /[.]note-pi-message-assistant [.]note-pi-message-body {[^}]*font-size: var[(]--note-pi-response-font-size, 14px[)]/s);
  const userCard = css.match(/[.]note-pi-user-text {[^}]*}/s);
  assert.ok(!userCard?.[0].includes("--note-pi-response-font-size"));
  // Mobile assistant bodies consume the same configured variable; only the
  // mobile user card keeps the fixed mobile font size and line height.
  assert.match(css, /[.]note-pi-mobile [.]note-pi-user-card {[^}]*font-size: var[(]--font-ui-medium[)]/s);
  assert.match(css, /[.]note-pi-mobile [.]note-pi-user-card {[^}]*line-height: 1[.]6/s);
  const mobileUserCard = css.match(/[.]note-pi-mobile [.]note-pi-user-card {[^}]*}/s);
  assert.ok(!mobileUserCard?.[0].includes("--note-pi-response-font-size"));
  // No fixed mobile font-size override remains on message bodies.
  assert.doesNotMatch(css, /[.]note-pi-mobile [.]note-pi-message-body {[^}]*font-size/s);
});

test("composer density tweaks apply on desktop with mobile touch minimums intact", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(css, /[.]note-pi-composer-box textarea {[^}]*min-height: 56px/s);
  assert.match(css, /[.]note-pi-composer-box textarea {[^}]*max-height: 200px/s);
  assert.match(css, /[.]note-pi-composer-bar {[^}]*gap: 6px;[^}]*padding: 3px 6px 6px;/s);
  assert.match(css, /[.]note-pi-model-select {[^}]*max-width: 140px;[^}]*height: 22px/s);
  assert.match(css, /[.]note-pi-send-button {[^}]*width: 24px;[^}]*height: 24px;[^}]*border-radius: 7px;[^}]*font-size: 13px/s);
  assert.match(css, /[.]note-pi-context-add {[^}]*height: 24px/s);
  // Mobile overrides still guarantee 40/44px touch targets.
  assert.match(css, /[.]note-pi-mobile [.]note-pi-send-button {[^}]*min-height: 44px/s);
  assert.match(css, /[.]note-pi-mobile [.]note-pi-model-select {[^}]*min-height: 40px/s);
});

test("setControlValue routes numeric response-font-size values to setResponseFontSize only", async () => {
  const source = await readFile(new URL("../src/settings.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /if [(]key === "response-font-size" && typeof value === "number" && this[.]plugin[.]setResponseFontSize[)] {[^}]*await this[.]plugin[.]setResponseFontSize[(]value[)];[^}]*return;[^}]*}/
  );
  // The string value used by the text inputs must not reach setResponseFontSize.
  const fontSizeGuard = source.indexOf('key === "response-font-size" && typeof value === "number"');
  const agentDirGuard = source.indexOf('key === "agent-dir" && typeof value === "string"');
  assert.ok(fontSizeGuard > -1, "expected a response-font-size guard in setControlValue");
  assert.ok(agentDirGuard > -1, "expected an agent-dir guard in setControlValue");
  assert.ok(fontSizeGuard < agentDirGuard, "response-font-size should be handled before agent-dir");
});

test("mobile plugin stores a normalized responseFontSize and refreshes open views", async () => {
  const source = await readFile(new URL("../src/mobile/main.ts", import.meta.url), "utf8");

  assert.match(source, /responseFontSize: number/);
  assert.match(source, /responseFontSize: RESPONSE_FONT_SIZE_DEFAULT/);
  assert.match(source, /normalizeResponseFontSize[(]saved[?][.]responseFontSize[)]/);
  assert.match(source, /responseFontSize[(][)] { return normalizeResponseFontSize[(]this[.]settings[.]responseFontSize[)]/);
  assert.match(source, /this[.]settings[.]responseFontSize = normalizeResponseFontSize[(]size[)]/);
  assert.match(source, /data[.]responseFontSize = this[.]settings[.]responseFontSize/);
  assert.match(source, /getLeavesOfType[(]VIEW_TYPE_NOTE_PI_MOBILE[)]/);
  assert.match(source, /view instanceof MobileAgentView/);
  assert.match(source, /view[.]applyResponseFontSize[(][)]/);
});

test("mobile view applies the configured size as a scoped CSS variable on render", async () => {
  const source = await readFile(new URL("../src/mobile/view.ts", import.meta.url), "utf8");

  assert.match(source, /applyResponseFontSize[(][)]/);
  assert.match(source, /this[.]viewPrefs[?][.]responseFontSize[?][.][(][)]/);
  assert.match(source, /this[.]contentEl[.]style[.]setProperty[(]"--note-pi-response-font-size"/);
  // Applied on every render, not only when the plugin pushes an update.
  assert.match(source, /render[(][)] {[^]*?this[.]applyResponseFontSize[(][)];/);
  // No global document/body variable.
  assert.doesNotMatch(source, /document[.](body|documentElement)[.]style/);
});

test("mobile restores a 40px touch minimum for the context-add pill while desktop stays 24px", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(css, /[.]note-pi-context-add {[^}]*height: 24px/s);
  assert.match(css, /[.]note-pi-mobile [.]note-pi-context-add {[^}]*min-height: 40px/s);
});
