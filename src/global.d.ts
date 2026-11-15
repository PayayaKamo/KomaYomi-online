export {};

declare global {
  interface Window {
    /** Desktop bridge injected by Electron; undefined in the browser. */
    mangaDesktop?: {
      pickFolder: (title?: string) => Promise<string | null>;
      platform: string;
    };
  }
}
