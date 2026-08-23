# GoNavi CLI WinGet manifest

The standalone CLI uses the separate package identifier
`Syngnat.GoNavi.CLI`; the existing desktop GoNavi package is not changed.

Generate the manifest only from a stable release's independent checksum file:

```bash
python3 tools/generate-winget-cli-manifest.py \
  --version 0.9.3 \
  --checksums cli-assets/gonavi-cli_0.9.3_checksums.txt \
  --output Syngnat.GoNavi.CLI.yaml
```

The generator requires exactly the six CLI archive entries and copies only the
Windows x64/arm64 hashes into the manifest. Submit the generated file to the
WinGet community repository after the corresponding immutable release assets
are available; do not hand-edit installer URLs or SHA256 values.
