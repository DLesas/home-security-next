# `.github/workflows/`: owner A9

M2, step 1 (docs/m2-design.md section 11): the continuous integration of M2, the installer matrix (macOS arm64, Ubuntu x64 and arm64, Windows x64) and the browser tests (`bun run app:e2e`). `windows-spikes.yml` is the W2 and W3 spikes' and stays as it is.

**Frozen for you** (changed only through the step 0 owner): the root's `bun run check` and its steps.

Check your work with `bun run check:own A9`.
