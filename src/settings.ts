import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin, SettingDefinitionItem } from "obsidian";
import { RESPONSE_FONT_SIZE_DEFAULT, RESPONSE_FONT_SIZE_MAX, RESPONSE_FONT_SIZE_MIN } from "./shared/response-font-size.mjs";

export interface ProviderInfo { id: string; label: string; apiKeyLabel: string; }
export interface StoredCredential { type: "api_key"; key?: string; }
export interface ExtensionInfo { name: string; description: string; }
type SettingsTabId = "general" | "providers" | "extensions";

/** Result of a provider connection probe, shown in the settings tab. */
export interface ProviderTestResult { model: string; latencyMs: number; }

/** Mask a stored key so the settings tab can confirm a key without leaking it. */
export function maskCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/** The settings host shared by desktop and mobile Note Pi builds. */
export interface ProviderConfigHost {
  settings: { providerId: string; agentDir?: string; credentials?: Record<string, StoredCredential> };
  providerOptions(): ProviderInfo[];
  providerStatus(providerId?: string): string;
  saveApiKey(apiKey: string, providerId?: string): Promise<void>;
  logoutProvider(providerId: string): Promise<void>;
  testProvider?(providerId: string): Promise<ProviderTestResult>;
  defaultAgentDir?(): string;
  saveAgentDir?(agentDir: string): Promise<void>;
  autoContextNote?(): boolean;
  setAutoContextNote?(enabled: boolean): Promise<void>;
  responseFontSize?(): number;
  setResponseFontSize?(size: number): Promise<void>;
  extensionStatus?(): { extensions: ExtensionInfo[] };
}

export class NotePiSettingsTab extends PluginSettingTab {
  private activeTab: SettingsTabId = "general";
  /** Last connection-check outcome per provider, for this settings session. */
  private testOutcomes = new Map<string, { ok: boolean; detail: string }>();
  /** Provider whose key is being edited. Local to this tab — key management never changes the chat provider. */
  private editingProviderId?: string;
  private keyInput?: HTMLInputElement;

  constructor(app: App, private readonly plugin: Plugin & ProviderConfigHost) { super(app, plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const tabs = this.availableTabs();
    if (!tabs.some(([id]) => id === this.activeTab)) this.activeTab = tabs[0][0];
    const definitions: SettingDefinitionItem[] = [{
      name: "Settings sections",
      searchable: false,
      render: (setting) => this.renderTabBar(setting, tabs)
    }];

    if (this.activeTab === "general") {
      definitions.push({
        type: "group",
        cls: "note-pi-settings-panel",
        items: [
          ...(typeof this.plugin.autoContextNote === "function" && typeof this.plugin.setAutoContextNote === "function" ? [{
            name: "Attach the focused note",
            desc: "Add the currently focused note as context when a chat session starts. The chip can be removed per session in the composer.",
            control: { type: "toggle" as const, key: "auto-context-note", defaultValue: true }
          }] : []),
          ...(typeof this.plugin.responseFontSize === "function" && typeof this.plugin.setResponseFontSize === "function" ? [{
            name: "Response font size",
            desc: "Font size for assistant responses in the Note Pi pane.",
            control: {
              type: "slider" as const,
              key: "response-font-size",
              min: RESPONSE_FONT_SIZE_MIN,
              max: RESPONSE_FONT_SIZE_MAX,
              step: 1,
              defaultValue: RESPONSE_FONT_SIZE_DEFAULT,
              displayFormat: (value: number) => `${value} px`
            }
          }] : []),
          ...(typeof this.plugin.defaultAgentDir === "function" && typeof this.plugin.saveAgentDir === "function" ? [{
            name: "Pi agent directory",
            desc: "Vault-relative directory where Note Pi discovers local extensions and stores its sessions.",
            control: {
              type: "text" as const,
              key: "agent-dir",
              placeholder: this.plugin.defaultAgentDir?.() ?? "_pi/agent",
              validate: (value: string) => value.trim() ? undefined : "Enter a vault-relative directory."
            }
          }] : [])
        ]
      });
    }

    if (this.activeTab === "providers") {
      const provider = this.editingProvider();
      const configuredProviders = this.plugin.providerOptions().filter((option) => this.plugin.providerStatus(option.id) === "configured");
      definitions.push({
        type: "group",
        cls: "note-pi-settings-panel",
        items: [
        {
          name: "Provider",
          desc: "Choose which provider's API key to add or replace.",
          control: {
            type: "dropdown",
            key: "editing-provider-id",
            options: Object.fromEntries(this.plugin.providerOptions().map((option) => [option.id, option.label]))
          }
        },
        {
          name: provider.apiKeyLabel,
          desc: this.plugin.providerStatus(provider.id) === "configured"
            ? `Replace the saved ${provider.label} key.`
            : `Paste a ${provider.label} key to connect this provider.`,
          render: (setting) => this.renderApiKeyInput(setting, provider)
        },
        {
          name: "Added keys",
          searchable: false,
          render: (setting) => this.renderSectionHeading(setting, "Added keys", !configuredProviders.length)
        },
        ...configuredProviders.map((option) => ({
          name: option.label,
          desc: this.savedKeyDescription(option),
          render: (setting: Setting) => this.renderSavedKeyActions(setting, option)
        }))
        ]
      });
    }

    if (this.activeTab === "extensions") {
      definitions.push({
        type: "group",
        cls: "note-pi-settings-panel",
        items: [{
          name: "Installed extensions",
          desc: "Vault-local extensions loaded from the configured Pi agent directory.",
          render: (setting) => this.renderExtensions(setting)
        }]
      });
    }

    return definitions;
  }

  getControlValue(key: string): unknown {
    switch (key) {
      case "auto-context-note":
        return this.plugin.autoContextNote?.() ?? true;
      case "response-font-size":
        return this.plugin.responseFontSize?.() ?? RESPONSE_FONT_SIZE_DEFAULT;
      case "agent-dir":
        return this.plugin.settings.agentDir ?? "";
      case "editing-provider-id":
        return this.editingProvider().id;
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "auto-context-note" && typeof value === "boolean" && this.plugin.setAutoContextNote) {
      await this.plugin.setAutoContextNote(value);
      return;
    }
    if (key === "response-font-size" && typeof value === "number" && this.plugin.setResponseFontSize) {
      await this.plugin.setResponseFontSize(value);
      return;
    }
    if (key === "agent-dir" && typeof value === "string" && this.plugin.saveAgentDir) {
      await this.plugin.saveAgentDir(value);
      new Notice("Pi agent directory saved.");
      this.update();
      return;
    }
    if (key === "editing-provider-id" && typeof value === "string" && this.plugin.providerOptions().some((option) => option.id === value)) {
      this.editingProviderId = value;
      this.update();
    }
  }

  private hasGeneralSettings(): boolean {
    return (
      (typeof this.plugin.autoContextNote === "function" && typeof this.plugin.setAutoContextNote === "function") ||
      (typeof this.plugin.responseFontSize === "function" && typeof this.plugin.setResponseFontSize === "function") ||
      (typeof this.plugin.defaultAgentDir === "function" && typeof this.plugin.saveAgentDir === "function")
    );
  }

  private hasExtensionSettings(): boolean {
    return typeof this.plugin.extensionStatus === "function";
  }

  private availableTabs(): [SettingsTabId, string][] {
    return [
      ...(this.hasGeneralSettings() ? [["general", "General"] as [SettingsTabId, string]] : []),
      ...(this.hasExtensionSettings() ? [["extensions", "Extensions"] as [SettingsTabId, string]] : []),
      ["providers", "API Provider"]
    ];
  }

  private renderTabBar(setting: Setting, tabs: [SettingsTabId, string][]): void {
    setting.settingEl.empty();
    setting.settingEl.addClass("note-pi-settings-tab-row");
    const bar = setting.settingEl.createDiv({ cls: "note-pi-settings-tabs" });
    bar.setAttr("role", "tablist");
    for (const [id, label] of tabs) {
      const button = bar.createDiv({
        cls: `vertical-tab-nav-item note-pi-settings-tab${this.activeTab === id ? " is-active" : ""}`,
        text: label
      });
      button.setAttr("role", "tab");
      button.setAttr("tabindex", "0");
      button.setAttr("aria-selected", String(this.activeTab === id));
      const activate = () => {
        this.activeTab = id;
        this.update();
      };
      button.addEventListener("click", activate);
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
    }
  }

  private renderSectionHeading(setting: Setting, text: string, empty: boolean): void {
    setting.settingEl.empty();
    setting.settingEl.addClass("note-pi-settings-subheading");
    setting.settingEl.createDiv({ cls: "note-pi-settings-subheading-label", text });
    if (empty) setting.settingEl.createDiv({ cls: "note-pi-settings-empty", text: "No saved keys yet." });
  }

  private editingProvider(): ProviderInfo {
    const options = this.plugin.providerOptions();
    return options.find((provider) => provider.id === this.editingProviderId)
      ?? options.find((provider) => provider.id === this.plugin.settings.providerId)
      ?? options[0];
  }

  private renderApiKeyInput(setting: Setting, provider: ProviderInfo): void {
    const configured = this.plugin.providerStatus(provider.id) === "configured";
    setting.setClass("note-pi-key-sub")
      .addText((text) => {
        text.setPlaceholder(configured ? `Replace ${provider.apiKeyLabel}` : `Paste ${provider.apiKeyLabel}`);
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        this.keyInput = text.inputEl;
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void this.saveSelectedKey();
          }
        });
      })
      .addExtraButton((button) => {
        button.setIcon("corner-down-left").setTooltip(configured ? "Replace the saved key (Enter)" : "Save key (Enter)");
        button.extraSettingsEl.setAttr("aria-label", configured ? `Replace ${provider.label} API key` : `Save ${provider.label} API key`);
        button.onClick(() => void this.saveSelectedKey());
      });
  }

  private async saveSelectedKey(): Promise<void> {
    const provider = this.editingProvider();
    if (!this.keyInput) return;
    try {
      await this.plugin.saveApiKey(this.keyInput.value, provider.id);
      new Notice(`${provider.label} API key saved.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not save the API key.");
    } finally {
      this.update();
    }
  }

  private savedKeyDescription(provider: ProviderInfo): string {
    const stored = this.plugin.settings.credentials?.[provider.id];
    const masked = stored?.key?.trim() ? maskCredentialKey(stored.key) : "stored";
    const outcome = this.testOutcomes.get(provider.id);
    if (!outcome) return `Key saved (${masked})`;
    return outcome.ok ? `Key saved (${masked}) · last check: ${outcome.detail}` : `Key saved (${masked}) · last check failed: ${outcome.detail}`;
  }

  private renderSavedKeyActions(setting: Setting, provider: ProviderInfo): void {
    setting.addExtraButton((button) => {
      button.setIcon("pencil").setTooltip(`Replace the ${provider.label} key`);
      button.extraSettingsEl.setAttr("aria-label", `Replace ${provider.label} API key`);
      button.onClick(() => {
        this.editingProviderId = provider.id;
        this.update();
      });
    });

    if (this.plugin.testProvider) {
      setting.addExtraButton((button) => {
        button.setIcon("zap").setTooltip("Test the connection with the saved key");
        button.extraSettingsEl.setAttr("aria-label", `Test ${provider.label} connection`);
        button.onClick(async () => {
          button.setDisabled(true);
          button.setTooltip("Testing…");
          try {
            const result = await this.plugin.testProvider!(provider.id);
            const latency = `${(result.latencyMs / 1000).toFixed(1)}s`;
            this.testOutcomes.set(provider.id, { ok: true, detail: `connected via ${result.model} in ${latency}` });
            new Notice(`${provider.label} connection OK (${result.model}, ${latency}).`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Connection failed.";
            this.testOutcomes.set(provider.id, { ok: false, detail: message });
            new Notice(`${provider.label} connection failed: ${message}`);
          } finally {
            this.update();
          }
        });
      });
    }

    setting.addExtraButton((button) => {
      button.setIcon("x").setTooltip(`Remove the ${provider.label} key`);
      button.extraSettingsEl.setAttr("aria-label", `Remove ${provider.label} API key`);
      button.onClick(async () => {
        await this.plugin.logoutProvider(provider.id);
        this.testOutcomes.delete(provider.id);
        new Notice(`${provider.label} key removed.`);
        this.update();
      });
    });
  }

  private renderExtensions(setting: Setting): void {
    const extensions = this.plugin.extensionStatus?.().extensions ?? [];
    if (!extensions.length) {
      setting.controlEl.setText("No extensions are loaded.");
      return;
    }
    const table = setting.controlEl.createEl("table", { cls: "note-pi-extension-table" });
    const header = table.createEl("thead").createEl("tr");
    header.createEl("th", { text: "Extension" });
    header.createEl("th", { text: "Description" });
    const body = table.createEl("tbody");
    for (const extension of extensions) {
      const row = body.createEl("tr");
      row.createEl("td", { text: extension.name });
      row.createEl("td", { text: extension.description });
    }
  }
}
