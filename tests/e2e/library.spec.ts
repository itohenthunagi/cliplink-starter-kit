import { test, expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const evidence = "tmp/screenshots/2026-09-22";
async function fixture(page: Page, label: string, color = "#dcecc9") {
  const p = await page.context().newPage();
  await p.setContent(
    `<html><body style="margin:0;background:#f5f7f0;font:20px sans-serif;color:#264736"><main style="width:850px;padding:60px"><div style="font-size:12px;letter-spacing:5px">SAMPLE CAPTURE</div><h1>${label}</h1><p>設定を開いて、保存先のフォルダを選択します。</p><div style="background:white;border:1px solid #d5dfcb;border-radius:12px;padding:32px;margin-top:30px"><p style="font-size:15px">ライブラリの保存先</p><div style="background:${color};padding:22px;border-radius:8px">ScreenShare / assets</div><p style="text-align:right;font-size:14px;margin-top:35px">変更を保存 →</p></div><p style="font-size:12px;color:#8a9980;margin-top:40px">Cliplink 検証用サンプル</p></main></body></html>`,
  );
  await p.setViewportSize({ width: 970, height: 620 });
  const buffer = await p.screenshot();
  await p.close();
  return buffer;
}
async function add(page: Page, title: string, bytes: Buffer) {
  await page
    .getByRole("button", { name: "＋ ファイルを追加", exact: true })
    .first()
    .click();
  await page
    .locator("#file-input")
    .setInputFiles({
      name: title + ".png",
      mimeType: "image/png",
      buffer: bytes,
    });
  await page.locator('#upload-form input[name="title"]').fill(title);
  await page.getByRole("button", { name: "追加する", exact: true }).click();
  await expect(page.locator("#detail h2")).toHaveText(title);
}
async function publish(page: Page) {
  await page
    .locator("#detail")
    .getByRole("button", { name: /この版を/ })
    .click();
  await page.locator("#confirm").click();
  await expect(page.locator("#detail .badge").first()).toHaveText("公開中");
  return page.getByLabel("共有URL", { exact: true }).inputValue();
}
test("画像の登録、注釈、固定URL更新、保護、コレクション、停止を画面から操作", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "キャプチャライブラリ" }),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidence}/empty-library.png`,
    fullPage: true,
  });
  const original = await fixture(page, "01 保存先の設定");
  await add(page, "保存先の設定", original);
  await page
    .locator('#metadata-form textarea[name="notes"]')
    .fill("internal-only-PRIVATE-NOTE");
  await page
    .locator('#metadata-form input[name="sourceUrl"]')
    .fill("https://private.example.test/source");
  await page.getByRole("button", { name: "情報を保存", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("情報を保存しました");
  await expect(page.locator("#detail .badge").first()).toHaveText("公開中");
  const url = await page.getByLabel("共有URL", { exact: true }).inputValue();
  const pub = await context.newPage();
  await pub.goto(url);
  await expect(pub.locator("img")).toBeVisible();
  const initialSrc = await pub.locator("img").getAttribute("src");
  const initialMedia = await (await pub.request.get(initialSrc!)).body();
  expect(initialMedia).toEqual(original);
  const html = await pub.content();
  expect(html).not.toContain("PRIVATE-NOTE");
  expect(html).not.toContain("private.example.test");
  expect(html).not.toContain("original/");
  await page.getByRole("button", { name: "↗ 注釈を付ける" }).click();
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.63);
  await page.mouse.up();
  await page.getByRole("button", { name: "① 番号" }).click();
  await canvas.click({
    position: { x: box.width * 0.15, y: box.height * 0.63 },
  });
  await page.getByRole("button", { name: "■ 黒塗り" }).click();
  await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.59);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.68);
  await page.mouse.up();
  await page.screenshot({
    path: `${evidence}/annotation-editor.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "作業版として保存", exact: true })
    .click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await pub.reload();
  expect(await (await pub.request.get(initialSrc!)).body()).toEqual(original);
  const changedUrl = await publish(page);
  expect(changedUrl).toBe(url);
  await pub.reload();
  expect(await (await pub.request.get(initialSrc!)).body()).not.toEqual(
    original,
  );
  await pub.screenshot({
    path: `${evidence}/public-annotated.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "保管済みへ移す", exact: true })
    .click();
  await page.locator("#confirm").click();
  await expect(page.locator("#toast")).toContainText("公開中");
  await page
    .locator("#modal")
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  await page
    .getByRole("button", { name: "削除から保護する", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "✓ 保護中 · 解除する" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "詳細を閉じる", exact: true }).click();
  const second = await fixture(page, "02 共有リンクをコピー", "#e4eadf");
  await add(page, "共有リンクをコピー", second);
  await expect(page.locator("#detail .badge").first()).toHaveText("公開中");
  await page.getByRole("button", { name: "詳細を閉じる", exact: true }).click();
  await page.getByLabel("保存先の設定を選択", { exact: true }).check();
  await page.getByLabel("共有リンクをコピーを選択", { exact: true }).check();
  await page.getByRole("button", { name: "2件をまとめて共有 →" }).click();
  await page.locator('#collection-form input[name="title"]').fill("設定の手順");
  await page.getByLabel("2番目を上へ", { exact: true }).click();
  await page
    .getByRole("button", { name: "コレクションを公開", exact: true })
    .click();
  await expect(page.locator(".collection-card h2")).toHaveText("設定の手順");
  const state = await (await page.request.get("/api/entities")).json();
  const collection = state.find(
    (e: { kind: string }) => e.kind === "collection",
  );
  await pub.goto(`/s/${collection.slug}`);
  await expect(pub.locator("figcaption")).toHaveText([
    "共有リンクをコピー",
    "保存先の設定",
  ]);
  await pub.screenshot({
    path: `${evidence}/collection-share.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: /すべてのキャプチャ/ }).click();
  await page.screenshot({ path: `${evidence}/library.png`, fullPage: true });
  await page.getByLabel("キャプチャを検索").fill("保存先");
  await expect(page.locator(".capture-card")).toHaveCount(1);
  await page.getByLabel("キャプチャを検索").fill("");
  await page
    .getByRole("button", { name: "保存先の設定の詳細", exact: true })
    .click();
  await page.getByRole("button", { name: "共有を停止", exact: true }).click();
  await page.locator("#confirm").click();
  await expect(page.locator("#detail .badge").first()).toHaveText("共有停止");
  expect((await pub.request.get(url)).status()).toBe(404);
  expect((await pub.request.get(initialSrc!)).status()).toBe(404);
  await pub.reload();
  await expect(pub.locator("figcaption")).toHaveText(["共有リンクをコピー"]);
  await page
    .getByRole("button", { name: "保管済みへ移す", exact: true })
    .click();
  await page.locator("#confirm").click();
  await expect(page.locator("#toast")).toContainText("削除保護中");
  await page.screenshot({
    path: `${evidence}/deletion-protection.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("ブラウザの撮影・録画パイプラインとモバイル幅", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      value: async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 450;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#d9e8ce";
        ctx.fillRect(0, 0, 800, 450);
        ctx.fillStyle = "#284d36";
        ctx.font = "40px sans-serif";
        ctx.fillText("Capture pipeline test", 70, 180);
        const stream = canvas.captureStream(15);
        const interval = setInterval(() => {
          ctx.fillRect(50, 250, 150, 20);
        }, 50);
        stream
          .getTracks()[0]
          .addEventListener("ended", () => clearInterval(interval));
        return stream;
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "▣ 範囲を撮影", exact: true }).click();
  await expect(page.locator(".region-overlay")).toBeVisible();
  const regionImage = (await page.locator(".region-stage img").boundingBox())!;
  await page.mouse.move(regionImage.x + 80, regionImage.y + 45);
  await page.mouse.down();
  await page.mouse.move(regionImage.x + 480, regionImage.y + 270);
  await page.mouse.up();
  await expect(page.locator("#detail h2")).toContainText("画面キャプチャ");
  expect(await page.locator("#detail img").evaluate((img: HTMLImageElement) =>
    [img.naturalWidth, img.naturalHeight])).toEqual([400, 225]);
  await expect(page.locator("#detail .badge").first()).toHaveText("公開中");
  await page.getByRole("button", { name: "詳細を閉じる" }).click();
  await page.getByRole("button", { name: "◉ 画面録画", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "■ 録画を停止" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /公開中/ }).click();
  await expect(
    page.getByRole("button", { name: "■ 録画を停止" }),
  ).toBeVisible();
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "■ 録画を停止" }).click();
  await expect(page.locator("#detail h2")).toContainText("画面録画");
  await expect(page.locator("#detail .badge").first()).toHaveText("公開中");
  const url = await page.getByLabel("共有URL", { exact: true }).inputValue();
  const pub = await page.context().newPage();
  await pub.goto(url);
  const video = pub.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "詳細を閉じる" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${evidence}/mobile-library.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("画面内ショートカットと画像貼り付けで共有URLができる", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      value: async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        canvas.getContext("2d")!.fillRect(0, 0, 320, 180);
        return canvas.captureStream(10);
      },
    });
  });
  await page.goto("/");
  await page.keyboard.press("Control+Shift+S");
  await expect(page.locator(".region-overlay")).toBeVisible();
  await page.getByRole("button", { name: "全体を保存" }).click();
  await expect(page.locator("#detail h2")).toContainText("画面キャプチャ");
  await expect(page.getByLabel("共有URL", { exact: true })).toHaveValue(/\/s\/[a-f0-9]{32}/);
  await page.getByRole("button", { name: "詳細を閉じる" }).click();
  const image = await fixture(page, "paste test");
  await page.evaluate((bytes) => {
    const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([data], "paste.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, image.toString("base64"));
  await expect(page.locator("#detail h2")).toContainText("貼り付けたキャプチャ");
  await expect(page.getByLabel("共有URL", { exact: true })).toHaveValue(/\/s\/[a-f0-9]{32}/);
});
test("撮影直後から共有中。注釈は1操作で同じURLへ反映し、未反映の編集と停止後の再開が分かる", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const original = await fixture(page, "03 注釈の反映");
  await add(page, "注釈の反映", original);
  const detail = page.locator("#detail");
  // 撮影直後は共有中の内容そのもの。同じ内容を再公開するボタンや版の選択は出さない。
  await expect(detail.locator(".version-state")).toHaveText("共有中の内容");
  await expect(detail.getByRole("button", { name: /この版を/ })).toHaveCount(0);
  await expect(page.locator("#version-select")).toHaveCount(0);
  const url = await page.getByLabel("共有URL", { exact: true }).inputValue();
  const pub = await context.newPage();
  await pub.goto(url);
  const mediaUrl = (await pub.locator("img").getAttribute("src"))!;
  await expect(pub.locator("figcaption")).toHaveCount(0);
  // 共有ページに画素数・データ量・画像コピーを出す。ダウンロードや撮影日時は出さない。
  await expect(pub.locator("[data-dim]")).toHaveText("970 × 620");
  await expect(pub.locator(".meta")).toContainText(/\d+\.\d KB/);
  await expect(pub.getByRole("link", { name: /ダウンロード/ })).toHaveCount(0);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(url).origin,
  });
  await pub.getByRole("button", { name: "画像をコピー" }).click();
  await expect(pub.getByRole("button", { name: "コピーしました" })).toBeVisible();
  expect(
    await pub.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const blob = await item.getType("image/png");
      const bitmap = await createImageBitmap(blob);
      return [bitmap.width, bitmap.height];
    }),
  ).toEqual([970, 620]);

  await page.getByRole("button", { name: "↗ 注釈を付ける" }).click();
  const canvas = page.locator("canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.up();
  await page.getByRole("button", { name: "保存して共有URLに反映", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await expect(page.locator("#toast")).toContainText("共有URLに反映しました");
  expect(await page.getByLabel("共有URL", { exact: true }).inputValue()).toBe(url);
  const annotated = await (await pub.request.get(mediaUrl)).body();
  expect(annotated).not.toEqual(original);
  await expect(page.locator("#version-select option:checked")).toContainText("注釈");
  await expect(page.locator("#version-select option:checked")).toContainText("（共有中）");
  await expect(detail.locator(".version-state")).toHaveText("共有中の内容");

  // 反映前の作業版は、一覧と詳細の両方で「まだ共有URLに出ていない」と分かる。
  await page.getByRole("button", { name: "作業版を追加", exact: true }).click();
  await page.locator("#file-input").setInputFiles({
    name: "ai.png",
    mimeType: "image/png",
    buffer: await fixture(page, "03 AI編集", "#f3e3c9"),
  });
  await page.getByRole("button", { name: "作業版を登録", exact: true }).click();
  await expect(detail.locator(".version-state")).toHaveText("共有URLには未反映");
  await expect(
    page.locator(".capture-card", { hasText: "注釈の反映" }).locator(".pending-chip"),
  ).toHaveText("未反映の編集あり");
  expect(await (await pub.request.get(mediaUrl)).body()).toEqual(annotated);

  await detail.getByRole("button", { name: "共有を停止", exact: true }).click();
  await page.locator("#confirm").click();
  expect((await pub.request.get(url)).status()).toBe(404);
  // 再開の初期値は停止前に共有していた内容。反映前のAI編集を黙って出さない。
  await expect(page.locator("#version-select option:checked")).toContainText("（停止前の共有）");
  await detail.getByRole("button", { name: "同じURLで共有を再開", exact: true }).click();
  await page.locator("#confirm").click();
  await expect(detail.locator(".badge").first()).toHaveText("公開中");
  expect(await page.getByLabel("共有URL", { exact: true }).inputValue()).toBe(url);
  expect((await pub.request.get(url)).status()).toBe(200);
  expect(await (await pub.request.get(mediaUrl)).body()).toEqual(annotated);
  expect(errors).toEqual([]);
});
test("縦長ページ撮影CLIとファイル登録CLIが登録と同時に共有URLを返す", async ({
  page,
}) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      '<html><head><title>縦長ページの検証</title></head><body style="margin:0;background:#eef3e8;height:3400px;font:30px sans-serif"><h1>ページの先頭</h1><p style="position:absolute;top:3200px">ページの末尾</p></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  try {
    const captured = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/capture-web.ts", url, "--port", "4318"],
      { cwd: process.cwd(), timeout: 40000 },
    );
    expect(captured.stdout).toMatch(/共有URL: http:\/\/127\.0\.0\.1:4318\/s\/[a-f0-9]{32}/);
    const file = join(await mkdtemp(join(tmpdir(), "cliplink-cli-")), "cli.png");
    await writeFile(file, await fixture(page, "CLI登録"));
    const cli = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "scripts/import.ts", file, "--port", "4318", ...args],
        { cwd: process.cwd(), timeout: 40000 },
      );
    const imported = await cli("--title", "CLIから登録");
    const importedUrl = imported.stdout.match(/共有URL: (\S+)/)![1];
    expect((await page.request.get(importedUrl)).status()).toBe(200);
    // AIの出力は利用者が確認するまで共有しない（SPEC R-06）。
    expect((await cli("--title", "AIの出力", "--ai")).stdout).toContain("未共有で登録しました");
    await page.goto("/");
    await page.getByLabel("キャプチャを検索").fill("縦長ページ");
    await page.getByRole("button", { name: "縦長ページの検証の詳細" }).click();
    await expect(
      page.locator('#metadata-form input[name="sourceTitle"]'),
    ).toHaveValue("縦長ページの検証");
    await expect(
      page.locator('#metadata-form input[name="sourceUrl"]'),
    ).toHaveValue(url);
    await expect(page.locator("#detail .badge").first()).toHaveText("公開中");
    await expect(page.getByLabel("共有URL", { exact: true })).toHaveValue(/\/s\/[a-f0-9]{32}/);
    const height = await page
      .locator("#detail img")
      .evaluate((img: HTMLImageElement) => img.naturalHeight);
    expect(height).toBeGreaterThanOrEqual(3400);
    await page.screenshot({
      path: `${evidence}/fullpage-capture.png`,
      fullPage: true,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
