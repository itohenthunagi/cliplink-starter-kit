# 改造メモ

このアプリは自由に改造してかまいません。Claude Code に頼むときは、このファイルと `SPEC.md` を読ませてから始めると、既存の仕組みを壊しにくくなります。改造後は `npm test` と `npm run build` が通ることを確認してください。

## 構成の早見表

| 場所 | 役割 |
|---|---|
| `src/client/` | 管理画面（ブラウザ側）。`main.ts` が画面、`annotation.ts` が注釈、`region.ts` が範囲選択、`style.css` が見た目 |
| `src/server/` | 管理画面のサーバー（このPCの127.0.0.1だけで動く）。`app.ts` がAPI、`storage.ts` がファイル保存 |
| `src/core/` | 共通部分。`library.ts` が台帳の規則、`public.ts` が共有ページ、`dropbox.ts` がDropbox API |
| `src/worker/` | 共有モードでCloudflare上に置くプログラム（共有ページと台帳API） |
| `migrations/` | Cloudflare D1 の台帳テーブル |
| `scripts/` | セットアップ・登録・撮影などのコマンド。`windows-*.ps1` / `*.cs` はWindows常駐ショートカット |
| `tests/` | 単体テスト（`tests/e2e/` は画面操作テスト） |

## よくある改造

### 名前を変える
- 表示名は `.env` の `CLIPLINK_APP_NAME` だけで変わります（管理画面・共有ページ）。共有モードでは `npm run setup:cloudflare` を再実行すると共有ページ側にも反映されます。
- Windows常駐ショートカットの表示（通知領域・スタートメニュー・スタートアップの名前）と内部フォルダ `%LOCALAPPDATA%\Cliplink` は `scripts/windows-install-trigger.ps1` と `scripts/windows-trigger.cs` に書かれています。変える場合はアンインストール → 変更 → 再インストールの順で行い、`scripts/windows-uninstall-trigger.ps1` も同じ名前に合わせます。
- 管理画面の色やロゴは `src/client/style.css` と `src/client/main.ts` のサイドバー部分です。

### Macでどの画面からでも撮影する
`docs/setup-guide.md` の「Mac（どの画面からでも撮る場合）」に仕組みの案があります。作ったスクリプトは `scripts/mac-*.sh` などとして保存し、`docs/my-setup.md` に記録しておくと、次に Claude Code が読んで保守できます。

### 保管先を増やす（上級）
対応済みの保管先は Cloudflare R2・Dropbox・Googleドライブです。ほかのサービスに対応させる前に、`docs/storage-options.md` の「保管先に必要な条件」①〜④を満たすかを公式資料で確かめ、費用と設定の手間を利用者に説明してから始めます。

触る場所（「保管器」を1つ足す形になっています）：

1. `src/core/storage-provider.ts`：保管先の一覧と表（表示名、必要な設定キー、Cloudflare に送る合言葉）に1行足す
2. `src/core/model.ts`：版の外部保管メタデータ（`Version.dropbox`）の id に、そのサービスのファイルIDの形を足す
3. 保管器のクラス（例：`src/core/gdrive.ts` を参考に）：`upload`（保存して内容の一致を確かめる）と `download`（範囲指定つきで取り出す）、必要なら `verify`
4. `src/server/remote-store.ts` と `src/worker/storage.ts`：保管器を作る分岐に1ケース
5. 接続の設定が要る場合：`scripts/setup-google.ts` などを参考に、このPC内だけで動く入力ページのスクリプトを作る
6. テスト：`tests/r2-gateway.test.ts`・`tests/worker.test.ts` と同じ形で

どの保管先でも、`SPEC.md` の「原本を上書きしない」「共有停止で画像URLも止まる（保管先の直リンクに逃がさない）」を守ります。

### 機能を足すときの約束
- 原本と既存の版は上書き・物理削除しない。
- 共有URL（slug）は固定。内容の差し替えは同じURLで行う。
- 共有ページに、ローカルパス・Dropboxの実URL・内部メモ・撮影元URLを出さない。
- 秘密の値は `.env` だけに置き、画面・ログ・チャットに出さない。

## 人に配るとき
改造したアプリを他の人に渡す場合は、`.env`・`.cliplink/`・`node_modules/`・`dist/`・`docs/my-setup.md` を含めないでください。これらにはあなたの接続情報や環境の記録が入っています。
