import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

// windows-install-shortcuts.ps1 が作る Start Menu の .lnk (Ctrl+Alt+S) の実在を確認する。
// .lnkインストール後に手動でnpm startした場合でも、常駐版のlegacy RegisterHotKeyが
// 同じCtrl+Alt+S/Rを取り合わないようにするための判定。
export async function ondemandShortcutsInstalled(
  platform: NodeJS.Platform,
  appData: string | undefined,
): Promise<boolean> {
  if (platform !== "win32" || !appData) return false;
  const dir = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Cliplink");
  try {
    await access(join(dir, "Cliplink 範囲撮影.lnk"));
    return true;
  } catch {
    return false;
  }
}

// 常駐プログラムの通知領域メニューで変更したショートカット（hotkeys.json）。未設定なら初期値。
// 管理画面の案内表示だけに使う。登録そのものは常駐プログラムが行う。
export async function readTriggerHotkeys(localAppData: string | undefined) {
  const keys = { image: "Ctrl+Alt+S", video: "Ctrl+Alt+R", open: "" };
  if (!localAppData) return keys;
  try {
    const saved = JSON.parse(
      await readFile(join(localAppData, "Cliplink", "Trigger", "hotkeys.json"), "utf8"),
    ) as Partial<typeof keys>;
    for (const name of ["image", "video", "open"] as const)
      if (typeof saved[name] === "string") keys[name] = saved[name];
  } catch {
    /* 未保存・読めない場合は初期値 */
  }
  return keys;
}

// windows-install-trigger.ps1 がLocalAppData配下に置く常駐トリガー(RegisterHotKeyリスナー)の実在を確認する。
// 手動でnpm startした場合でも、新トリガーと同じCtrl+Alt+S/Rをlegacyの常駐RegisterHotKeyが
// 取り合わないようにするための判定。
export async function windowsTriggerInstalled(
  platform: NodeJS.Platform,
  localAppData: string | undefined,
): Promise<boolean> {
  if (platform !== "win32" || !localAppData) return false;
  const exePath = join(localAppData, "Cliplink", "Trigger", "CliplinkTrigger.exe");
  try {
    await access(exePath);
    return true;
  } catch {
    return false;
  }
}
