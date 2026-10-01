// V8 heap policy for the frontend build (tsc and vite build).
//
// On machines with less than 16GB of RAM, V8 caps the old generation at about
// 2GB (heap_size_limit ≈ 2096MB), while this project's vite build needs about
// 2.5GB of heap and tsc about 2GB. Without an explicit limit, an 8GB Linux
// machine fails `wails build` at "Compiling frontend" with "JavaScript heap out
// of memory". Developer machines and CI runners with 16GB+ already default to
// 4GB, which is why the failure never shows up there.
import os from 'node:os';
import v8 from 'node:v8';

const MB = 1024 * 1024;

// Smallest limit that completes vite build (2560MB passes, 2048MB runs out),
// with headroom for growth.
export const MIN_BUILD_HEAP_MB = 3072;
// Limit used when memory is plentiful; matches the V8 default on 16GB+ machines.
export const PREFERRED_BUILD_HEAP_MB = 4096;
// Below this, only grant the minimum: a larger heap delays GC and raises RSS.
export const ROOMY_MEMORY_MB = 6144;
// Below this, the build is likely to run out of memory regardless of the limit.
export const LOW_MEMORY_WARNING_MB = 4096;

export const detectMemoryMB = () => {
  const total = os.totalmem();
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  const effective = constrained > 0 && constrained < total ? constrained : total;
  return Math.floor(effective / MB);
};

export const currentHeapLimitMB = () => Math.floor(v8.getHeapStatistics().heap_size_limit / MB);

// Returns the --max-old-space-size to pass, or null when the current limit is
// already large enough (including a larger limit set through NODE_OPTIONS).
export const resolveBuildHeapLimitMB = ({ memoryMB, currentLimitMB }) => {
  const target = memoryMB >= ROOMY_MEMORY_MB ? PREFERRED_BUILD_HEAP_MB : MIN_BUILD_HEAP_MB;
  return currentLimitMB >= target ? null : target;
};

// A V8 heap exhaustion aborts (SIGABRT) and the kernel OOM killer sends SIGKILL;
// behind a shell they surface as exit codes 134 and 137.
export const isOutOfMemoryExit = ({ status, signal }) => (
  signal === 'SIGABRT' || signal === 'SIGKILL' || status === 134 || status === 137
);
