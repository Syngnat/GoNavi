# @syngnat/gonavi-cli

The npm wrapper is not currently published. Install the standalone `gonavi`
executable directly from a GoNavi GitHub Release instead: download the matching
platform archive and its independent `gonavi-cli_${VERSION}_checksums.txt`
file, verify SHA256, extract the archive, then run `gonavi list-connections`.

This package source remains in the repository for a future opt-in npm
distribution. If that distribution is enabled, its lifecycle will download the
matching release archive, verify SHA256, check the fixed archive entries, and
only then install the executable.

The package does not store credentials or configure a separate data directory;
the executable keeps the normal `GONAVI_DATA_ROOT` and `~/.gonavi` resolution.
Set `GONAVI_CLI_RELEASE_BASE_URL` only when using a mirror that preserves the
same release asset names and checksum file.
