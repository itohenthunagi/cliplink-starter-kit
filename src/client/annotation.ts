type Point = { x: number; y: number };
type Mark = {
  tool: string;
  from: Point;
  to: Point;
  text: string;
  number: number;
};
export async function annotate(
  container: HTMLElement,
  url: string,
  onSave: (blob: Blob, meta: string, publish: boolean) => Promise<void>,
  publishable = false,
) {
  // 公開中の画像では「保存して反映」を主操作にする。作業版だけ残す操作も並べ、公開は必ずボタンで選ばせる。
  container.innerHTML = `<div class="editor-tools" role="group" aria-label="注釈ツール"><button data-tool="arrow" class="active">↗ 矢印</button><button data-tool="number">① 番号</button><button data-tool="text">T 文字</button><button data-tool="blackout">■ 黒塗り</button><label>文字<input id="annotation-text" placeholder="注釈の文字" maxlength="100"></label><button id="undo">↶ 戻す</button><span class="editor-save"><button data-save="working" ${publishable ? "" : 'class="primary"'}>作業版として保存</button>${publishable ? '<button data-save="publish" class="primary">保存して共有URLに反映</button>' : ""}</span></div><p class="hint">矢印・黒塗りはドラッグ、番号・文字はクリックして配置。${publishable ? "「保存して共有URLに反映」で、同じURLの表示が注釈付きに変わります。原本は残ります。" : "保存後に確認して共有できます。原本は残ります。"}</p><div class="canvas-wrap"><canvas aria-label="画像に注釈を付けるキャンバス"></canvas></div>`;
  const image = new Image();
  image.src = url;
  await image.decode();
  if (image.naturalWidth * image.naturalHeight > 40_000_000)
    throw new Error(
      "この画像は注釈編集の上限（4,000万画素）を超えています。外部で編集して作業版を登録してください。",
    );
  const canvas = container.querySelector("canvas")!;
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  let marks: Mark[] = [];
  let pending: Mark | null = null;
  let tool = "arrow";
  const unit = Math.max(3, canvas.width / 250);
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    ctx.lineWidth = unit;
    ctx.strokeStyle = "#ee493d";
    ctx.fillStyle = "#ee493d";
    ctx.lineCap = "round";
    for (const m of [...marks, ...(pending ? [pending] : [])]) {
      const { from: a, to: b } = m;
      ctx.fillStyle = "#ee493d";
      ctx.strokeStyle = "#ee493d";
      if (m.tool === "blackout") {
        ctx.fillStyle = "#000";
        ctx.fillRect(
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.abs(a.x - b.x),
          Math.abs(a.y - b.y),
        );
      } else if (m.tool === "arrow") {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.moveTo(
          b.x - unit * 5 * Math.cos(angle - 0.5),
          b.y - unit * 5 * Math.sin(angle - 0.5),
        );
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(
          b.x - unit * 5 * Math.cos(angle + 0.5),
          b.y - unit * 5 * Math.sin(angle + 0.5),
        );
        ctx.stroke();
      } else if (m.tool === "number") {
        ctx.beginPath();
        ctx.arc(a.x, a.y, unit * 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "white";
        ctx.font = `bold ${unit * 6}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(m.number), a.x, a.y);
      } else {
        ctx.font = `bold ${unit * 7}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.lineWidth = unit;
        ctx.strokeStyle = "white";
        ctx.strokeText(m.text, a.x, a.y);
        ctx.fillText(m.text, a.x, a.y);
        ctx.lineWidth = unit;
      }
    }
  }
  const point = (e: PointerEvent): Point => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(canvas.width, ((e.clientX - r.left) * canvas.width) / r.width),
      ),
      y: Math.max(
        0,
        Math.min(
          canvas.height,
          ((e.clientY - r.top) * canvas.height) / r.height,
        ),
      ),
    };
  };
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = point(e);
    pending = {
      tool,
      from: p,
      to: p,
      text: (container.querySelector("#annotation-text") as HTMLInputElement)
        .value,
      number: marks.filter((m) => m.tool === "number").length + 1,
    };
    draw();
  };
  canvas.onpointermove = (e) => {
    if (pending) {
      pending.to = point(e);
      draw();
    }
  };
  canvas.onpointerup = () => {
    if (pending) {
      marks.push(pending);
      pending = null;
      draw();
    }
  };
  canvas.onpointercancel = () => {
    pending = null;
    draw();
  };
  container.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach(
    (b) =>
      (b.onclick = () => {
        tool = b.dataset.tool!;
        container
          .querySelectorAll("[data-tool]")
          .forEach((x) => x.classList.toggle("active", x === b));
      }),
  );
  container.querySelector<HTMLButtonElement>("#undo")!.onclick = () => {
    marks.pop();
    draw();
  };
  const saveButtons =
    container.querySelectorAll<HTMLButtonElement>("[data-save]");
  saveButtons.forEach(
    (button) =>
      (button.onclick = async () => {
        saveButtons.forEach((b) => (b.disabled = true));
        try {
          const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (b) =>
                b ? resolve(b) : reject(new Error("画像を書き出せません。")),
              "image/png",
            ),
          );
          await onSave(
            blob,
            JSON.stringify(marks),
            button.dataset.save === "publish",
          );
        } finally {
          saveButtons.forEach((b) => (b.disabled = false));
        }
      }),
  );
  draw();
}
