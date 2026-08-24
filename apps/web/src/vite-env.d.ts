/// <reference types="vite/client" />

interface DesktopSettings {
  apiKey: string;
  sarvamApiKey: string;
  maxIterations: number;
  sendOnEnter: boolean;
  sidebarWidth: number;
  activityWidth: number;
  contextWidth: number;
  threadSort: "recent-message" | "created";
  groupThreadsByPath: boolean;
  scale: number;
  appearance: "light" | "dark" | "system";
}

interface Window {
  harnessDesktop?: {
    platform: string;
    getVersion(): Promise<string>;
    getUpdateReady(): Promise<string | undefined>;
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
