/**
 * `@hsn/protocol/release`: the signed release files the hub installs and the relay serves, hub
 * releases (`.hsnr`) and firmware releases (`.hsnf`), with both manifest schemas (m4-design.md
 * section 6; m3-updates-design.md section 3). Frozen by the joint step 0 (docs/m3-m4-plan.md).
 */
export {
  FIRMWARE_RELEASE,
  type FirmwareManifest,
  firmwareManifestRefusal,
  firmwareManifestSchema,
  firmwareReleaseFileName,
  HUB_RELEASE,
  type HubManifest,
  hubManifestSchema,
  hubReleaseFileName,
  parseReleaseFileName,
  type ReleaseFile,
  type ReleaseFileName,
  releaseFileSchema,
  RELEASE_PLATFORMS,
  RELEASE_VERSION,
  type ReleasePlatform,
} from "./manifests.ts";
