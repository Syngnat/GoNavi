const DOCK_ICON_SIZE = 1024;
// The PNG handed to NSApp is already a complete Dock tile.  Leaving a
// 100px transparent border here makes GoNavi render visibly smaller than
// neighbouring macOS apps, so use the full 1024px canvas.
const DOCK_ICON_INSET = 0;
// Keep the same rounded-tile proportion used by the source artwork.
const DOCK_ICON_CORNER_RADIUS_RATIO = 184 / 824;

export type DockIconRuntimeEnvironment = {
  platform?: unknown;
  buildType?: unknown;
};

export type MacOSDockImageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * macOS and Windows both support changing the native runtime icon. The
 * generated Wails bridge also exists in the browser build, so checking method
 * presence alone would still serialize and post a large image from the web.
 */
export function shouldSyncApplicationBrandIcon(environment?: DockIconRuntimeEnvironment | null): boolean {
  const platform = String(environment?.platform || '').trim().toLowerCase();
  return (platform === 'darwin' || platform === 'windows')
    && String(environment?.buildType || '').trim().toLowerCase() !== 'web';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load dock icon: ${src}`));
    img.src = src;
  });
}

function canvasToBase64Png(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png');
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

export function calculateMacOSDockImageRect(imageWidth: number, imageHeight: number): MacOSDockImageRect {
  const tileSize = DOCK_ICON_SIZE - (DOCK_ICON_INSET * 2);
  const sourceWidth = Math.max(1, Number(imageWidth) || tileSize);
  const sourceHeight = Math.max(1, Number(imageHeight) || tileSize);
  const scale = Math.min(tileSize / sourceWidth, tileSize / sourceHeight);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  return {
    x: Math.round((DOCK_ICON_SIZE - width) / 2),
    y: Math.round((DOCK_ICON_SIZE - height) / 2),
    width,
    height,
  };
}

export function calculateMacOSDockCornerRadius(rect: MacOSDockImageRect): number {
  return Math.round(Math.min(rect.width, rect.height) * DOCK_ICON_CORNER_RADIUS_RATIO);
}

function clipMacOSDockImage(ctx: CanvasRenderingContext2D, rect: MacOSDockImageRect): void {
  const radius = calculateMacOSDockCornerRadius(rect);
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  ctx.beginPath();
  ctx.moveTo(rect.x + radius, rect.y);
  ctx.lineTo(right - radius, rect.y);
  ctx.arcTo(right, rect.y, right, rect.y + radius, radius);
  ctx.lineTo(right, bottom - radius);
  ctx.arcTo(right, bottom, right - radius, bottom, radius);
  ctx.lineTo(rect.x + radius, bottom);
  ctx.arcTo(rect.x, bottom, rect.x, bottom - radius, radius);
  ctx.lineTo(rect.x, rect.y + radius);
  ctx.arcTo(rect.x, rect.y, rect.x + radius, rect.y, radius);
  ctx.closePath();
  ctx.clip();
}

/**
 * Place the selected complete brand icon on a transparent macOS canvas.
 * Keep the source artwork intact while normalising its outer tile to the
 * standard macOS corner geometry.
 */
export async function composeMacOSDockIconBase64(src: string): Promise<string> {
  const img = await loadImage(src);
  const size = DOCK_ICON_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2d context unavailable');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const rect = calculateMacOSDockImageRect(img.naturalWidth || img.width, img.naturalHeight || img.height);
  clipMacOSDockImage(ctx, rect);
  ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height);
  return canvasToBase64Png(canvas);
}
