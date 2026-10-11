#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyWindowsNativeArtifact } from "./lib/windows-native-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await verifyWindowsNativeArtifact(root);
process.stdout.write(`${JSON.stringify({ ok: true, ...manifest })}\n`);
