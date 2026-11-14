# `hub/src/shell/safe/`: the shell's wrappers of throwing APIs (HD 10)

Every `try` of the hub lives here. In M2, step 1 (docs/m2-design.md section 11), **owner A11** owns `serial*.ts`, the serial path, which W1 decides on Windows (Win32 through `bun:ffi`, or a native helper on every system), and any new file here its paths need (`ffi-*.ts`, `worker-*.ts`, `control-socket*.ts`). The other files stay as built, and a change to one goes through the step 0 owner (section 11, "The four readings of ownership").

**Frozen for you** (changed only through the step 0 owner): `hub/src/core/model/`, `hub/src/core/step.ts`, `hub/src/db/`, `hub/src/control-protocol/`, `hub/src/ports/`, and the types of `packages/protocol/src/app/`.

Check your work with `bun run check:own A11`.
