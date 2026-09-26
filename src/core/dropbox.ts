import { DomainError } from "./library";
import type { Version } from "./model";
export interface DropboxCredentials {
  appKey: string;
  appSecret?: string;
  refreshToken: string;
}
const apiArg = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
export class Dropbox {
  readonly provider = "dropbox" as const;
  private accessToken = "";
  private expiresAt = 0;
  constructor(
    private credentials: DropboxCredentials,
    // fetchをそのまま保持して this.fetcher() で呼ぶと、Workersでは Illegal invocation になる。
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private async token() {
    if (this.accessToken && Date.now() < this.expiresAt)
      return this.accessToken;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.credentials.refreshToken,
      client_id: this.credentials.appKey,
    });
    if (this.credentials.appSecret)
      body.set("client_secret", this.credentials.appSecret);
    const r = await this.fetcher("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok)
      throw new DomainError(
        "Dropboxの認証を更新できません。接続設定を確認してください。",
        503,
      );
    const token = (await r.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = token.access_token;
    this.expiresAt = Date.now() + (token.expires_in - 120) * 1000;
    return this.accessToken;
  }
  async upload(
    path: string,
    bytes: Uint8Array,
    expectedHash: string,
  ): Promise<NonNullable<Version["dropbox"]>> {
    const r = await this.fetcher(
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": apiArg({
            path,
            mode: "add",
            autorename: false,
            strict_conflict: true,
            mute: true,
          }),
        },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(180000),
      },
    );
    // The desktop sync client may upload this immutable file before this API call.
    // Accept that race only if Dropbox confirms identical content; never overwrite it.
    if (r.status === 409) {
      const existing = await this.fetcher(
        "https://api.dropboxapi.com/2/files/get_metadata",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (existing.ok) {
        const m = (await existing.json()) as {
          id: string;
          rev: string;
          content_hash: string;
        };
        if (m.content_hash === expectedHash)
          return { id: m.id, rev: m.rev, contentHash: m.content_hash };
      }
    }
    if (!r.ok)
      throw new DomainError(
        "Dropboxへの保存が完了しませんでした。通信・容量・同名ファイルを確認して再試行してください。",
        503,
      );
    const metadata = (await r.json()) as {
      id: string;
      rev: string;
      content_hash: string;
    };
    return {
      id: metadata.id,
      rev: metadata.rev,
      contentHash: metadata.content_hash,
    };
  }
  async download(version: Version, range?: string) {
    if (!version.dropbox)
      throw new DomainError("Dropboxへの保存が完了していません。", 503);
    // 版はrevで固定する。Dropboxは別フィールドのrevを廃止済みで400を返すため、pathに "rev:" 形式で渡す。
    // revは移動・リネーム後も同じ内容を指す。
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.token()}`,
      "Dropbox-API-Arg": apiArg({ path: `rev:${version.dropbox.rev}` }),
    };
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range))
        throw new DomainError("範囲指定が不正です。", 416);
      headers.Range = range;
    }
    const r = await this.fetcher(
      "https://content.dropboxapi.com/2/files/download",
      { method: "POST", headers, signal: AbortSignal.timeout(180000) },
    );
    if (r.status === 416)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${version.size}` },
      });
    if (!r.ok)
      throw new DomainError(
        "Dropboxから取得できません。削除・同期・通信の状態を確認してください。",
        503,
      );
    return r;
  }
}
