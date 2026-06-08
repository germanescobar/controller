export type ControllerStatus =
  | { state: "starting"; port: number }
  | { state: "listening"; port: number }
  | { state: "error"; port?: number; message: string };

export interface ControllerCheckResult {
  available: boolean;
  suggestion?: number;
  error?: string;
}

export interface ControllerBridge {
  isElectron: true;
  checkPort: (port: number) => Promise<ControllerCheckResult>;
  startServer: (port: number) => Promise<{ port: number; url: string }>;
  onStatus: (cb: (status: ControllerStatus) => void) => () => void;
  navigateToApp: (url: string) => void;
  showWindow: () => void;
  quit: () => void;
}
