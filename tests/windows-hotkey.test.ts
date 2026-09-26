import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

describe.skipIf(process.platform !== "win32")("Windows範囲撮影の登録形式", () => {
  it("補助処理の送信をNodeのFormDataとして読み取れる", async () => {
    const received: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        const request = new Request("http://127.0.0.1/upload", {
          method: "POST",
          headers: req.headers as HeadersInit,
          body: Buffer.concat(chunks),
        });
        const form = await request.formData();
        const file = form.get("file");
        const valid = file instanceof File &&
          ["screenshot.png", "recording.mp4"].includes(file.name) &&
          form.get("title") !== null && form.get("captureAt") !== null &&
          form.get("publishNow") === "true";
        if (valid) received.push(file.name);
        if (valid) res.writeHead(201, { "X-Cliplink-Share-Url": "https://share.example.test/s/0123456789abcdef0123456789abcdef" }).end();
        else res.writeHead(400).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP server did not start");
      const command = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -Path $env:CLIPLINK_TEST_SOURCE -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Net.Http')",
        "$png = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')",
        "$image = [CliplinkUpload]::SendForShareAsync($env:CLIPLINK_TEST_ORIGIN, $env:CLIPLINK_TEST_TOKEN, $png).GetAwaiter().GetResult()",
        "$mp4 = [byte[]](0,0,0,24,102,116,121,112,109,112,52,50,0,0,0,0)",
        "$video = [CliplinkUpload]::SendFileForShareAsync($env:CLIPLINK_TEST_ORIGIN, $env:CLIPLINK_TEST_TOKEN, $mp4, 'recording.mp4', '範囲録画').GetAwaiter().GetResult()",
        "$validUrl = [CliplinkUpload]::IsValidShareUrl($image.ShareUrl, 'https://share.example.test/')",
        "$wrongBase = [CliplinkUpload]::IsValidShareUrl($image.ShareUrl, 'https://other.example.test')",
        "$wrongPath = [CliplinkUpload]::IsValidShareUrl('https://share.example.test/not-share/0123456789abcdef0123456789abcdef', 'https://share.example.test')",
        "@([pscustomobject]@{ status = $image.StatusCode; url = $image.ShareUrl; validUrl = $validUrl; wrongBase = $wrongBase; wrongPath = $wrongPath }, [pscustomobject]@{ status = $video.StatusCode; url = $video.ShareUrl }) | ConvertTo-Json -Compress",
      ].join("; ");
      const result = await promisify(execFile)(
        "powershell.exe",
        ["-NoProfile", "-Sta", "-Command", command],
        {
          env: {
            ...process.env,
            CLIPLINK_TEST_ORIGIN: `http://127.0.0.1:${address.port}`,
            CLIPLINK_TEST_TOKEN: "local-test-only",
            CLIPLINK_TEST_SOURCE: resolve("scripts/windows-hotkey.cs"),
          },
          timeout: 15000,
        },
      );
      expect(received).toEqual(["screenshot.png", "recording.mp4"]);
      const uploads = JSON.parse(result.stdout.trim()) as Array<{ status: number; url: string }>;
      expect(uploads).toEqual([
        {
          status: 201,
          url: "https://share.example.test/s/0123456789abcdef0123456789abcdef",
          validUrl: true,
          wrongBase: false,
          wrongPath: false,
        },
        { status: 201, url: "https://share.example.test/s/0123456789abcdef0123456789abcdef" },
      ]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
