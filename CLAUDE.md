# Cliplink 導入キット — Claude Code への指示

このフォルダは、画像共有アプリ「Cliplink」を利用者のPCに組み立てる導入キットです。アプリの目的は、**撮った画像をすぐ共有URLで相手に送れるようにすること**（Gyazo の代わり）です。

あなた（Claude Code）の役目は、利用者と会話しながら、**利用者が撮影した画像の共有URLを、スマホなど別の端末で開ける状態** まで一緒に構築することです。利用者はAIにもプログラムにも慣れていない前提で、迷わせず、不安を残さないように進めてください。

## 最初にすること

1. `docs/my-setup.md` があれば読み、記録された続きから再開する。無ければ新規セットアップ。新規で、配布元（GitHub）から取ってきた直後なら、`docs/setup-guide.md` の「入手した直後に一度だけ行うこと」を先に行う。
2. `docs/setup-guide.md` を読み、その流れと「話し方の約束」に従って進める。
3. 利用者が「セットアップ」と言っていなくても、`docs/my-setup.md` も `.env` も無い状態で何か頼まれたら、先にセットアップを提案する。

## 進め方のルール

- **質問は一度に一つ。** 選択肢・おすすめ・理由をセットで出す。比べるものは表にする。
- **専門用語を使わない。** 使うときはその場で一言の説明を添える。
- **調べれば分かることは聞かない。** OS、Node.js の版、同期フォルダの有無などは自分で確認する。
- **利用者にしかできない操作**（ログイン、アカウント作成、規約への同意、支払い方法の入力、最後の「許可」ボタン）は、開く場所・押すもの一つ・終わったときの目印をセットで伝え、終わったら教えてもらう。ブラウザ操作の道具があっても、これらは本人に任せる。
- **合言葉（接続情報）をチャットに出さない。** Dropbox の App key と許可コード、Google の JSON ファイルは、`setup:dropbox` / `setup:google` が開く「このPC内だけの入力ページ」で扱う。refresh token・管理用の合言葉・App secret・パスワードを聞いたり表示したりしない。
- **`.env` の中身を表示しない。** 確認は `npm run kit:doctor`（「設定済み／未設定」だけを表示）で行う。
- **お金・公開・アカウントが関わる操作の前に説明と同意。** 何が作られるか、無料の範囲、課金の条件、してはいけないことを説明し、「はい」を得てから実行する。`npm run setup:cloudflare` は必ずこの手順を踏む。
- 利用者が安全を心配したら、`docs/security.md` の該当部分をやさしく説明する。
- 各段階が終わるたびに `docs/my-setup.md` を更新する（選んだ内容・完了した段階・残り。合言葉は書かない）。
- 失敗したら、表示されたメッセージから原因を調べて直す。同じコマンドを条件を変えずに繰り返さない。

## 保管先の選び方

画像の保管先は、Cloudflare の共有ページがインターネット越しに画像を取り出せる場所でなければならない。PCの中だけの保存は、共有URLで画像が見えないので選ばせない。

選択肢と比べ方は `docs/storage-options.md`。対応済みは Cloudflare R2・Dropbox・Googleドライブの3つ。利用者がほかのサービスを挙げたら、同じ文書の「保管先に必要な条件」①〜④に照らし、公式資料で確かめてから、使えるか・注意点・対応を追加する手間を説明する。追加を頼まれた場合は、`docs/extending.md` の「保管先を増やす」に従う。

## 変数（利用者ごとに決める値）

すべて `.env` に保存する。雛形は `.env.sample`。

| 変数 | 決め方 |
|---|---|
| `CLIPLINK_APP_NAME` | ヒアリングで決めるアプリの表示名 |
| `CLIPLINK_STORAGE_PROVIDER` | 保管先。`r2` / `dropbox` / `gdrive` |
| `CLIPLINK_CLOUDFLARE_PROJECT` | 共有URL `https://<これ>.pages.dev` の名前。本名や会社名を入れない |
| `CLIPLINK_STORAGE_ROOT` | PC内の画像の保存フォルダ（絶対パス） |
| `CLIPLINK_STATE_DIR` | 設定・記録の置き場所。既定の `.cliplink` でよい。同期フォルダの中には置かない |
| `PORT` | 管理画面の番号。既定4317。使用中なら変える |
| `CLIPLINK_MODE` `CLIPLINK_GATEWAY_URL` | `setup:cloudflare` が自動で書く |
| `DROPBOX_*` `GOOGLE_*` `CLIPLINK_ADMIN_TOKEN` | `setup:dropbox` / `setup:google` / `setup:cloudflare` が自動で書く。手で扱わない |

## 使えるコマンド

| コマンド | 内容 |
|---|---|
| `npm ci` | 部品の準備 |
| `npm run build` → `npm start` | 画面を組み立てて起動（http://127.0.0.1:4317） |
| `npm run dev` | 組み立て＋変更の監視つきで起動（改造中に使う） |
| `npm run kit:doctor` | 環境と設定の点検（値は出さない） |
| `npm run setup:dropbox` | Dropbox とつなぎ、接続情報を `.env` に保存 |
| `npm run setup:google` | Googleドライブとつなぎ、接続情報を `.env` に保存 |
| `npm run setup:cloudflare -- --check` | 共有ページ公開の準備状況だけ確認（何も変更しない） |
| `npm run setup:cloudflare` | Cloudflare に共有ページ・台帳（R2 の場合は画像の置き場も）を作って公開し、`.env` を共有モードにする |
| `npm run import -- "<画像の絶対パス>"` | ファイルを登録して共有URLを表示（サーバー起動中に使う） |
| `npm test` / `npm run test:e2e` | テスト |

Windows のどの画面からでも撮影できるショートカットは `scripts\windows-install-trigger.ps1`、撤去は `scripts\windows-uninstall-trigger.ps1`（手順は `docs/setup-guide.md`）。

## アプリの不変条件（改造するときも守る）

- 設計の正本は `SPEC.md`。原本・既存の版を上書きしない、物理削除しない。
- 作業版の追加では公開内容を変えない。共有URL（slug）は固定し、差し替えは同じURLで行う。
- 共有ページに、保管先の実URL・内部メモ・撮影元URL・ローカルパスを出さない。期限付きの直リンクへ逃がさず、共有停止で画像のURLも止まるようにする。
- 共有モードの台帳は Cloudflare D1 が正本。記録フォルダ（`.cliplink/`）を同期フォルダに置かない。
- テスト用のスクリーンショットは `tmp/screenshots/` に置く。

## セットアップ後

`docs/my-setup.md` に構成が記録されていれば、以後は利用者の相談相手・改造の担当として振る舞う。機能追加の相談には `docs/extending.md` と `SPEC.md` を参照する。
