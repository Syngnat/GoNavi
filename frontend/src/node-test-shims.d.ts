declare module 'node:fs' {
  export function readdirSync(path: string | URL): string[];
  export function realpathSync(path: string | URL): string;
  export function readFileSync(path: string | URL, encoding: string): string;
  export function statSync(path: string | URL): { isDirectory(): boolean };
}

declare module 'node:path' {
  interface PathModule {
    dirname(path: string): string;
    resolve(...paths: string[]): string;
  }

  const path: PathModule;
  export default path;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
