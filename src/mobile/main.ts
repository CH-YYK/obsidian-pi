import { Plugin, requestUrl } from "obsidian";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AUTH_PROVIDERS, MOBILE_PROVIDER_IDS } from "../shared/providers.mjs";
import { normalizeResponseFontSize, RESPONSE_FONT_SIZE_DEFAULT } from "../shared/response-font-size.mjs";
import { NotePiSettingsTab } from "../settings";
import { MobileAgentController } from "./controller.mjs";
import { obsidianRequestUrlFetch } from "./network.mjs";
import { createMobileVaultReadTool } from "./vault-adapter.mjs";
import { MobileAgentView, VIEW_TYPE_NOTE_PI_MOBILE } from "./view";

interface MobileSettings { providerId: string; responseFontSize: number; credentials: Record<string, { type: "api_key"; key?: string }>; }
const DEFAULT_SETTINGS: MobileSettings = { providerId: "google", responseFontSize: RESPONSE_FONT_SIZE_DEFAULT, credentials: {} };

/** Providers validated for the iOS WebView build. */
const MOBILE_PROVIDERS = AUTH_PROVIDERS.filter((provider) => MOBILE_PROVIDER_IDS.includes(provider.id));
const MOBILE_PROVIDER_FACTORIES = {
  google: googleProvider,
  anthropic: anthropicProvider,
  "kimi-coding": kimiCodingProvider,
  openai: openaiProvider
};

/**
 * Mobile entry point (iPad/iPhone). This is a distinct runtime target from
 * the desktop plugin: it wires MobileAgentView -> MobileAgentController ->
 * MobileAgentRuntime with a browser-safe Pi agent loop, Obsidian requestUrl
 * provider transport, Obsidian vault-API reads, and plugin-data session
 * persistence. No Node APIs, extensions, or shell tools exist in this build.
 */
export default class NotePiMobilePlugin extends Plugin {
  private controller?: MobileAgentController;
  settings: MobileSettings = DEFAULT_SETTINGS;

  async onload() {
    const saved = await this.loadStoredSettings();
    const credentials = { ...(saved?.credentials ?? {}) };
    for (const id of Object.keys(credentials)) {
      if (!MOBILE_PROVIDERS.some((provider) => provider.id === id)) delete credentials[id];
    }
    this.settings = {
      providerId: MOBILE_PROVIDERS.some((provider) => provider.id === saved?.providerId) ? saved.providerId : DEFAULT_SETTINGS.providerId,
      responseFontSize: normalizeResponseFontSize(saved?.responseFontSize),
      credentials
    };
    await this.configureHarness();
    this.registerView(VIEW_TYPE_NOTE_PI_MOBILE, (leaf) => new MobileAgentView(leaf, this.startController(), () => this.openSettings(), {
      responseFontSize: () => this.settings.responseFontSize
    }));
    this.addSettingTab(new NotePiSettingsTab(this.app, this));
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => this.activateView() });
    this.addCommand({ id: "open-settings", name: "Open settings", callback: () => this.openSettings() });
  }

  onunload() {
    this.controller?.close();
    this.controller = undefined;
  }

  providerOptions() { return MOBILE_PROVIDERS; }
  selectedProvider() { return MOBILE_PROVIDERS.find((provider) => provider.id === this.settings.providerId) ?? MOBILE_PROVIDERS[0]; }
  providerStatus(providerId = this.settings.providerId) { return this.startController().providerState(providerId); }

  async saveApiKey(apiKey: string, providerId = this.settings.providerId) {
    this.settings.credentials = await this.startController().loginWithApiKey(providerId, apiKey);
    await this.saveSettings();
  }

  async logoutProvider(providerId: string) {
    this.settings.credentials = await this.startController().logout(providerId);
    await this.saveSettings();
  }

  testProvider(providerId: string) {
    return this.startController().testProviderConnection(providerId);
  }

  responseFontSize() { return normalizeResponseFontSize(this.settings.responseFontSize); }
  async setResponseFontSize(size: number) {
    this.settings.responseFontSize = normalizeResponseFontSize(size);
    await this.saveSettings();
    // Apply immediately to open mobile Note Pi views; no plugin reload needed.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTE_PI_MOBILE)) {
      const view = leaf.view;
      if (view instanceof MobileAgentView) view.applyResponseFontSize();
    }
  }

  openSettings() {
    const settings = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  async activateView() {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_NOTE_PI_MOBILE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  private startController() {
    if (!this.controller) {
      this.controller = new MobileAgentController({
        storage: {
          read: async () => (await this.loadStoredSettings()).mobileSessions,
          write: async (value: unknown) => {
            const data = await this.loadStoredSettings();
            data.mobileSessions = value;
            await this.saveData(data);
          }
        },
        tools: () => [createMobileVaultReadTool({ readText: (path: string) => this.app.vault.adapter.read(path) })]
      });
    }
    return this.controller;
  }

  private async configureHarness() {
    const provider = this.selectedProvider();
    await this.startController().applyPluginConfiguration({
      providerId: provider.id,
      credentials: this.settings.credentials,
      providerFactories: MOBILE_PROVIDERS.map((entry) => MOBILE_PROVIDER_FACTORIES[entry.id as keyof typeof MOBILE_PROVIDER_FACTORIES]),
      providerCatalog: MOBILE_PROVIDERS,
      fetch: obsidianRequestUrlFetch(requestUrl)
    });
  }

  private async saveSettings() {
    const data = await this.loadStoredSettings();
    data.providerId = this.settings.providerId;
    data.responseFontSize = this.settings.responseFontSize;
    data.credentials = this.settings.credentials;
    await this.saveData(data);
  }

  private async loadStoredSettings(): Promise<MobileSettings & { mobileSessions?: unknown }> {
    const saved: unknown = await this.loadData();
    return saved && typeof saved === "object"
      ? saved as MobileSettings & { mobileSessions?: unknown }
      : { ...DEFAULT_SETTINGS };
  }
}
