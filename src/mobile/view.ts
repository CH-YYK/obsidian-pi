import { Component, ItemView, MarkdownRenderer, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type { HarnessClient, HarnessSnapshot } from "../harness/client";
import { normalizeResponseFontSize } from "../shared/response-font-size.mjs";

export const VIEW_TYPE_NOTE_PI_MOBILE = "note-pi-mobile-view";

/** Interval between Markdown re-renders while a response is streaming. */
const STREAM_RENDER_INTERVAL_MS = 120;

/** Host-supplied view preferences (response typography). */
export interface MobileNotePiViewPrefs {
  responseFontSize?(): number;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatTokens(tokens: number): string {
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Compact chat view for Obsidian mobile. It consumes the same typed harness
 * client contract as the desktop view but drops desktop pane assumptions:
 * no session rail (sessions live behind a touch menu), larger tap targets,
 * and a single-column layout sized by styles.css `.note-pi-mobile` rules.
 * The view is presentation-only: every state change crosses the client
 * boundary.
 */
export class MobileAgentView extends ItemView {
  private transcriptEl!: HTMLElement;
  private composerEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private isStreaming = false;
  private snapshot: HarnessSnapshot;
  private unsubscribe?: () => void;
  private streamBody?: HTMLElement;
  private streamMarkdown = "";
  private streamRenderComponent?: Component;
  private streamRenderTimer?: number;
  private renderedComponents: Component[] = [];
  private titleMetaEl?: HTMLElement;
  private turnTimelineEl?: HTMLElement;
  private thinkingItemEl?: HTMLElement;
  private thinkingText = "";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly harness: HarnessClient,
    private readonly openSettings: () => void,
    private readonly viewPrefs?: MobileNotePiViewPrefs
  ) {
    super(leaf);
    this.snapshot = harness.snapshot();
  }

  getViewType() { return VIEW_TYPE_NOTE_PI_MOBILE; }
  getDisplayText() { return "Note Pi"; }
  getIcon() { return "bot"; }

  async onOpen() {
    this.unsubscribe = this.harness.subscribe((event) => {
      if (event.snapshot) {
        this.snapshot = event.snapshot;
        this.render();
      }
      if (event.type === "activity.thinking" && event.delta) this.addThinkingDelta(event.delta);
      if (event.type === "activity.tool" && event.activity) {
        this.finishThinking();
        this.addActivity({
          key: `tool:${event.activity.name}`,
          label: event.activity.detail ? `${event.activity.name}: ${event.activity.detail.split("/").pop()}` : `Using tool: ${event.activity.name}`,
          status: event.activity.status,
          detail: event.activity.detail
        });
      }
      if (event.type === "session.usage" && typeof event.usage === "number") {
        this.snapshot = this.harness.snapshot();
        if (this.titleMetaEl) this.titleMetaEl.setText(event.usage > 0 ? `${formatTokens(event.usage)} tokens` : "");
      }
    });
    this.render();
  }

  async onClose() {
    this.unsubscribe?.();
    this.teardownRenderedMarkdown();
  }

  render() {
    this.teardownRenderedMarkdown();
    this.contentEl.empty();
    this.contentEl.addClass("note-pi-view", "note-pi-mobile");
    this.applyResponseFontSize();
    this.renderHeader();
    this.transcriptEl = this.contentEl.createDiv({ cls: "note-pi-transcript" });
    this.renderTranscript();
    if (this.snapshot.providerState === "configured") this.renderComposer();
    else this.renderSetupCard();
  }

  /**
   * Re-read the host's response font size preference and apply it to this
   * view. Scoped to the view element so assistant Markdown bodies pick it up
   * via --note-pi-response-font-size without touching the rest of Obsidian.
   * Called on render and by the plugin when the setting changes, so open
   * views update live without a reload.
   */
  applyResponseFontSize() {
    const size = normalizeResponseFontSize(this.viewPrefs?.responseFontSize?.());
    this.contentEl.style.setProperty("--note-pi-response-font-size", `${size}px`);
  }

  private sessionTitle(): string {
    const first = this.snapshot.transcript.find((message) => message.role === "user" && message.text.trim());
    if (!first) return "Note Pi";
    const text = first.text.trim().replace(/\s+/g, " ");
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  private renderHeader() {
    const header = this.contentEl.createDiv({ cls: "note-pi-header" });
    const title = header.createDiv({ cls: "note-pi-title" });
    title.createSpan({ cls: "note-pi-title-icon", text: "π" });
    const titleText = title.createDiv({ cls: "note-pi-title-text" });
    titleText.createDiv({ cls: "note-pi-title-name", text: this.sessionTitle() });
    this.titleMetaEl = titleText.createDiv({ cls: "note-pi-title-meta" });
    if (this.snapshot.usageTokens > 0) this.titleMetaEl.setText(`${formatTokens(this.snapshot.usageTokens)} tokens`);
    else if (this.snapshot.providerState !== "configured") {
      this.titleMetaEl.setText("setup needed");
      this.titleMetaEl.addClass("note-pi-title-warning");
    }

    const historyButton = header.createEl("button", { cls: "note-pi-icon-button", attr: { "aria-label": "Session history", title: "Session history" } });
    setIcon(historyButton, "history");
    historyButton.onclick = (event) => this.showSessionMenu(event);

    const newSession = header.createEl("button", { cls: "note-pi-icon-button", attr: { "aria-label": "New session", title: "New session" } });
    setIcon(newSession, "plus");
    newSession.onclick = () => {
      if (this.isStreaming) {
        new Notice("Wait for the current response before starting a new session.");
        return;
      }
      void this.harness.newSession();
    };
  }

  /** Session history is a touch menu rather than a persistent rail. */
  private showSessionMenu(event: MouseEvent) {
    const menu = new Menu();
    if (!this.snapshot.sessions.length) {
      menu.addItem((item) => item.setTitle("No past sessions yet").setDisabled(true));
    }
    for (const session of this.snapshot.sessions) {
      menu.addItem((item) => {
        const active = session.id === this.snapshot.activeSessionId;
        item.setTitle(`${active ? "✓ " : ""}${session.title}`)
          .setDisabled(this.isStreaming || active)
          .onClick(() => void this.harness.resumeSession(session.id).catch((error: unknown) => {
            new Notice(error instanceof Error ? error.message : "Could not resume that session.");
          }));
      });
    }
    menu.showAtMouseEvent(event);
  }

  private renderTranscript() {
    const messages = this.snapshot.transcript;
    if (!messages.length) {
      const empty = this.transcriptEl.createDiv({ cls: "note-pi-empty" });
      empty.createDiv({ cls: "note-pi-empty-lead", text: "Ask Pi to work with this note." });
      return;
    }
    for (const message of messages) this.addMessage(message.role, message.text);
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  private renderSetupCard() {
    const setup = this.contentEl.createDiv({ cls: "note-pi-setup" });
    setup.createEl("strong", { text: "No model provider is configured." });
    setup.createDiv({ text: "Add an API key in Note Pi settings to send your first chat message." });
    const button = setup.createEl("button", { text: "Open provider settings", cls: "mod-cta" });
    button.onclick = this.openSettings;
  }

  private addMessage(role: "user" | "assistant", text: string) {
    if (role === "user") {
      const card = this.transcriptEl.createDiv({ cls: "note-pi-user-card" });
      card.createDiv({ cls: "note-pi-user-text", text });
      this.turnTimelineEl = undefined;
      this.scrollToBottom();
      return undefined;
    }
    const message = this.transcriptEl.createDiv({ cls: "note-pi-message note-pi-message-assistant" });
    const body = message.createDiv({ cls: "note-pi-message-body" });
    if (text) this.renderMarkdownInto(body, text);
    this.scrollToBottom();
    return body;
  }

  /** Activities for the current turn collect into one timeline group. */
  private currentTimeline(): HTMLElement {
    if (!this.turnTimelineEl || !this.turnTimelineEl.isConnected) {
      this.turnTimelineEl = this.transcriptEl.createDiv({ cls: "note-pi-timeline", attr: { "aria-live": "polite" } });
    }
    return this.turnTimelineEl;
  }

  private addActivity(activity: { key: string; label: string; status: string; detail?: string }) {
    const timeline = this.currentTimeline();
    const item = timeline.createDiv({ cls: `note-pi-activity note-pi-activity-${activity.status}` });
    item.createSpan({ cls: "note-pi-activity-dot" });
    item.createSpan({ cls: "note-pi-activity-label", text: activity.label });
    if (activity.detail) {
      item.addClass("note-pi-activity-open");
      item.createDiv({ cls: "note-pi-activity-detail", text: activity.detail });
    }
    this.scrollToBottom();
  }

  /**
   * Stream thinking into a single timeline item whose detail stays open, so
   * the reasoning progress is visible as it arrives.
   */
  private addThinkingDelta(delta: string) {
    if (!this.thinkingItemEl || !this.thinkingItemEl.isConnected) {
      const item = this.currentTimeline().createDiv({ cls: "note-pi-activity note-pi-activity-working note-pi-activity-open" });
      item.createSpan({ cls: "note-pi-activity-dot" });
      item.createSpan({ cls: "note-pi-activity-label", text: "Thinking" });
      item.createDiv({ cls: "note-pi-activity-detail" });
      this.thinkingItemEl = item;
      this.thinkingText = "";
    }
    this.thinkingText += delta;
    const detail = this.thinkingItemEl.querySelector(".note-pi-activity-detail");
    if (detail) detail.textContent = this.thinkingText;
    this.scrollToBottom();
  }

  /** Close the working Thinking item; the next delta starts a fresh one. */
  private finishThinking() {
    if (this.thinkingItemEl) {
      this.thinkingItemEl.classList.remove("note-pi-activity-working");
      this.thinkingItemEl.classList.add("note-pi-activity-completed");
      this.thinkingItemEl = undefined;
    }
    this.thinkingText = "";
  }

  private renderComposer() {
    const composer = this.contentEl.createDiv({ cls: "note-pi-composer" });
    const activeNote = this.app.workspace.getActiveFile()?.basename;
    if (activeNote) {
      const contextRow = composer.createDiv({ cls: "note-pi-context-row" });
      const chip = contextRow.createDiv({ cls: "note-pi-context-chip" });
      chip.createSpan({ cls: "note-pi-context-chip-icon", text: "📄" });
      chip.createSpan({ text: activeNote });
    }
    const box = composer.createDiv({ cls: "note-pi-composer-box" });
    this.composerEl = box.createEl("textarea", {
      attr: { placeholder: "Ask anything…", rows: "1", "aria-label": "Message Note Pi" }
    });
    this.composerEl.addEventListener("input", () => {
      this.composerEl.setCssStyles({ height: "auto" });
      this.composerEl.setCssStyles({ height: `${Math.min(this.composerEl.scrollHeight, 160)}px` });
    });

    const bar = box.createDiv({ cls: "note-pi-composer-bar" });
    this.renderModelPicker(bar);
    this.sendButton = bar.createEl("button", {
      cls: "note-pi-send-button mod-cta",
      attr: { "aria-label": "Send message" },
      text: "↑"
    });
    this.sendButton.onclick = () => {
      if (this.isStreaming) {
        this.harness.cancel();
        return;
      }
      void this.submit();
    };
  }

  private renderModelPicker(parent: HTMLElement) {
    if (this.snapshot.models.length <= 1) return;
    const select = parent.createEl("select", { cls: "dropdown note-pi-model-select", attr: { "aria-label": "Chat model" } });
    for (const model of this.snapshot.models) select.createEl("option", { value: model.id, text: model.label });
    select.value = this.snapshot.modelId ?? "";
    select.onchange = async () => {
      if (this.isStreaming) {
        select.value = this.snapshot.modelId ?? "";
        new Notice("Wait for the current response before changing models.");
        return;
      }
      try {
        await this.harness.setSessionModel(select.value);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Could not change the chat model.");
      }
    };
  }

  private setStreaming(streaming: boolean) {
    this.isStreaming = streaming;
    this.sendButton.setText(streaming ? "■" : "↑");
    this.sendButton.setAttr("aria-label", streaming ? "Stop response" : "Send message");
    this.sendButton.toggleClass("note-pi-send-stop", streaming);
  }

  private async submit() {
    const prompt = this.composerEl.value.trim();
    if (!prompt || this.isStreaming) return;
    this.setStreaming(true);
    this.thinkingItemEl = undefined;
    this.thinkingText = "";
    this.composerEl.value = "";
    this.addMessage("user", prompt);
    const body = this.addMessage("assistant", "");
    if (!body) return;
    this.streamBody = body;
    this.streamMarkdown = "";
    body.addClass("note-pi-streaming");
    try {
      const result = await this.harness.submit(prompt, (delta) => {
        // The first answer token ends the reasoning phase.
        if (!this.streamMarkdown) this.finishThinking();
        this.streamMarkdown += delta;
        this.scheduleStreamRender();
      });
      if (!this.streamMarkdown && result) this.streamMarkdown = result;
      this.renderStreamMarkdown(true);
      this.transcriptEl.createDiv({ cls: "note-pi-timestamp", text: formatClock(new Date()) });
    } catch (error) {
      this.flushStreamRenderTimer();
      body.removeClass("note-pi-streaming");
      body.addClass("note-pi-error");
      body.setText(error instanceof Error ? error.message : "Chat failed. Fix provider setup and try again.");
    } finally {
      this.finishThinking();
      this.streamBody = undefined;
      this.streamMarkdown = "";
      this.setStreaming(false);
    }
  }

  private renderMarkdownInto(body: HTMLElement, markdown: string) {
    this.streamRenderComponent?.unload();
    body.empty();
    const component = new Component();
    component.load();
    this.renderedComponents.push(component);
    this.streamRenderComponent = component;
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    void MarkdownRenderer.render(this.app, markdown, body, sourcePath, component);
  }

  private scheduleStreamRender() {
    if (this.streamRenderTimer !== undefined) return;
    this.streamRenderTimer = window.setTimeout(() => {
      this.streamRenderTimer = undefined;
      if (this.streamBody) {
        this.renderMarkdownInto(this.streamBody, this.streamMarkdown);
        this.scrollToBottom();
      }
    }, STREAM_RENDER_INTERVAL_MS);
  }

  private renderStreamMarkdown(final: boolean) {
    if (!this.streamBody) return;
    this.flushStreamRenderTimer();
    this.renderMarkdownInto(this.streamBody, this.streamMarkdown);
    if (final) this.streamBody.removeClass("note-pi-streaming");
    this.scrollToBottom();
  }

  private flushStreamRenderTimer() {
    if (this.streamRenderTimer === undefined) return;
    window.clearTimeout(this.streamRenderTimer);
    this.streamRenderTimer = undefined;
  }

  private teardownRenderedMarkdown() {
    this.flushStreamRenderTimer();
    for (const component of this.renderedComponents) component.unload();
    this.renderedComponents = [];
    this.streamRenderComponent = undefined;
  }

  private scrollToBottom() {
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }
}
