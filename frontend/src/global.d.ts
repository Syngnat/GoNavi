export {};

declare global {
  interface Window {
    go: any;
    runtime: {
        WindowMinimise: () => void;
        WindowToggleMaximise: () => void;
        Quit: () => void;
        BrowserOpenURL: (url: string) => void;
    };
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => void;
      on: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
      off: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
      invoke: (channel: string, ...args: any[]) => Promise<any>;
    };
  }
}
