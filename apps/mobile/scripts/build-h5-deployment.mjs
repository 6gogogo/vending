import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mobileRoot = fileURLToPath(new URL("../", import.meta.url));
const buildCommand =
  process.platform === "win32"
    ? {
        command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
        args: ["/d", "/s", "/c", "npm run build"]
      }
    : {
        command: "npm",
        args: ["run", "build"]
      };
const buildResult = spawnSync(buildCommand.command, buildCommand.args, {
  cwd: mobileRoot,
  env: {
    ...process.env,
    VITE_MOBILE_H5_PUBLIC_BASE: "/mobile/",
    VITE_SHOW_VERIFICATION_PREVIEW: "false"
  },
  stdio: "inherit"
});

if (buildResult.error) {
  throw buildResult.error;
}

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

await import("./smoke-h5-deployment-build.mjs");
