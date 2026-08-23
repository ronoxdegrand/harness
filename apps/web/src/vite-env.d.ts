/// <reference types="vite/client" />

interface DesktopSettings {
  apiKey: string;
  maxIterations: number;
  sendOnEnter: boolean;
  sidebarWidth: number;
  activityWidth: number;
  contextWidth: number;
  scale: number;
}

interface Window {
  harnessDesktop?: {
    platform: string;
    getUpdateReady(): Promise<string | undefined>;
    onUpdateReady(callback: (version: string) => void): () => void;
    restartToUpdate(): Promise<void>;
    getSettings(): Promise<Partial<DesktopSettings>>;
    setSettings(settings: DesktopSettings): Promise<void>;
    setScale(scale: number): Promise<number>;
    selectRepository(currentPath: string): Promise<string | undefined>;
    onScaleChanged(callback: (scale: number) => void): () => void;
  };
}
