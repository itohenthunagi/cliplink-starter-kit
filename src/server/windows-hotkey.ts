import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

export type HotkeyState = "starting" | "ready" | "image-only" | "failed" | "unavailable" | "off";

export function startWindowsHotkey(origin: string, token: string, shareBase = origin) {
  let state: HotkeyState = "starting";
  let videoRegistered = false;
  const child: ChildProcessWithoutNullStreams = spawn(
    "powershell.exe",
    ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/windows-hotkey.ps1")],
    {
      windowsHide: true,
      env: {
        ...process.env,
        CLIPLINK_ORIGIN: origin,
        CLIPLINK_LOCAL_TOKEN: token,
        CLIPLINK_SHARE_BASE: shareBase,
        CLIPLINK_PARENT_PID: String(process.pid),
      },
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    const lines = output.split(/\r?\n/);
    output = lines.pop() || "";
    for (const line of lines) {
      if (line === "READY") { state = "ready"; videoRegistered = true; }
      if (line === "READY_IMAGE_ONLY") state = "image-only";
      if (line === "CAPTURED") state = videoRegistered ? "ready" : "image-only";
      if (line.startsWith("ERROR")) {
        if (state === "starting") state = "unavailable";
        else if (line.startsWith("ERROR import-failed") || line.startsWith("ERROR capture-failed") || line.startsWith("ERROR video-")) state = "failed";
        console.error(`Cliplink hotkey: ${line}`);
      }
    }
  });
  child.on("error", () => { state = "unavailable"; });
  child.on("exit", () => { state = "unavailable"; });
  return { status: () => state, stop: () => child.kill() };
}
