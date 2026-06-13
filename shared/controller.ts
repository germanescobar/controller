export type ControllerStatus =
  | { state: "starting"; port: number }
  | { state: "listening"; port: number }
  | { state: "error"; port?: number; message: string };

export interface ControllerCheckResult {
  available: boolean;
  suggestion?: number;
  error?: string;
}

export interface PreviewUrlCheckResult {
  allowed: boolean;
  url?: string;
  error?: string;
}

export interface ControllerBridge {
  isElectron: true;
  checkPort: (port: number) => Promise<ControllerCheckResult>;
  startServer: (port: number) => Promise<{ port: number; url: string }>;
  onStatus: (cb: (status: ControllerStatus) => void) => () => void;
  // Synchronously read the latest known status. Returns null if the
  // server hasn't been started in this process yet. Useful for
  // re-mounting UI that needs the current state without waiting
  // for the next broadcast.
  getStatus: () => ControllerStatus | null;
  validatePreviewUrl: (
    url: string,
    projectRoot?: string
  ) => Promise<PreviewUrlCheckResult>;
  navigateToApp: (url: string) => void;
  showWindow: () => void;
  quit: () => void;
}
