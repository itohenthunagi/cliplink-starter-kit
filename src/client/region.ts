export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cropRectangle(
  start: { x: number; y: number },
  end: { x: number; y: number },
  displayed: Rectangle,
  imageWidth: number,
  imageHeight: number,
): Rectangle | null {
  const left = Math.max(displayed.x, Math.min(start.x, end.x));
  const top = Math.max(displayed.y, Math.min(start.y, end.y));
  const right = Math.min(displayed.x + displayed.width, Math.max(start.x, end.x));
  const bottom = Math.min(displayed.y + displayed.height, Math.max(start.y, end.y));
  if (right - left < 4 || bottom - top < 4) return null;
  const scaleX = imageWidth / displayed.width;
  const scaleY = imageHeight / displayed.height;
  const x = Math.floor((left - displayed.x) * scaleX);
  const y = Math.floor((top - displayed.y) * scaleY);
  return {
    x,
    y,
    width: Math.min(imageWidth - x, Math.ceil((right - left) * scaleX)),
    height: Math.min(imageHeight - y, Math.ceil((bottom - top) * scaleY)),
  };
}

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("撮影できませんでした。"))),
      "image/png",
    ),
  );

export async function selectRegion(source: HTMLCanvasElement): Promise<Blob | null> {
  const image = new Image();
  const url = source.toDataURL("image/png");
  image.src = url;
  await image.decode();
  const overlay = document.createElement("div");
  overlay.className = "region-overlay";
  overlay.innerHTML = '<div class="region-toolbar"><strong>撮影する範囲をドラッグ</strong><button type="button" data-region="full">全体を保存</button><button type="button" data-region="cancel">キャンセル</button></div><div class="region-stage"><img alt="撮影した画面" draggable="false"><div class="region-selection"></div></div>';
  const stage = overlay.querySelector<HTMLElement>(".region-stage")!;
  const selection = overlay.querySelector<HTMLElement>(".region-selection")!;
  const preview = overlay.querySelector<HTMLImageElement>("img")!;
  preview.src = url;
  document.body.append(overlay);
  return new Promise<Blob | null>((resolve, reject) => {
    let start: { x: number; y: number } | null = null;
    const done = async (rectangle?: Rectangle) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (!rectangle) return resolve(null);
      try {
        const output = document.createElement("canvas");
        output.width = rectangle.width;
        output.height = rectangle.height;
        output.getContext("2d")!.drawImage(
          image,
          rectangle.x,
          rectangle.y,
          rectangle.width,
          rectangle.height,
          0,
          0,
          rectangle.width,
          rectangle.height,
        );
        resolve(await toBlob(output));
      } catch (error) {
        reject(error);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void done();
    };
    document.addEventListener("keydown", onKey);
    overlay.querySelector('[data-region="cancel"]')!.addEventListener("click", () => void done());
    overlay.querySelector('[data-region="full"]')!.addEventListener("click", () =>
      void done({ x: 0, y: 0, width: source.width, height: source.height }),
    );
    stage.onpointerdown = (event) => {
      if (event.target !== preview && event.target !== selection) return;
      start = { x: event.clientX, y: event.clientY };
      stage.setPointerCapture(event.pointerId);
      selection.style.display = "block";
    };
    stage.onpointermove = (event) => {
      if (!start) return;
      const imageRect = preview.getBoundingClientRect();
      const rectangle = cropRectangle(start, { x: event.clientX, y: event.clientY },
        { x: imageRect.left, y: imageRect.top, width: imageRect.width, height: imageRect.height },
        source.width, source.height);
      if (!rectangle) return;
      selection.style.left = `${imageRect.left + rectangle.x * imageRect.width / source.width - stage.getBoundingClientRect().left}px`;
      selection.style.top = `${imageRect.top + rectangle.y * imageRect.height / source.height - stage.getBoundingClientRect().top}px`;
      selection.style.width = `${rectangle.width * imageRect.width / source.width}px`;
      selection.style.height = `${rectangle.height * imageRect.height / source.height}px`;
    };
    stage.onpointerup = (event) => {
      if (!start) return;
      const imageRect = preview.getBoundingClientRect();
      const rectangle = cropRectangle(start, { x: event.clientX, y: event.clientY },
        { x: imageRect.left, y: imageRect.top, width: imageRect.width, height: imageRect.height },
        source.width, source.height);
      start = null;
      if (rectangle) void done(rectangle);
      else selection.style.display = "none";
    };
  });
}
