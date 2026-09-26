import "./style.css";
import type { Asset, Collection, Entity, Version } from "../core/model";
import { annotate } from "./annotation";
import { selectRegion } from "./region";
// 表示名の長さに合わせてロゴの文字を小さくする（全角は半角の約2文字分）。CSPで style 属性は使えないためクラスで切り替える。
const brandClass = (name: string) => {
  const width = [...name].reduce((n, ch) => n + (/[ -~]/.test(ch) ? 1 : 1.8), 0);
  const size = width <= 9 ? "" : width <= 13 ? "brand-m" : "brand-s";
  return `${size} ${/^[ -~]*$/.test(name) ? "" : "brand-wide"}`.trim();
};
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const date = (s: string) =>
  new Date(s).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const labels = {
  draft: "未共有",
  published: "公開中",
  revoked: "共有停止",
  archived: "保管済み",
};
const kindLabels = { original: "原本", working: "作業版", published: "公開版" };
// 公開版は選んだ版のバイト列を複製した不変ファイルなので、履歴には複製元（原本・作業版）だけを並べる。
const sources = (a: Asset) => a.versions.filter((v) => v.kind !== "published");
const sharedVersion = (a: Asset) =>
  a.versions.find((v) => v.id === a.currentPublishedVersionId);
// 共有URLで相手に見えている内容。一覧のサムネイルもこれに合わせる。
const visibleVersion = (a: Asset) =>
  (a.status === "published" && sharedVersion(a)) || a.versions.at(-1)!;
// 公開中の内容より後に作られ、内容も異なる版（注釈やAI編集の反映待ち）。
function pendingVersion(a: Asset) {
  const shared = sharedVersion(a);
  const latest = sources(a).at(-1);
  if (a.status !== "published" || !shared || !latest) return undefined;
  return a.versions.indexOf(latest) > a.versions.indexOf(shared) &&
    latest.sha256 !== shared.sha256
    ? latest
    : undefined;
}
const versionLabel = (v: Version) =>
  v.kind === "original"
    ? "原本"
    : v.annotationMeta
      ? "注釈"
      : v.createdBy === "ai"
        ? "作業版（AI）"
        : kindLabels[v.kind];
let session: {
  token: string;
  mode: string;
  storage?: string;
  storageLabel?: string | null;
  shareBase: string;
  appName?: string;
  root: string;
  maxBytes: number;
  shortcut: string;
  shortcutKeys: { image: string; video: string; open: string } | null;
};
const appName = () => session?.appName?.trim() || "Cliplink";
const cloudLabel = () => `${session?.storageLabel || "Dropbox"} + Cloudflare`;
let entities: Entity[] = [];
let filter = "all";
let search = "";
let selected = new Set<string>();
let detailId = "";
let versionId = "";
let busy = false;
const media = (a: Asset, id?: string) =>
  `/api/assets/${a.id}/versions/${id || visibleVersion(a).id}`;
const shareUrl = (e: Entity) => `${session.shareBase}/s/${e.slug}`;
// 撮影直後はURLをそのまま貼れるようにコピーを試みる。ブラウザがクリップボードを拒否しても登録は成功扱い。
async function announceShare(a: Asset) {
  const where = session.mode === "local" ? "（このPC内用）" : "";
  if (a.status !== "published") {
    notify("登録しました。");
    return;
  }
  try {
    await navigator.clipboard.writeText(shareUrl(a));
    notify(`共有URLをコピーしました${where}。`);
  } catch {
    notify(`共有URLを作成しました${where}。「コピー」ボタンでコピーできます。`);
  }
}
function shortcutHint() {
  if (session.shortcut === "failed")
    return '<p class="shortcut-hint error">直前の範囲撮影を取り込めませんでした。再度撮影するか、画像をコピーしてこの画面に貼り付けてください。</p>';
  if (session.shortcut === "trigger") {
    // 常駐プログラムで設定したキーを表示する。変更は通知領域のCliplinkアイコンから行う。
    const keys = session.shortcutKeys ?? { image: "Ctrl+Alt+S", video: "Ctrl+Alt+R", open: "" };
    const kbd = (spec: string) =>
      spec
        .split("+")
        .map((k) => `<kbd>${esc(k)}</kbd>`)
        .join(" + ");
    const parts = [
      keys.image && `${kbd(keys.image)} で撮影`,
      keys.video && `${kbd(keys.video)} で録画`,
      keys.open && `${kbd(keys.open)} で管理画面`,
    ].filter(Boolean);
    return `<p class="shortcut-hint">${parts.join("、")}（どの画面からでも）。キーの変更は通知領域のCliplinkアイコンから。</p>`;
  }
  if (["ready", "image-only"].includes(session.shortcut))
    return `<p class="shortcut-hint"><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>S</kbd> で撮影${session.shortcut === "image-only" ? "" : "、<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>R</kbd> で録画"}（どの画面からでも）。撮影後は共有ページが開き、URLがコピーされます。</p>`;
  return '<p class="shortcut-hint">この画面では <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd> で範囲撮影、画像の貼り付けでも共有URLを作れます。</p>';
}
function notify(message: string, error = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = error ? "show error" : "show";
  setTimeout(() => (t.className = ""), 6000);
}
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      "x-cliplink-token": session?.token || "",
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(body
      ? { body: body instanceof FormData ? body : JSON.stringify(body) }
      : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "処理できませんでした。");
  return data;
}
async function refresh() {
  entities = await api("/entities");
  selected = new Set(
    [...selected].filter((id) => entities.some((e) => e.id === id)),
  );
  render();
}
async function action(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  document.body.classList.add("busy");
  try {
    await fn();
  } catch (e) {
    notify((e as Error).message, true);
  } finally {
    busy = false;
    document.body.classList.remove("busy");
  }
}
async function copy(value: string, message = "コピーしました。") {
  try {
    await navigator.clipboard.writeText(value);
    notify(message);
  } catch {
    modal(
      "コピーする内容",
      `<textarea id="copy-value" rows="10" readonly>${esc(value)}</textarea><p>上の内容を選択してコピーしてください。</p>`,
    );
    $("#copy-value").focus();
    $<HTMLTextAreaElement>("#copy-value").select();
  }
}
function modal(title: string, body: string, wide = false) {
  const d = $<HTMLDialogElement>("#modal");
  d.className = wide ? "wide" : "";
  d.innerHTML = `<header class="dialog-header"><h2>${esc(title)}</h2><button data-action="close" aria-label="閉じる">×</button></header>${body}`;
  if (!d.open) d.showModal();
}
const close = () => {
  const d = $<HTMLDialogElement>("#modal");
  d.close();
  d.innerHTML = "";
};
function render() {
  const searchFocused = document.activeElement?.id === "search";
  const assets = entities.filter((e): e is Asset => e.kind === "asset");
  const collections = entities.filter((e) => e.kind === "collection");
  $("#app").innerHTML =
    `<aside class="sidebar"><a class="brand ${brandClass(appName())}" href="/"><span class="brand-mark">↗</span><span class="brand-name">${esc(appName())}</span><span class="brand-dot">.</span></a><p class="sidebar-caption">撮る、整える、つなぐ。</p><nav aria-label="ライブラリ"><p class="nav-label">LIBRARY</p>${[
      [
        "all",
        "すべてのキャプチャ",
        assets.filter((a) => a.status !== "archived").length,
      ],
      [
        "published",
        "公開中",
        assets.filter((a) => a.status === "published").length,
      ],
      ["collection", "コレクション", collections.length],
      [
        "archived",
        "保管済み",
        assets.filter((a) => a.status === "archived").length,
      ],
    ]
      .map(
        ([id, label, count]) =>
          `<button data-action="filter" data-id="${id}" class="nav-item ${filter === id ? "active" : ""}"><span>${label}</span><span class="count">${count}</span></button>`,
      )
      .join(
        "",
      )}</nav><div class="sidebar-bottom"><div class="mode-dot"></div><strong>${session.mode === "cloud" ? cloudLabel() : "ローカル確認モード"}</strong><p>${session.mode === "cloud" ? "原本を保管し、固定URLで共有。" : "このPCだけで表示できます。"}</p><button data-action="settings" class="settings">⚙ 保存先・接続状態</button></div></aside><main class="workspace"><header class="topbar"><div><span class="eyebrow">YOUR VISUAL LIBRARY</span><h1>${filter === "collection" ? "コレクション" : filter === "published" ? "公開中のキャプチャ" : filter === "archived" ? "保管済み" : "キャプチャライブラリ"}</h1></div><div class="capture-actions"><button data-action="record" id="record-button">◉ 画面録画</button><button data-action="capture">▣ 範囲を撮影</button><button data-action="import" class="primary">＋ ファイルを追加</button></div></header><div class="intro"><p>${filter === "collection" ? "伝えたい順番で、画像をひとつのURLに。" : "ひとつの画像に、ずっと使えるリンクを。"}</p><span>${assets.length} captures</span></div>${shortcutHint()}${session.mode === "local" ? '<div class="local-notice"><span>LOCAL PREVIEW</span> 共有URLはこのPC内での確認用です。外部への共有には接続設定が必要です。</div>' : ""}<section class="library-tools"><label class="search"><span>⌕</span><input id="search" type="search" value="${esc(search)}" placeholder="タイトル、タグ、メモ、日付で検索" aria-label="キャプチャを検索"></label><div id="selection-info"></div><button data-action="refresh" class="subtle">↻ 更新</button></section><section id="gallery" class="gallery" aria-label="キャプチャ一覧"></section><footer class="library-footer"><span>撮った瞬間に共有URL。編集後も同じリンクを使えます。</span><span>${esc(appName().toUpperCase())} / 01</span></footer></main><aside id="detail" class="detail-panel ${detailId ? "visible" : ""}" aria-label="キャプチャ詳細"></aside>`;
  const searchBox = $<HTMLInputElement>("#search");
  searchBox.oninput = () => {
    search = searchBox.value;
    renderGallery();
  };
  if (searchFocused) {
    searchBox.focus();
    searchBox.setSelectionRange(search.length, search.length);
  }
  renderGallery();
  renderDetail();
  if (recorder?.state === "recording") {
    $("#record-button").textContent = "■ 録画を停止";
    $("#record-button").classList.add("recording");
  }
}
function renderGallery() {
  const q = search.trim().toLocaleLowerCase();
  const items = entities
    .filter((e) =>
      filter === "collection"
        ? e.kind === "collection"
        : e.kind === "asset" &&
          (filter === "all" ? e.status !== "archived" : e.status === filter),
    )
    .filter((e) =>
      `${e.title} ${date(e.createdAt)} ${e.createdAt} ${e.kind === "asset" ? `${e.sourceTitle} ${e.notes} ${e.tags.join(" ")} ${e.captureAt}` : e.description}`
        .toLocaleLowerCase()
        .includes(q),
    );
  $("#selection-info").innerHTML = selected.size
    ? `<button data-action="collection" class="selection-button">${selected.size}件をまとめて共有 →</button><button data-action="clear-selection" class="subtle">解除</button>`
    : '<span class="muted">新しい順</span>';
  $("#gallery").innerHTML = items.length
    ? items
        .map((e) =>
          e.kind === "asset"
            ? `<article class="capture-card ${detailId === e.id ? "selected" : ""}" data-card="${e.id}"><div class="thumbnail"><button class="preview-button" data-action="detail" data-id="${e.id}" aria-label="${esc(e.title)}の詳細">${e.type === "image" ? `<img src="${media(e)}" alt="${esc(e.title)}" loading="lazy">` : `<video src="${media(e)}" preload="metadata" muted></video><span class="video-label">▶ VIDEO</span>`}</button><label class="select-check"><input type="checkbox" data-select="${e.id}" aria-label="${esc(e.title)}を選択" ${selected.has(e.id) ? "checked" : ""}></label>${e.protected ? '<span class="protected-mark" title="削除保護中">保護</span>' : ""}</div><div class="card-info"><div class="card-meta"><span class="badge ${e.status}">${labels[e.status]}</span><time>${date(e.captureAt)}</time></div><button class="title-button" data-action="detail" data-id="${e.id}">${esc(e.title)}</button><div class="card-bottom">${pendingVersion(e) ? '<span class="pending-chip">未反映の編集あり</span>' : `<span>${esc(e.tags.slice(0, 2).join(" / "))}</span>`}<button class="link-button" data-action="${e.status === "published" ? "copy-share" : "detail"}" data-id="${e.id}">${e.status === "published" ? "リンクをコピー ↗" : "開く →"}</button></div></div></article>`
            : `<article class="collection-card"><span class="eyebrow">COLLECTION / ${e.orderedAssetIds.length} IMAGES</span><h2>${esc(e.title)}</h2><p>${esc(e.description || "画像をひとつにまとめて共有")}</p><span class="badge ${e.active ? "published" : "revoked"}">${e.active ? "公開中" : "共有停止"}</span><div class="button-row"><button data-action="edit-collection" data-id="${e.id}">内容・順序を編集</button>${e.active ? `<button data-action="copy-share" data-id="${e.id}">リンクをコピー</button><button data-action="revoke" data-id="${e.id}">共有停止</button>` : ""}</div></article>`,
        )
        .join("")
    : `<div class="empty-state"><div class="empty-graphic">▧<span>↗</span></div><h2>${q ? "一致するキャプチャがありません" : "最初のキャプチャを、ここに。"}</h2><p>${q ? "別の言葉で検索してみてください。" : "画面を撮影するか、画像・動画を追加して始めましょう。"}<br>画像の原本と、共有する完成版をまとめて管理できます。</p><button data-action="import" class="primary">＋ ファイルを追加</button><span class="format-hint">PNG / JPEG / WebP / GIF / MP4 / WebM / MOV</span></div>`;
  document.querySelectorAll<HTMLInputElement>("[data-select]").forEach(
    (box) =>
      (box.onchange = () => {
        box.checked
          ? selected.add(box.dataset.select!)
          : selected.delete(box.dataset.select!);
        renderGallery();
      }),
  );
}
function renderDetail() {
  const a = entities.find((e) => e.id === detailId);
  if (a?.kind !== "asset") {
    detailId = "";
    $("#detail").classList.remove("visible");
    return;
  }
  const history = sources(a);
  const live = a.status === "published";
  const shared = sharedVersion(a);
  // 公開中は最新の作業を、停止中は最後に共有していた内容を初期表示にする（再開で別の版を出さないため）。
  const lastShared =
    shared && [...history].reverse().find((x) => x.sha256 === shared.sha256);
  const v =
    history.find((x) => x.id === versionId) ||
    (!live && lastShared) ||
    history.at(-1)!;
  versionId = v.id;
  const showsShared = live && !!shared && v.sha256 === shared.sha256;
  // 保管から戻した資産は以前のslugを持つため、再公開すると同じURLが再び有効になる。
  const resumable = a.status === "revoked" || !!a.currentPublishedVersionId;
  const shareSection = live
    ? `<section class="share-box"><span>共有URL · 編集しても変わりません</span><div class="share-row"><input aria-label="共有URL" readonly value="${esc(shareUrl(a))}"><button class="primary" data-action="copy-share" data-id="${a.id}">コピー</button></div><a href="${esc(shareUrl(a))}" target="_blank" rel="noopener noreferrer">共有ページを開く ↗</a></section>`
    : a.status === "archived"
      ? `<section class="share-box off"><p>保管済みです。共有URLは無効になっています。</p><button data-action="restore" data-id="${a.id}">保管済みから戻す</button></section>`
      : `<section class="share-box off"><p>${resumable ? "共有を止めています。再開すると、上の版が以前と同じURLで表示されます。" : "まだ共有URLがありません。"}</p><button class="primary" data-action="publish" data-id="${a.id}">${resumable ? "同じURLで共有を再開" : "共有URLを発行"}</button></section>`;
  const versionPicker =
    history.length > 1
      ? `<label class="field-label">版の履歴<select id="version-select">${[
          ...history,
        ]
          .reverse()
          .map(
            (x) =>
              `<option value="${x.id}" ${x.id === v.id ? "selected" : ""}>${versionLabel(x)} · ${date(x.createdAt)}${live && shared && x.sha256 === shared.sha256 ? "（共有中）" : !live && x === lastShared ? "（停止前の共有）" : ""}</option>`,
          )
          .join("")}</select></label>`
      : "";
  const editBlock =
    a.status === "archived"
      ? ""
      : `<section class="edit-block">${a.type === "image" ? '<button data-action="annotate">↗ 注釈を付ける</button>' : ""}${versionPicker}${live && !showsShared ? `<button class="primary" data-action="publish" data-id="${a.id}">この版を共有URLに反映</button>` : ""}${live ? '<p class="hint">注釈を付けたり版を切り替えたりしても、共有URLは同じままです。</p>' : ""}</section>`;
  $("#detail").innerHTML =
    `<header class="detail-header"><span class="eyebrow">CAPTURE DETAILS</span><button data-action="close-detail" aria-label="詳細を閉じる">×</button></header><h2>${esc(a.title)}</h2><span class="badge ${a.status}">${labels[a.status]}</span><div class="detail-media">${live ? `<span class="version-state ${showsShared ? "shared" : "pending"}">${showsShared ? "共有中の内容" : "共有URLには未反映"}</span>` : ""}${a.type === "image" ? `<img src="${media(a, v.id)}" alt="${esc(a.title)}">` : `<video controls src="${media(a, v.id)}"></video>`}</div>${shareSection}${editBlock}<form id="metadata-form"><label>タイトル<input name="title" value="${esc(a.title)}" required maxlength="200"></label><label>タグ（カンマ区切り）<input name="tags" value="${esc(a.tags.join(", "))}" maxlength="2400"></label><label>内部メモ<textarea name="notes" maxlength="5000" rows="3">${esc(a.notes)}</textarea></label><label>撮影元ページ名<input name="sourceTitle" value="${esc(a.sourceTitle)}" maxlength="500"></label><label>撮影元URL<input name="sourceUrl" value="${esc(a.sourceUrl)}" type="url" maxlength="2048"></label><button type="submit">情報を保存</button></form><div class="asset-facts"><span>撮影日時</span><span>${date(a.captureAt)}</span><span>ファイル</span><span>${(v.size / 1024 / 1024).toFixed(2)} MB · ${versionLabel(v)}</span></div><section class="ai-block"><span class="eyebrow">AI EDIT</span><div class="button-row"><button data-action="ai">AI参照情報をコピー</button>${a.status !== "archived" ? '<button data-action="working">作業版を追加</button>' : ""}</div><p class="hint">AIの編集結果は作業版として登録され、反映するまで共有URLの内容は変わりません。</p></section><div class="management"><button data-action="protect" data-id="${a.id}">${a.protected ? "✓ 保護中 · 解除する" : "削除から保護する"}</button>${a.status === "published" ? `<button data-action="revoke" data-id="${a.id}" class="danger">共有を停止</button>` : ""}${a.status !== "archived" ? `<button data-action="archive" data-id="${a.id}" class="subtle">保管済みへ移す</button>` : ""}<p class="hint">原本を削除する機能はありません。内部メモ・撮影元情報は共有ページには表示されません。</p></div>`;
  const picker = document.querySelector<HTMLSelectElement>("#version-select");
  if (picker)
    picker.onchange = () => {
      versionId = picker.value;
      renderDetail();
    };
  $<HTMLFormElement>("#metadata-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    void action(async () => {
      await api(`/assets/${a.id}`, "PATCH", {
        revision: a.revision,
        title: f.get("title"),
        notes: f.get("notes"),
        sourceTitle: f.get("sourceTitle"),
        sourceUrl: f.get("sourceUrl"),
        tags: String(f.get("tags"))
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      await refresh();
      notify("情報を保存しました。");
    });
  };
}
function importDialog(working = false) {
  modal(
    working ? "作業版を追加" : "画像・動画を追加",
    `<form id="upload-form"><label class="drop-zone">＋ ファイルを選ぶ<input id="file-input" name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime" ${working ? "" : "multiple"} required><span>1ファイル100MBまで</span></label>${working ? '<label>作成者<select name="createdBy"><option value="user">自分</option><option value="ai">AI</option></select></label>' : '<label>タイトル（複数の場合は各ファイル名を使用）<input name="title" maxlength="200"></label><label>撮影元ページ名<input name="sourceTitle" maxlength="500"></label><label>撮影元URL<input name="sourceUrl" type="url" maxlength="2048"></label>'}<p class="hint">${working ? "登録だけでは公開内容は変わりません。" : session.mode === "local" ? "追加すると、このPC内で開ける共有URLが付きます。" : "追加すると共有URLが付きます。"}</p><button class="primary" type="submit">${working ? "作業版を登録" : "追加する"}</button></form>`,
  );
  $<HTMLFormElement>("#upload-form").onsubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    void action(async () => {
      const files = [...($<HTMLInputElement>("#file-input").files || [])];
      let last: Asset | undefined;
      for (const file of files) {
        if (file.size > session.maxBytes)
          throw new Error("ファイルは100MB以下にしてください。");
        const body = new FormData(form);
        body.set("file", file);
        if (!working) {
          body.set("publishNow", "true");
          body.set(
            "title",
            files.length === 1
              ? String(body.get("title") || file.name)
              : file.name,
          );
          body.set("captureAt", new Date(file.lastModified).toISOString());
        } else
          body.set(
            "revision",
            String(entities.find((e) => e.id === detailId)!.revision),
          );
        const a: Asset = await api(
          working ? `/assets/${detailId}/versions` : "/assets",
          "POST",
          body,
        );
        detailId = a.id;
        versionId = working ? a.versions.at(-1)!.id : "";
        last = a;
        entities = await api("/entities");
      }
      close();
      await refresh();
      if (working)
        notify("作業版を保存しました。反映するまで共有URLの内容は変わりません。");
      else if (files.length === 1 && last) await announceShare(last);
      else notify(`${files.length}件に共有URLを作成しました。`);
    });
  };
}
function collectionDialog(existing?: Collection) {
  let ids = existing ? [...existing.orderedAssetIds] : [...selected];
  const choices = entities.filter(
    (e): e is Asset =>
      e.kind === "asset" && e.status === "published" && e.type === "image",
  );
  modal(
    existing ? "コレクションを編集" : "まとめて共有",
    `<form id="collection-form"><label>タイトル<input name="title" value="${esc(existing?.title || "")}" required maxlength="200"></label><label>公開する説明<textarea name="description" maxlength="5000">${esc(existing?.description || "")}</textarea></label><p class="hint">上から順に表示します。公開済みの画像だけを追加できます。</p><div id="collection-order"></div><div class="button-row"><select id="collection-add" aria-label="追加する画像"><option value="">追加する画像を選択</option>${choices.map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join("")}</select><button type="button" id="add-collection-item">追加</button></div><button type="submit" class="primary">${existing ? "この内容で公開を更新" : "コレクションを公開"}</button></form>`,
  );
  const order = () => {
    $("#collection-order").innerHTML = ids
      .map(
        (id, i) =>
          `<div class="order-item"><span>${i + 1}. ${esc(entities.find((e) => e.id === id)?.title || "見つからない画像")}</span><button type="button" data-order="up" data-index="${i}" aria-label="${i + 1}番目を上へ">↑</button><button type="button" data-order="down" data-index="${i}" aria-label="${i + 1}番目を下へ">↓</button><button type="button" data-order="remove" data-index="${i}" aria-label="${i + 1}番目を外す">×</button></div>`,
      )
      .join("");
    document.querySelectorAll<HTMLButtonElement>("[data-order]").forEach(
      (b) =>
        (b.onclick = () => {
          const i = Number(b.dataset.index);
          const j = b.dataset.order === "up" ? i - 1 : i + 1;
          if (b.dataset.order === "remove") ids.splice(i, 1);
          else if (j >= 0 && j < ids.length)
            [ids[i], ids[j]] = [ids[j], ids[i]];
          order();
        }),
    );
  };
  order();
  $("#add-collection-item").onclick = () => {
    const id = $<HTMLSelectElement>("#collection-add").value;
    if (id && !ids.includes(id)) {
      ids.push(id);
      order();
    }
  };
  $<HTMLFormElement>("#collection-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    void action(async () => {
      await api(
        existing ? `/collections/${existing.id}` : "/collections",
        existing ? "PUT" : "POST",
        {
          title: f.get("title"),
          description: f.get("description"),
          orderedAssetIds: ids,
          ...(existing ? { revision: existing.revision } : {}),
        },
      );
      close();
      selected.clear();
      filter = "collection";
      detailId = "";
      await refresh();
      notify("コレクションを公開しました。");
    });
  };
}
async function confirmAction(
  title: string,
  message: string,
  label: string,
  run: () => Promise<void>,
) {
  modal(
    title,
    `<p>${esc(message)}</p><div class="dialog-actions"><button data-action="close">キャンセル</button><button id="confirm" class="primary">${esc(label)}</button></div>`,
  );
  $("#confirm").onclick = () =>
    void action(async () => {
      await run();
      close();
      await refresh();
    });
}
let recorder: MediaRecorder | null = null;
let recordingStream: MediaStream | null = null;
async function saveCapture(blob: Blob, name: string) {
  const form = new FormData();
  form.set("file", blob, name);
  form.set("title", name);
  form.set("captureAt", new Date().toISOString());
  form.set("publishNow", "true");
  const a: Asset = await api("/assets", "POST", form);
  detailId = a.id;
  versionId = "";
  await refresh();
  await announceShare(a);
}
async function capture(record = false) {
  if (record && recorder?.state === "recording") {
    recorder.stop();
    recordingStream?.getTracks().forEach((t) => t.stop());
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia)
    throw new Error(
      "このブラウザは画面撮影に対応していません。Chrome/Edgeを使うか、OS標準機能で撮影して追加してください。",
    );
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: record,
  });
  if (!record) {
    try {
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 250));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      const blob = await selectRegion(canvas);
      if (!blob) return;
      await saveCapture(
        blob,
        `画面キャプチャ ${date(new Date().toISOString())}.png`,
      );
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(
      "録画に対応していません。OS標準機能で録画して追加してください。",
    );
  }
  const mime = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  if (!mime) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("対応する動画形式がありません。");
  }
  recorder = new MediaRecorder(stream, { mimeType: mime });
  recordingStream = stream;
  const chunks: Blob[] = [];
  let size = 0;
  recorder.ondataavailable = (e) => {
    if (e.data.size) {
      chunks.push(e.data);
      size += e.data.size;
      if (size > 95 * 1024 * 1024 && recorder?.state === "recording") {
        notify("容量上限に近いため録画を停止しました。");
        recorder.stop();
      }
    }
  };
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    recordingStream = null;
    const blob = new Blob(chunks, { type: mime });
    const persist = () => {
      if (busy) {
        setTimeout(persist, 100);
        return;
      }
      void action(async () => {
        await saveCapture(
          blob,
          `画面録画 ${date(new Date().toISOString())}.${mime.includes("mp4") ? "mp4" : "webm"}`,
        );
      });
    };
    persist();
  };
  stream.getVideoTracks()[0].onended = () => {
    if (recorder?.state === "recording") recorder.stop();
  };
  recorder.start(1000);
  $("#record-button").textContent = "■ 録画を停止";
  $("#record-button").classList.add("recording");
  notify("録画中です。「録画を停止」で保存します。");
}
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!b) return;
  const act = b.dataset.action;
  const id = b.dataset.id;
  const entity = entities.find((e) => e.id === id);
  const current = entities.find((e) => e.id === detailId) as Asset | undefined;
  if (act === "close") {
    close();
    return;
  }
  if (act === "filter") {
    filter = id!;
    detailId = "";
    render();
    return;
  }
  if (act === "detail" || act === "close-detail") {
    // 一覧全体を描き直すとサムネイルが一瞬消えるため、選択表示と詳細だけを更新する。
    detailId = act === "detail" ? id! : "";
    versionId = "";
    document
      .querySelectorAll<HTMLElement>("[data-card]")
      .forEach((card) =>
        card.classList.toggle("selected", card.dataset.card === detailId),
      );
    $("#detail").classList.toggle("visible", !!detailId);
    renderDetail();
    return;
  }
  if (act === "clear-selection") {
    selected.clear();
    renderGallery();
    return;
  }
  if (act === "import" || act === "working") {
    importDialog(act === "working");
    return;
  }
  if (act === "collection") {
    collectionDialog();
    return;
  }
  if (act === "edit-collection" && entity?.kind === "collection") {
    collectionDialog(entity);
    return;
  }
  void action(async () => {
    if (act === "refresh") {
      await refresh();
      notify("最新の状態を読み込みました。");
    }
    if (act === "copy-share" && entity)
      await copy(shareUrl(entity), "共有URLをコピーしました。");
    if (act === "ai" && current)
      await copy(
        JSON.stringify(
          await api(`/assets/${current.id}/ai?versionId=${versionId}`),
          null,
          2,
        ),
        "AI参照情報をコピーしました。",
      );
    if (act === "protect" && entity?.kind === "asset") {
      await api(`/assets/${entity.id}`, "PATCH", {
        revision: entity.revision,
        protected: !entity.protected,
      });
      await refresh();
    }
    if (act === "publish" && current) {
      const live = current.status === "published";
      await confirmAction(
        live ? "共有URLの内容を更新" : "共有を開始",
        session.mode === "cloud"
          ? "選んだ版を、リンクを知る人が見られる状態にします。画像内に見せたくない情報がないか確認してください。"
          : "選んだ版を、このPC内の共有ページで表示します。",
        live ? "反映する" : "共有する",
        async () => {
          const updated: Asset = await api(
            `/assets/${current.id}/publish`,
            "POST",
            { revision: current.revision, versionId },
          );
          if (live) notify("共有URLの内容を更新しました。URLは変わりません。");
          else await announceShare(updated);
        },
      );
    }
    if (act === "revoke" && entity)
      await confirmAction(
        "共有を停止",
        "このURLから表示できなくなります。原本・作業版は残ります。資産の停止はコレクション経由の表示にも適用されます。",
        "共有を停止する",
        async () => {
          await api(`/entities/${entity.id}/revoke`, "POST", {
            revision: entity.revision,
          });
          versionId = "";
        },
      );
    if (act === "archive" && entity)
      await confirmAction(
        "保管済みへ移す",
        "一覧から保管済みへ移します。ファイルは残り、あとで戻せます。公開中・保護中・公開コレクション利用中の画像は移せません。",
        "保管済みへ移す",
        async () => {
          await api(`/entities/${entity.id}/archive`, "POST", {
            revision: entity.revision,
          });
        },
      );
    if (act === "restore" && entity) {
      await api(`/entities/${entity.id}/restore`, "POST", {
        revision: entity.revision,
      });
      await refresh();
    }
    if (act === "annotate" && current) {
      const a = current;
      const sourceVersionId = versionId;
      modal("画像に注釈を付ける", '<div id="annotation-editor"></div>', true);
      await annotate(
        $("#annotation-editor"),
        media(a, sourceVersionId),
        async (blob, meta, publish) => {
          let saved: Asset;
          try {
            const f = new FormData();
            f.set("file", blob, "annotation.png");
            f.set("revision", String(a.revision));
            f.set("annotationMeta", meta);
            saved = await api(`/assets/${a.id}/versions`, "POST", f);
          } catch (e) {
            notify((e as Error).message, true);
            return;
          }
          // 作業版の登録と公開は別操作のまま。利用者が「反映」ボタンを押した時だけ続けて公開する。
          versionId = saved.versions.at(-1)!.id;
          close();
          let message = "注釈を作業版に保存しました。確認して共有URLに反映できます。";
          let failed = false;
          if (publish)
            try {
              await api(`/assets/${a.id}/publish`, "POST", {
                revision: saved.revision,
                versionId,
              });
              message = "注釈を保存し、共有URLに反映しました。URLは変わりません。";
            } catch (e) {
              message = `注釈は作業版に保存しましたが、共有URLへの反映に失敗しました。${(e as Error).message}`;
              failed = true;
            }
          try {
            await refresh();
          } catch {
            /* 一覧は次のポーリングで追従する */
          }
          notify(message, failed);
        },
        a.status === "published",
      );
    }
    if (act === "capture" || act === "record") await capture(act === "record");
    if (act === "settings") {
      modal(
        "保存先・接続状態",
        `<p class="mode-note">${session.mode === "cloud" ? `${cloudLabel()} に接続する設定です。` : "ローカル確認モードです。共有URLはこのPC内でのみ使えます。"}</p><form id="settings-form"><label>保存先フォルダ（絶対パス）<input name="root" value="${esc(session.root)}" required></label><p class="hint">このPC内の保存フォルダを指定します。既存ファイルは自動移動しません。</p><button class="primary" type="submit">保存先を変更</button></form><p class="hint">外部共有（画像の保管先とCloudflare）の接続設定はREADMEを参照してください。</p>`,
      );
      $<HTMLFormElement>("#settings-form").onsubmit = (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        void action(async () => {
          await api("/settings", "POST", { root: f.get("root") });
          session = await api("/session");
          close();
          render();
          notify("保存先を変更しました。");
        });
      };
    }
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && detailId && !$<HTMLDialogElement>("#modal").open) {
    $<HTMLButtonElement>('[data-action="close-detail"]').click();
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) && event.shiftKey &&
    event.key.toLowerCase() === "s" && !event.altKey &&
    !$<HTMLDialogElement>("#modal").open &&
    !(event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")
  ) {
    event.preventDefault();
    void action(() => capture());
  }
});
document.addEventListener("paste", (event) => {
  if ($<HTMLDialogElement>("#modal").open) return;
  if (event.target instanceof HTMLElement &&
    event.target.closest("input, textarea, [contenteditable]")) return;
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
  if (!item) return;
  const file = item.getAsFile();
  if (!file) return;
  event.preventDefault();
  void action(() => saveCapture(file, `貼り付けたキャプチャ ${date(new Date().toISOString())}.png`));
});
// ショートカット撮影の取り込みを拾うためのポーリング。cloudモードは台帳がWorker/D1にあり、
// 無料枠のリクエスト数を消費するため間隔を広げる。詳細の入力中は描き直すと未保存の文字が消えるので次回へ回す。
function poll() {
  setTimeout(
    async () => {
      const typing = (document.activeElement as HTMLElement | null)?.closest(
        "#metadata-form",
      );
      if (session && !busy && !typing && !$<HTMLDialogElement>("#modal").open && !document.hidden)
        try {
          const latest: Entity[] = await api("/entities");
          const changed = latest.length !== entities.length || latest.some((entry, index) =>
            entry.id !== entities[index]?.id || entry.revision !== entities[index]?.revision);
          if (changed) {
            const added = latest.some((e) => !entities.some((x) => x.id === e.id));
            entities = latest;
            render();
            if (added) notify("新しいキャプチャを取り込みました。");
          }
          const current = await api("/session");
          if (
            session.shortcut !== current.shortcut ||
            JSON.stringify(session.shortcutKeys) !== JSON.stringify(current.shortcutKeys)
          ) {
            session = current;
            render();
          }
        } catch { /* connection errors are handled by manual refresh */ }
      poll();
    },
    session?.mode === "cloud" ? 15000 : 3000,
  );
}
poll();
window.addEventListener("beforeunload", (e) => {
  if (recorder?.state === "recording") {
    e.preventDefault();
    e.returnValue = "";
  }
});
api("/session")
  .then((s) => {
    session = s;
    document.title = `${appName()} — 撮る、整える、つなぐ。`;
    return refresh();
  })
  .catch((e) => {
    $("#app").innerHTML =
      `<main class="startup-error"><h1>Cliplinkを開けませんでした</h1><p>${esc(e.message)}</p><button id="retry-startup">再読み込み</button></main>`;
    $("#retry-startup").onclick = () => location.reload();
  });
