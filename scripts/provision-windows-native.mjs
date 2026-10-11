#!/usr/bin/env node

// Provision the bundled Windows x64 native artifact into a source checkout.
//
// The artifact lane builds only on Linux with MinGW-w64, so a Windows
// development checkout cannot produce native/windows/build/*. This script
// fetches the published tarball for this exact package version, verifies it
// against the registry's published integrity, and extracts the two packaged
// files, so a source checkout can exercise Windows native controls without a
// Linux build.
//
// The addon is never loaded or executed here. `verify-windows-native-artifact`
// and the Windows conformance lane remain the authorities on real behavior.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  WINDOWS_NATIVE_ARTIFACT_PATHS,
  isWindowsX64PeImage,
} from "./lib/windows-native-artifact.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.slice(2).includes("--check");
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const packageName = packageJson.name;
const packageVersion = packageJson.version;
const destination = (relativePath) => join(root, relativePath);
const report = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

// Prefer the caller's registry configuration so a mirror or offline proxy
// resolves exactly as an ordinary `npm install` would.
const registry = (
  process.env.REA_NPM_REGISTRY ??
  process.env.npm_config_registry ??
  "https://registry.npmjs.org"
).replace(/\/+$/u, "");

const packumentUrl = () => `${registry}/${packageName.replace("/", "%2f")}`;
const tarballUrl = (path) =>
  path.startsWith("http") ? path : `${registry}${path}`;

const fetchBytes = async (url, accept) => {
  const response = await fetch(url, {
    headers: accept === undefined ? {} : { accept },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`Registry request failed: ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/** Match the digest npm itself checks when installing this tarball. */
const verifyTarballIntegrity = (bytes, dist) => {
  const integrity = dist?.integrity;
  if (typeof integrity === "string" && integrity.includes("-")) {
    const [algorithm, expected] = integrity.split("-", 2);
    const actual = createHash(algorithm).update(bytes).digest("base64");
    if (actual !== expected)
      throw new Error(
        `Published tarball ${algorithm} integrity does not match the registry: ${actual}`,
      );
    return integrity;
  }
  if (typeof dist?.shasum === "string") {
    const actual = createHash("sha1").update(bytes).digest("hex");
    if (actual !== dist.shasum)
      throw new Error(
        `Published tarball SHA-1 does not match the registry: ${actual}`,
      );
    return `sha1-${actual}`;
  }
  throw new Error(
    `Registry metadata for ${packageName}@${packageVersion} declares no tarball integrity`,
  );
};

const validateArtifact = (manifest, bytes) => {
  if (manifest.packageVersion !== packageVersion)
    throw new Error(
      `Published ${packageName}@${packageVersion} declares native artifact version ${String(manifest.packageVersion)}`,
    );
  if (
    manifest.platform !== "win32" ||
    manifest.architecture !== "x64" ||
    manifest.abiVersion !== 1 ||
    manifest.nodeApiVersion !== 8 ||
    manifest.artifact !== "rea-windows-x64.node"
  )
    throw new Error(
      `Published native manifest is not the expected Windows x64 Node-API 8 artifact: ${JSON.stringify(manifest)}`,
    );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.artifactSha256)
    throw new Error(
      `Published native artifact SHA-256 does not match its manifest: ${digest}`,
    );
  if (!isWindowsX64PeImage(bytes))
    throw new Error(
      "Published native artifact is not a Windows x64 PE32+ image.",
    );
  return digest;
};

/**
 * Replace one provisioned file through a staging name.
 *
 * Windows refuses both an in-place overwrite and a rename over the entry while
 * another process has the addon mapped, so a running REA blocks the update.
 * Writing the new bytes to a staging path first means a failure cannot truncate
 * the previous artifact, and the caller sees the actionable reason.
 */
const replaceFile = async (target, content) => {
  const staging = `${target}.provisioning`;
  await writeFile(staging, content);
  try {
    await rename(staging, target);
  } catch (cause) {
    await rm(staging, { force: true });
    if (cause?.code === "EPERM" || cause?.code === "EBUSY")
      throw new Error(
        `Cannot replace ${target}: another process has it open. Stop every REA CLI/MCP process using this checkout, then rerun.`,
        { cause },
      );
    throw cause;
  }
};

const currentArtifact = async () => {
  try {
    return {
      manifest: JSON.parse(
        await readFile(
          destination(WINDOWS_NATIVE_ARTIFACT_PATHS.manifest),
          "utf8",
        ),
      ),
      bytes: await readFile(
        destination(WINDOWS_NATIVE_ARTIFACT_PATHS.artifact),
      ),
    };
  } catch (cause) {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  }
};

const installed = await currentArtifact();
if (installed !== undefined) {
  const digest = validateArtifact(installed.manifest, installed.bytes);
  report({
    status: "already-present",
    package: `${packageName}@${packageVersion}`,
    artifact: WINDOWS_NATIVE_ARTIFACT_PATHS.artifact,
    artifact_sha256: digest,
    artifact_bytes: installed.bytes.length,
  });
} else if (checkOnly) {
  report({
    status: "missing",
    package: `${packageName}@${packageVersion}`,
    artifact: WINDOWS_NATIVE_ARTIFACT_PATHS.artifact,
    action:
      "Run `npm run provision:windows-native` to extract the matching published artifact.",
  });
  process.exitCode = 1;
} else {
  const packument = JSON.parse(
    (
      await fetchBytes(packumentUrl(), "application/vnd.npm.install-v1+json")
    ).toString("utf8"),
  );
  const version = packument.versions?.[packageVersion];
  const dist = version?.dist;
  if (version === undefined || dist?.tarball === undefined)
    throw new Error(
      `Registry ${registry} has no published ${packageName}@${packageVersion}`,
    );
  const tarball = await fetchBytes(tarballUrl(dist.tarball));
  const tarballIntegrity = verifyTarballIntegrity(tarball, dist);

  const workspace = await mkdtemp(
    join(tmpdir(), "rea-windows-native-provision-"),
  );
  try {
    const archive = join(workspace, "package.tgz");
    await writeFile(archive, tarball);
    // `tar` ships with Windows 10+ and macOS, and the artifact lane already
    // depends on it, so no additional archive dependency is introduced. npm
    // tarballs place every entry beneath a `package/` prefix.
    await exec(
      "tar",
      [
        "xzf",
        archive,
        "-C",
        workspace,
        `package/${WINDOWS_NATIVE_ARTIFACT_PATHS.manifest}`,
        `package/${WINDOWS_NATIVE_ARTIFACT_PATHS.artifact}`,
      ],
      { cwd: workspace, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const extracted = join(workspace, "package");
    const manifest = JSON.parse(
      await readFile(
        join(extracted, WINDOWS_NATIVE_ARTIFACT_PATHS.manifest),
        "utf8",
      ),
    );
    const bytes = await readFile(
      join(extracted, WINDOWS_NATIVE_ARTIFACT_PATHS.artifact),
    );
    const digest = validateArtifact(manifest, bytes);
    // Replace both files only after every check passed, so a failed run never
    // leaves a manifest that disagrees with the artifact beside it.
    for (const relativePath of [
      WINDOWS_NATIVE_ARTIFACT_PATHS.manifest,
      WINDOWS_NATIVE_ARTIFACT_PATHS.artifact,
    ]) {
      const target = destination(relativePath);
      await mkdir(dirname(target), { recursive: true });
      await replaceFile(target, await readFile(join(extracted, relativePath)));
    }
    report({
      status: "provisioned",
      package: `${packageName}@${packageVersion}`,
      source: `published npm tarball (${registry})`,
      tarball_integrity: tarballIntegrity,
      artifact: WINDOWS_NATIVE_ARTIFACT_PATHS.artifact,
      artifact_sha256: digest,
      artifact_bytes: bytes.length,
      next: "Run `npm run verify:windows-native:artifact`, then restart REA.",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
