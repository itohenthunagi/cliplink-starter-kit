import { describe, expect, it } from "vitest";
import { mergeEnv, parseEnv } from "../scripts/env-file";
import {
  D1_PLACEHOLDER,
  parseD1Id,
  parsePagesHost,
  parseStorageProvider,
  r2BucketExists,
  r2BucketName,
  r2NotEnabled,
  readD1Id,
  readR2BucketName,
  readVar,
  removeR2Buckets,
  setAppNameVar,
  setD1,
  setR2Bucket,
  setVar,
  slugify,
  STORAGE_PROVIDER_INFO,
  STORAGE_PROVIDERS,
  validProjectName,
} from "../scripts/setup-lib";

describe(".env の読み書き", () => {
  it("キー単位で置き換え、他の行とコメントを保ち、無いキーは末尾に足す", () => {
    const before = "# 設定\nPORT=4317\nDROPBOX_APP_KEY=\n\n# 下の行\nCLIPLINK_MODE=\n";
    const after = mergeEnv(before, { DROPBOX_APP_KEY: "abc", CLIPLINK_ADMIN_TOKEN: "t" });
    expect(after).toBe("# 設定\nPORT=4317\nDROPBOX_APP_KEY=abc\n\n# 下の行\nCLIPLINK_MODE=\nCLIPLINK_ADMIN_TOKEN=t\n");
    expect(mergeEnv("", { A: "1" })).toBe("A=1\n");
    expect(mergeEnv("A=1\r\nB=2\r\n", { B: "3" })).toBe("A=1\r\nB=3\r\n");
  });
  it("値を読み取り、引用符を外す", () => {
    expect(parseEnv('# x\nA=1\nB="two words"\n C = 3\nbad line')).toEqual({ A: "1", B: "two words", C: "3" });
  });
});

describe("Cloudflare設定の補助", () => {
  const jsonc = `{
  "name": "cliplink",
  "d1_databases": [
    { "binding": "DB", "database_name": "cliplink", "database_id": "${D1_PLACEHOLDER}" },
  ],
  "vars": { "APP_NAME": "Cliplink" },
}`;
  it("D1のIDと名前を差し替え、読み戻せる", () => {
    const id = "01234567-89ab-cdef-0123-456789abcdef";
    const next = setD1(jsonc, id, "my-clips");
    expect(readD1Id(next)).toBe(id);
    expect(next).toContain('"database_name": "my-clips"');
    expect(next).toContain('"name": "cliplink"');
  });
  it("表示名はJSON文字列として安全に入る", () => {
    expect(setAppNameVar(jsonc, 'くりっぷ "帳"')).toContain('"APP_NAME": "くりっぷ \\"帳\\""');
  });
  it("wranglerの出力からD1のIDとpages.devのホストを読む", () => {
    expect(parseD1Id('{\n  "database_name": "x",\n  "database_id": "01234567-89ab-cdef-0123-456789abcdef"\n}')).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(parseD1Id('database_id = "01234567-89ab-cdef-0123-456789abcdef"')).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(parsePagesHost("Successfully created. https://my-clips-4xz.pages.dev/")).toBe("my-clips-4xz.pages.dev");
    const table = "│ Project Name │ Project Domains │\n│ my-clips │ my-clips-9q.pages.dev │";
    expect(parsePagesHost(table, "my-clips")).toBe("my-clips-9q.pages.dev");
  });
  it("プロジェクト名の形式を確かめ、アプリ名から候補を作る", () => {
    expect(validProjectName("my-clips")).toBe(true);
    for (const bad of ["", "a", "My-Clips", "-x", "x-", "a--b", "a_b"]) expect(validProjectName(bad)).toBe(false);
    expect(slugify("Clip Book 2")).toBe("clip-book-2");
    expect(slugify("くりっぷ")).toBe("cliplink");
  });
});

describe("画像の保管先（Dropbox / R2）の設定", () => {
  const pages = `{
  "name": "cliplink",
  "compatibility_date": "2026-09-01",
  // 例: "vars": {}
  "vars": { "APP_NAME": "Cliplink", "STORAGE_PROVIDER": "dropbox" },
  "d1_databases": [
    { "binding": "DB", "database_name": "cliplink", "database_id": "${D1_PLACEHOLDER}" },
  ],
}`;
  it("CLIPLINK_STORAGE_PROVIDERを解釈する（未設定はdropbox、知らない値は不正）", () => {
    expect(parseStorageProvider(undefined)).toBe("dropbox");
    expect(parseStorageProvider(" ")).toBe("dropbox");
    expect(parseStorageProvider("R2")).toBe("r2");
    expect(parseStorageProvider("dropbox")).toBe("dropbox");
    expect(parseStorageProvider("s3")).toBeNull();
    for (const p of STORAGE_PROVIDERS) expect(STORAGE_PROVIDER_INFO[p].label).toBeTruthy();
    expect(STORAGE_PROVIDER_INFO.r2.localEnv).toEqual([]);
    expect(STORAGE_PROVIDER_INFO.r2.pagesSecrets).toEqual([]);
  });
  it("R2バケットを足し・置き換え・取り除け、他の設定を保つ", () => {
    const added = setR2Bucket(pages, "my-clips-images");
    expect(readR2BucketName(added)).toBe("my-clips-images");
    expect(added).toMatch(/"r2_buckets": \[\{ "binding": "BUCKET", "bucket_name": "my-clips-images" \}\],\n  "d1_databases"/);
    const replaced = setR2Bucket(added, "other-images");
    expect(readR2BucketName(replaced)).toBe("other-images");
    expect(replaced.match(/r2_buckets/g)).toHaveLength(1);
    expect(removeR2Buckets(replaced)).toBe(pages);
    expect(readR2BucketName(pages)).toBeUndefined();
    expect(readR2BucketName(setR2Bucket('{ "name": "x" }', "b-images"))).toBe("b-images");
  });
  it("varsの値を置き換え・追加し、他の値を保つ", () => {
    const r2 = setVar(pages, "STORAGE_PROVIDER", "r2");
    expect(readVar(r2, "STORAGE_PROVIDER")).toBe("r2");
    expect(readVar(r2, "APP_NAME")).toBe("Cliplink");
    expect(setVar(r2, "STORAGE_PROVIDER", "dropbox")).toBe(pages);
    expect(readVar(setVar('{ "vars": {} }', "A", "1"), "A")).toBe("1");
    expect(setVar('{ "vars": { "B": "2" } }', "A", 'x"y')).toBe('{ "vars": { "A": "x\\"y", "B": "2" } }');
    const noVars = setVar('{\n  "name": "x",\n  "d1_databases": [],\n}', "STORAGE_PROVIDER", "r2");
    expect(readVar(noVars, "STORAGE_PROVIDER")).toBe("r2");
    expect(() => setVar(pages, "bad name", "x")).toThrow();
    // コメント内の設定は読まず、文字列内の // はコメント扱いしない。
    const commented = '{\n  // "r2_buckets": [{ "bucket_name": "old" }],\n  /* "vars": {} */\n  "vars": { "URL": "https://a.example//x" },\n}';
    expect(readR2BucketName(commented)).toBeUndefined();
    expect(readVar(commented, "URL")).toBe("https://a.example//x");
    expect(readVar(setVar(commented, "STORAGE_PROVIDER", "r2"), "STORAGE_PROVIDER")).toBe("r2");
    expect(setVar(commented, "STORAGE_PROVIDER", "r2")).toContain('/* "vars": {} */');
  });
  it("R2バケット名とwranglerのエラーを読む", () => {
    expect(r2BucketName("my-clips")).toBe("my-clips-images");
    const long = r2BucketName("a".repeat(55) + "-bc");
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(long).not.toContain("--");
    expect(r2NotEnabled("✘ [ERROR] Please enable R2 through the Cloudflare Dashboard. [code: 10042]")).toBe(true);
    expect(r2NotEnabled("Created bucket my-clips-images")).toBe(false);
    expect(r2BucketExists("The bucket you tried to create already exists, and you own it. [code: 10004]")).toBe(true);
    expect(r2BucketExists("Authentication error [code: 10000]")).toBe(false);
  });
});
