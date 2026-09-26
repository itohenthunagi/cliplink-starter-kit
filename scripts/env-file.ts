// .env の読み書き。値は画面・ログに出さない前提で、キー単位で置換・追記する（他の行とコメントは保つ）。
import { readFile, writeFile } from "node:fs/promises";

const line = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function parseEnv(text: string) {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    values[m[1]] = v;
  }
  return values;
}

export function mergeEnv(text: string, updates: Record<string, string>) {
  const rest = new Map(Object.entries(updates));
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const out = lines.map((raw) => {
    const key = raw.match(line)?.[1];
    if (!key || !rest.has(key)) return raw;
    const value = rest.get(key)!;
    rest.delete(key);
    return `${key}=${value}`;
  });
  while (out.length && out.at(-1) === "") out.pop();
  for (const [key, value] of rest) out.push(`${key}=${value}`);
  return out.join(newline) + newline;
}

export async function readEnvFile(path = ".env") {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function updateEnvFile(path: string, updates: Record<string, string>) {
  for (const [key, value] of Object.entries(updates))
    if (/[\r\n]/.test(value)) throw new Error(`${key} に改行を含む値は保存できません。`);
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await writeFile(path, mergeEnv(current, updates));
}
