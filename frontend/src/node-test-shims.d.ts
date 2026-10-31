declare module 'node:fs' {
  interface FileBuffer extends Uint8Array {
    subarray(begin?: number, end?: number): FileBuffer;
    toString(encoding?: 'utf8'): string;
  }

  export function existsSync(path: string | URL): boolean;
  export function readdirSync(path: string | URL): string[];
  export function realpathSync(path: string | URL): string;
  export function readFileSync(path: string | URL): FileBuffer;
  export function readFileSync(path: string | URL, encoding: string): string;
  export function statSync(path: string | URL): { isDirectory(): boolean };
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;

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

declare module 'node:crypto' {
  interface Hash {
    update(data: Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }

  export function createHash(algorithm: 'sha256'): Hash;
  export const webcrypto: Crypto;
}

declare const process: {
  cwd(): string;
};
