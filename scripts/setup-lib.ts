// setup-cloudflare.ts / build-kit.ts が使う、wrangler設定と出力を扱う純関数。
export const D1_PLACEHOLDER = "REPLACE_WITH_D1_DATABASE_ID";

export function validProjectName(name: string) {
  return /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/.test(name) && !name.includes("--");
}

// `wrangler d1 create` の出力（JSON片・TOML片のどちらでも）から database_id を取り出す。
export function parseD1Id(output: string) {
  return output.match(/database_id["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/i)?.[1];
}

export function readD1Id(jsonc: string) {
  return jsonc.match(/"database_id"\s*:\s*"([^"]*)"/)?.[1];
}

export function setD1(jsonc: string, id: string, name: string) {
  return jsonc
    .replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`)
    .replace(/("database_name"\s*:\s*")[^"]*(")/, `$1${name}$2`);
}

export function readD1Name(jsonc: string) {
  return jsonc.match(/"database_name"\s*:\s*"([^"]*)"/)?.[1];
}

// pages/wrangler.jsonc の vars.APP_NAME（無ければ追加しない。呼び出し側で存在を確かめる）。
export function setAppNameVar(jsonc: string, appName: string) {
  return jsonc.replace(/("APP_NAME"\s*:\s*)"(?:[^"\\]|\\.)*"/, `$1${JSON.stringify(appName)}`);
}

export function setTopLevelName(jsonc: string, name: string) {
  // 最初の "name" が最上位の名前（"database_name" は引用符の位置が違うので一致しない）。
  return jsonc.replace(/("name"\s*:\s*")[^"]*(")/, `$1${name}$2`);
}

export function parsePagesHost(output: string, project?: string) {
  // 作成時の出力はURLそのもの。プロジェクト一覧は表形式なので、名前の一致する行から読む。
  const direct = output.match(/https:\/\/([a-z0-9-]+\.pages\.dev)/)?.[1];
  if (direct || !project) return direct;
  const row = output
    .split("\n")
    .find((l) => l.split(/[│|]/).map((c) => c.trim()).includes(project));
  return row?.match(/([a-z0-9-]+\.pages\.dev)/)?.[1] ?? direct;
}

// アプリ名から、Cloudflareのプロジェクト名候補を作る（英数字以外は落とす）。
export function slugify(text: string, fallback = "cliplink") {
  const s = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || fallback;
}

// ---- 画像の保管先（一覧と保管先ごとの設定の表は src/core/storage-provider.ts） ----
export {
  STORAGE_PROVIDER_INFO,
  STORAGE_PROVIDERS,
  parseStorageProvider,
  storageLabel,
  type StorageProvider,
} from "../src/core/storage-provider";

// R2のバケット名（英小文字・数字・ハイフン、3〜63文字）。プロジェクト名が長い時は前を詰める。
export function r2BucketName(project: string) {
  return `${project.slice(0, 56).replace(/-+$/, "")}-images`;
}

// wrangler の出力から、R2が未申込み（ダッシュボードで利用開始していない）ことを読み取る。
export function r2NotEnabled(output: string) {
  return /enable R2|10042|R2 (?:is )?not enabled|purchase R2/i.test(output);
}

export function r2BucketExists(output: string) {
  return /already exists|already own|\b10004\b/i.test(output);
}

// jsonc のコメント（// … と /* … */）を同じ長さの空白に置き換える（文字列内の // は残す）。
// 位置が変わらないので、ここで見つけた位置を元の文字列にそのまま使える。
export function maskComments(text: string) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      out += c;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      for (; i < text.length && text[i] !== "\n"; i++) out += " ";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      for (const stop = end < 0 ? text.length : end + 2; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// コメントを除いた位置で最初に一致した箇所（元の文字列での位置と中身）。
const locate = (jsonc: string, re: RegExp) => {
  const m = re.exec(maskComments(jsonc));
  return m ? { index: m.index, end: m.index + m[0].length, text: jsonc.slice(m.index, m.index + m[0].length), groups: m } : null;
};
const splice = (jsonc: string, at: { index: number; end: number }, text: string) =>
  jsonc.slice(0, at.index) + text + jsonc.slice(at.end);
// 新しい項目を d1_databases の前（同じ字下げ）に、無ければ最上位の { の直後に差し込む。
const insertTopLevel = (jsonc: string, entry: string) => {
  const d1 = locate(jsonc, /^([ \t]*)"d1_databases"\s*:/m);
  if (d1) return `${jsonc.slice(0, d1.index)}${d1.groups[1]}${entry},\n${jsonc.slice(d1.index)}`;
  const open = locate(jsonc, /\{/);
  return open ? splice(jsonc, open, `{\n  ${entry},`) : jsonc;
};

const R2_BLOCK = /"r2_buckets"\s*:\s*\[[^\]]*\]/;

export function readR2BucketName(jsonc: string) {
  return locate(jsonc, R2_BLOCK)?.text.match(/"bucket_name"\s*:\s*"([^"]*)"/)?.[1];
}

// r2_buckets を binding BUCKET の1件にそろえる（無ければ d1_databases の前、それも無ければ先頭に足す）。
export function setR2Bucket(jsonc: string, bucketName: string) {
  const block = `"r2_buckets": [{ "binding": "BUCKET", "bucket_name": ${JSON.stringify(bucketName)} }]`;
  const found = locate(jsonc, R2_BLOCK);
  return found ? splice(jsonc, found, block) : insertTopLevel(jsonc, block);
}

// r2_buckets を取り除く（配布キット用。本人のバケット名を持ち出さない）。
export function removeR2Buckets(jsonc: string) {
  const found = locate(jsonc, /\n?[ \t]*"r2_buckets"\s*:\s*\[[^\]]*\]\s*,?/);
  return found ? splice(jsonc, found, "") : jsonc;
}

// vars の値（JSON文字列）に一致する正規表現。name は英大文字・数字・_ だけを想定する。
const varPattern = (name: string) => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`変数名が不正です: ${name}`);
  return new RegExp(String.raw`("${name}"\s*:\s*)("(?:[^"\\]|\\.)*")`);
};
const VARS_BLOCK = /"vars"\s*:\s*\{[^}]*\}/;

// vars の1項目を設定する（有れば値を置き換え、無ければ vars の先頭に足す。vars自体が無ければ作る）。
export function setVar(jsonc: string, name: string, value: string) {
  const v = JSON.stringify(value);
  const key = JSON.stringify(name);
  const existing = varPattern(name);
  const vars = locate(jsonc, VARS_BLOCK);
  if (!vars) return insertTopLevel(jsonc, `"vars": { ${key}: ${v} }`);
  const body = existing.test(vars.text)
    ? vars.text.replace(existing, (_m, p: string) => `${p}${v}`)
    : /\{\s*\}$/.test(vars.text)
      ? vars.text.replace(/\{\s*\}$/, () => `{ ${key}: ${v} }`)
      : vars.text.replace(/\{\s*/, (m) => `${m}${key}: ${v}, `);
  return splice(jsonc, vars, body);
}

export function readVar(jsonc: string, name: string) {
  const m = varPattern(name).exec(locate(jsonc, VARS_BLOCK)?.text ?? "");
  return m ? (JSON.parse(m[2]) as string) : undefined;
}
