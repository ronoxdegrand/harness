/// <reference types="vite/client" />

interface DesktopSettings {
  apiKey: string;
  sarvamApiKey: string;
  maxIterations: number;
  sendOnEnter: boolean;
  midRunEnterAction: "queue" | "steer";
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  activityWidth: number;
  activityPlacement: "side" | "inline";
  contextWidth: number;
  contextOpen: boolean;
  gitWidth: number;
  gitOpen: boolean;
  threadSort: "recent-message" | "created";
  groupThreadsByPath: boolean;
  scale: number;
  appearance: "light" | "dark" | "system";
}

interface DesktopUpdateState {
  retryAfter?: number;
  status: "idle" | "unavailable" | "checking" | "up-to-date" | "downloading" | "ready" | "error";
  version?: string;
  message?: string;
}

interface Window {
  harnessDesktop?: {
    platform: string;
    getVersion(): Promise<string>;
    getUpdateReady(): Promise<string | undefined>;
    getUpdateState(): Promise<DesktopUpdateState>;
    checkForUpdates(): Promise<DesktopUpdateState>;
    onUpdateState(callback: (state: DesktopUpdateState) => void): () => void;
    onUpdateReady(callback: (version: string) => void): () => void;
    restartToUpdate(): Promise<void>;
    getSettings(): Promise<Partial<DesktopSettings>>;
    setSettings(settings: DesktopSettings): Promise<void>;
    setScale(scale: number): Promise<number>;
    setAppearance(appearance: DesktopSettings["appearance"]): Promise<string>;
    selectRepository(currentPath: string): Promise<string | undefined>;
    onScaleChanged(callback: (scale: number) => void): () => void;
  };
}
