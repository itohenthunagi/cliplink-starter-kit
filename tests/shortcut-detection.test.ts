import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ondemandShortcutsInstalled, readTriggerHotkeys, windowsTriggerInstalled } from "../src/server/shortcut-detection";

describe("ondemandShortcutsInstalled", () => {
  it("win32以外では常にfalse", async () => {
    expect(await ondemandShortcutsInstalled("darwin", "C:\\Users\\test\\AppData\\Roaming")).toBe(false);
  });
  it("APPDATA未設定ならfalse", async () => {
    expect(await ondemandShortcutsInstalled("win32", undefined)).toBe(false);
  });
  it(".lnk未インストールならfalse、インストール後はtrue", async () => {
    const appData = await mkdtemp(join(tmpdir(), "cliplink-appdata-"));
    expect(await ondemandShortcutsInstalled("win32", appData)).toBe(false);
    const dir = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Cliplink");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Cliplink 範囲撮影.lnk"), "");
    expect(await ondemandShortcutsInstalled("win32", appData)).toBe(true);
  });
});

describe("windowsTriggerInstalled", () => {
  it("win32以外では常にfalse", async () => {
    expect(await windowsTriggerInstalled("darwin", "C:\\Users\\test\\AppData\\Local")).toBe(false);
  });
  it("LOCALAPPDATA未設定ならfalse", async () => {
    expect(await windowsTriggerInstalled("win32", undefined)).toBe(false);
  });
  it("トリガー未導入ならfalse、導入後はtrue", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "cliplink-localappdata-"));
    expect(await windowsTriggerInstalled("win32", localAppData)).toBe(false);
    const dir = join(localAppData, "Cliplink", "Trigger");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "CliplinkTrigger.exe"), "");
    expect(await windowsTriggerInstalled("win32", localAppData)).toBe(true);
  });
});

describe("readTriggerHotkeys", () => {
  it("未保存なら初期値、保存済みなら常駐プログラムが書いた値を返す", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "cliplink-hotkeys-"));
    expect(await readTriggerHotkeys(localAppData)).toEqual({ image: "Ctrl+Alt+S", video: "Ctrl+Alt+R", open: "" });
    const dir = join(localAppData, "Cliplink", "Trigger");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "hotkeys.json"), JSON.stringify({ image: "Ctrl+Shift+1", video: "Alt+F9", open: "Ctrl+Alt+L" }));
    expect(await readTriggerHotkeys(localAppData)).toEqual({ image: "Ctrl+Shift+1", video: "Alt+F9", open: "Ctrl+Alt+L" });
    await writeFile(join(dir, "hotkeys.json"), "{broken");
    expect((await readTriggerHotkeys(localAppData)).image).toBe("Ctrl+Alt+S");
  });
});
