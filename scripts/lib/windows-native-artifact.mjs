import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Package-relative coordinates of the bundled Windows x64 native artifact. */
export const WINDOWS_NATIVE_ARTIFACT_PATHS = {
  manifest: "native/windows/build/manifest.json",
  artifact: "native/windows/build/rea-windows-x64.node",
};

/** Whether bytes are the Windows x64 PE32+ image the native loader admits. */
export const isWindowsX64PeImage = (bytes) => {
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
  return (
    bytes.toString("ascii", 0, 2) === "MZ" &&
    offset <= bytes.length - 26 &&
    bytes.toString("ascii", offset, offset + 4) === "PE\0\0" &&
    bytes.readUInt16LE(offset + 4) === 0x8664 &&
    bytes.readUInt16LE(offset + 24) === 0x20b
  );
};

/**
 * Validate the bundled artifact against the package that owns it.
 *
 * The package version, declared platform/ABI metadata, artifact SHA-256 and PE
 * machine must all agree; a missing file surfaces as ENOENT so callers can
 * distinguish "not provisioned" from "provisioned but wrong".
 */
export const verifyWindowsNativeArtifact = async (packageRoot) => {
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(
      join(packageRoot, WINDOWS_NATIVE_ARTIFACT_PATHS.manifest),
      "utf8",
    ),
  );
  const bytes = await readFile(
    join(packageRoot, WINDOWS_NATIVE_ARTIFACT_PATHS.artifact),
  );
  if (
    manifest.packageVersion !== packageJson.version ||
    manifest.platform !== "win32" ||
    manifest.architecture !== "x64" ||
    manifest.abiVersion !== 1 ||
    manifest.nodeApiVersion !== 8 ||
    manifest.artifact !== "rea-windows-x64.node" ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.artifactSha256
  )
    throw new Error(
      "Windows native artifact metadata or SHA-256 does not match this package; run the Windows native build lane.",
    );
  if (!isWindowsX64PeImage(bytes))
    throw new Error(
      "Windows native artifact must be a Windows x64 PE32+ image.",
    );
  return { ...manifest, artifactBytes: bytes.length };
};
