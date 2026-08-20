/// <reference types="vite/client" />

interface Window {
  harnessDesktop?: {
    platform: string;
    getUpdateReady(): Promise<string | undefined>;
    onUpdateReady(callback: (version: string) => void): () => void;
    restartToUpdate(): Promise<void>;
  };
}
