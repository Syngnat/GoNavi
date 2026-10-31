# Local plugin runtime

This package implements the version-one [integration contract](https://plugin.gonavi.org/docs/implementation-contract). It runs explicitly trusted third-party code out of process. It is a reliability and capability-routing boundary, **not an OS security sandbox**: a plugin still has its user's operating-system privileges.

## Implemented behavior

- Strict manifest versions, semver/dependencies, portable paths, runtime types, command references, and bounded declarative UI. Unknown manifest fields fail closed. Permissions are trust-preview declarations, not implicit host API grants.
- No-execution directory/ZIP/TGZ inspection, including extensionless downloads. Size, central-directory allocation, explicit/implicit entry counts, links, devices, case collisions, and traversal are bounded or rejected.
- Exact inspected-digest installation stages and rehashes a copy, normalizes permissions, then publishes a content-addressed package and atomic state record. Initial install and updates are disabled. Stopping instances must finish before replacement/removal.
- Mutable data lives outside packages. Purge uses a durable tombstone so retries cannot delete a concurrent reinstall's data. Unreferenced immutable generations are retained; automatic store garbage collection is not implemented.
- Short OS-locked read-modify-write transactions merge concurrent controllers. Only Start acquires the runtime-owner lease. Controller-only managers never execute code. External intent is reconciled every 50 ms by default (configurable up to 250 ms); this is a polling interval, not an OS real-time guarantee.
- Persistent global generations survive remove/reinstall. InvokeGeneration fences admission and completion. Disable revokes local admissions and request contexts before writing intent, never awaiting plugin cooperation. State remains stopping until reaped. Persistence failure during local disable stops the owner fail-closed.
- Asynchronous initialization and heartbeat supervision. Crashes, initialization/protocol/heartbeat faults, and command deadlines persist quarantine. Explicit enable retries; there is no automatic crash-restart loop. Missing/incompatible dependencies and cycles block activation without downloading anything.
- Windows starts suspended, assigns a kill-on-close Job Object, then resumes. Unix uses a dedicated process group. Graceful shutdown gets at most two seconds before tree termination/reaping. Deliberately escaping a Unix process group is outside this non-sandbox guarantee.
- Declared commands only; explicit Node/Python discovery; missing interpreters fail visibly. Child environment excludes host RPC/auth tokens and injection variables. Only explicitly registered host methods (`host.log`, `host.describe`, `host.capability`) are accepted; arbitrary App reflection is never exposed.
- Assets require enabled/running state and regular immutable-package files. Traversal, symlinks, and disabled/faulted generations are rejected. Consumers additionally bind their UI capability to a captured generation.

## Default bounds

| Resource | Limit |
| --- | --- |
| Archive / extracted bytes | No fixed MB cap; entries stream to disk/hash; bounded by 4,096 entries and available disk |
| Explicit and implicit paths | 4,096; depth 32; path length 1,024 bytes |
| Manifest / ZIP directory | 1 MiB manifest; ZIP64 accepted; archive/zip validates the directory |
| Installed records / state | 128 / 32 MiB |
| UI tree | 512 nodes, depth 16; 32 columns and 500 rows/table |
| RPC frame / stdout rate | 1 MiB / 256 frames and 8 MiB per second |
| Stderr | Drained with a 1 MiB lifetime budget; never forwarded to UI/logs |
| Invocations | 16 concurrent/plugin; 30-second default deadline |
| Pending RPC requests | 64; canceled slots retained until reply/exit |
| Handshake / probes / stop | 10 seconds / 1-second probes, three misses / at most 2 seconds |

Canonical digest: SHA-256 over sorted file records consisting of path, NUL, decimal size, NUL, content SHA-256 hex, and newline. Archive transport checksums are separate. Empty directories and source permission bits do not affect the digest; installation creates file-parent directories only and normalizes permissions. Read-only package files are not protected against a trusted same-user process deliberately changing them. Activation verifies the entire package digest again.

## Evidence and remaining boundaries

Real subprocess tests cover success, crashes, initialization/heartbeat hangs, ignored cancellation/shutdown, malformed/oversized stdout, stderr floods, busy disable, descendant termination, durable quarantine, and external-process disable while the owner lease is held. Additional tests cover reinstall generations, dependencies/cycles, safe mode, state-writer races, permission re-trust, digest changes, rollback, purge tombstones, links, hostile archives, and tampering.

The current development host executes Windows tests and go vet. Linux/amd64 and Darwin/arm64 are cross-built, not runtime-tested here. The race detector requires cgo; this host has cgo disabled and no C compiler on PATH.

Not implemented here: configuration editing/schema evaluation, automatic dependency downloads, cross-process invocation transport, marketplace networking, native UI hosting, OS CPU/memory quotas, or a security sandbox. Host capability dispatch (`host.capability`) is provided by the embedding application through `Options.HostCapability`; this package only enforces caller binding and frame bounds. A second process can change management intent but cannot invoke through the first owner's process: CLI invocation must own the runtime lease or report owner-busy.
