import { Plugin, Notice } from "obsidian";
import { relative, resolve } from "node:path";
import { checkPiRuntime } from "./plugin/runtime-compatibility";
import { ensureVendoredJitiRuntime } from "./plugin/jiti-runtime";
import { AUTH_PROVIDERS, AgentController } from "./harness/host.mjs";
import { NotePiSettingsTab } from "./settings";
import { ObsidianAgentView, VIEW_TYPE_NOTE_PI } from "./view";
import { normalizeResponseFontSize, RESPONSE_FONT_SIZE_DEFAULT } from "./shared/response-font-size.mjs";

type HarnessEvent = { type: string; requestId: string; node?: string; pid?: number };
export interface NotePiCredential { type: "api_key"; key?: string; [key: string]: unknown; }
export interface NotePiSettings { providerId: string; agentDir: string; autoContextNote: boolean; responseFontSize: number; credentials: Record<string, NotePiCredential>; googleApiKey?: string; }
const DEFAULT_SETTINGS: NotePiSettings = { providerId: "google", agentDir: "", autoContextNote: true, responseFontSize: RESPONSE_FONT_SIZE_DEFAULT, credentials: {}, googleApiKey: "" };

export default class NotePiPlugin extends Plugin {
  private controller?: AgentController;
  private requestSequence = 0;
  settings: NotePiSettings = DEFAULT_SETTINGS;

  async onload() {
    const runtime = checkPiRuntime(process.versions.node);
    if (!runtime.supported) {
      new Notice(`Note Pi disabled: ${runtime.message}`);
      return;
    }
    this.settings = this.normalizeSettings(await this.loadStoredSettings());
    await this.saveData(this.settings);
    await this.configureHarness();
    this.registerView(VIEW_TYPE_NOTE_PI, (leaf) => new ObsidianAgentView(leaf, this.startHarness(), () => this.openSettings(), {
      autoContextNote: () => this.settings.autoContextNote,
      responseFontSize: () => this.settings.responseFontSize
    }));
    this.addSettingTab(new NotePiSettingsTab(this.app, this));
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => this.activateView() });
    this.addCommand({ id: "open-settings", name: "Open settings", callback: () => this.openSettings() });
    this.addCommand({ id: "check-harness", name: "Check bundled harness runtime", callback: async () => {
      const event = await this.requestHealth();
      new Notice(`Harness ready, Node ${event.node}.`);
    } });
  }

  onunload() {
    this.controller?.close();
    this.controller = undefined;
  }

  providerOptions() { return AUTH_PROVIDERS; }
  providerStatus(providerId = this.settings.providerId) { return this.startHarness().providerState(providerId); }
  extensionStatus() {
    const snapshot = this.startHarness().snapshot();
    return { extensions: snapshot.extensions, errors: snapshot.extensionErrors };
  }

  async saveApiKey(apiKey: string, providerId = this.settings.providerId) {
    this.settings.credentials = await this.startHarness().loginWithApiKey(providerId, apiKey);
    await this.saveData(this.settings);
  }

  async logoutProvider(providerId: string) {
    this.settings.credentials = await this.startHarness().logout(providerId);
    await this.saveData(this.settings);
  }

  testProvider(providerId: string) {
    return this.startHarness().testProviderConnection(providerId);
  }

  defaultAgentDir() { return "_pi/agent"; }
  async saveAgentDir(agentDir: string) {
    this.settings.agentDir = this.normalizeAgentDir(agentDir);
    await this.saveData(this.settings);
    await this.configureHarness();
  }

  autoContextNote() { return this.settings.autoContextNote; }
  async setAutoContextNote(enabled: boolean) {
    this.settings.autoContextNote = enabled;
    await this.saveData(this.settings);
  }

  responseFontSize() { return normalizeResponseFontSize(this.settings.responseFontSize); }
  async setResponseFontSize(size: number) {
    this.settings.responseFontSize = normalizeResponseFontSize(size);
    await this.saveData(this.settings);
    // Apply immediately to open Note Pi panes; no plugin reload needed.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTE_PI)) {
      const view = leaf.view;
      if (view instanceof ObsidianAgentView) view.applyResponseFontSize();
    }
  }

  openSettings() {
    const settings = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  async activateView() {
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_NOTE_PI, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  private nextRequestId() {
    this.requestSequence += 1;
    return `request-${this.requestSequence}`;
  }

  private startHarness() {
    if (!this.controller) this.controller = new AgentController();
    return this.controller;
  }

  /** Public lookup so restored views can rebind to the live harness. */
  harnessClient() {
    return this.startHarness();
  }

  private normalizeSettings(saved: Partial<NotePiSettings> | null): NotePiSettings {
    const { modelId: _legacyModelId, extensions: _legacyExtensions, ...savedConfiguration } = (saved ?? {}) as Partial<NotePiSettings> & { modelId?: string; extensions?: unknown };
    const credentials = { ...(savedConfiguration.credentials ?? {}) };
    if (savedConfiguration.googleApiKey?.trim() && !credentials.google) credentials.google = { type: "api_key", key: savedConfiguration.googleApiKey.trim() };
    // Drop credentials for providers that no longer exist in the catalog.
    for (const id of Object.keys(credentials)) {
      if (!AUTH_PROVIDERS.some((provider) => provider.id === id)) delete credentials[id];
    }
    const providerId = AUTH_PROVIDERS.some((provider) => provider.id === savedConfiguration.providerId) ? savedConfiguration.providerId ?? "google" : "google";
    const agentDir = this.normalizeAgentDir(savedConfiguration.agentDir === ".pi/agent" ? "" : savedConfiguration.agentDir ?? "");
    const responseFontSize = normalizeResponseFontSize(savedConfiguration.responseFontSize);
    return { ...DEFAULT_SETTINGS, ...savedConfiguration, agentDir, credentials, providerId, responseFontSize, googleApiKey: "" };
  }

  private async loadStoredSettings(): Promise<Partial<NotePiSettings>> {
    const saved: unknown = await this.loadData();
    return saved && typeof saved === "object" ? saved : {};
  }

  private async configureHarness() {
    const pluginDir = resolve(this.vaultPath(), this.manifest.dir ?? "");
    await this.startHarness().applyPluginConfiguration({
      providerId: this.settings.providerId,
      credentials: this.settings.credentials,
      vaultPath: (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(),
      agentDir: resolve(this.vaultPath(), this.settings.agentDir),
      enabledTools: ["read"],
      jitiPath: await ensureVendoredJitiRuntime(pluginDir)
    });
  }

  private vaultPath() { return (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(); }
  private normalizeAgentDir(value: string) {
    const resolved = resolve(this.vaultPath(), value.trim() || this.defaultAgentDir());
    const vaultRelative = relative(this.vaultPath(), resolved);
    if (!vaultRelative || vaultRelative === ".." || vaultRelative.startsWith(`..${"/"}`)) throw new Error("Pi agent directory must be inside this vault.");
    return vaultRelative.replaceAll("\\", "/");
  }

  private async requestHealth(): Promise<HarnessEvent> {
    return this.startHarness().health(this.nextRequestId());
  }
}
