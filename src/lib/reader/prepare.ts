import { MAX_IMAGE_EDGE, MAX_PDF_BYTES } from './config';
import { ReaderError } from './errors';
import type { PreparedFile } from './types';

// ---------------------------------------------------------------------------------------------
// Getting a file ready to send. iPhone photos are large (and often HEIC), so photos are redrawn at
// most MAX_IMAGE_EDGE pixels on the longest side and saved as JPEG; PDFs are sent as they are.
// ---------------------------------------------------------------------------------------------

export const isPdf = (f: Pick<File, 'type' | 'name'>) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const SENDABLE = ['image/jpeg', 'image/png', 'image/webp'];

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function decode(file: File): Promise<{ draw: CanvasImageSource; w: number; h: number; done: () => void }> {
  try {
    const bmp = await createImageBitmap(file);
    return { draw: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
  } catch {
    // Older Safari: draw it through an <img> (which also understands HEIC on an iPhone).
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { draw: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
}

async function shrink(file: File): Promise<Blob> {
  const src = await decode(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(src.w, src.h));
    const w = Math.max(1, Math.round(src.w * scale));
    const h = Math.max(1, Math.round(src.h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff'; // a transparent screenshot reads better on white than on black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src.draw, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('no blob');
    return blob;
  } finally {
    src.done();
  }
}

export async function prepareFile(file: File): Promise<PreparedFile> {
  if (isPdf(file)) {
    if (file.size > MAX_PDF_BYTES) throw new ReaderError('bad_file', { detail: 'That PDF is over 20 MB. Try a screenshot of the page instead.' });
    return { name: file.name, mimeType: 'application/pdf', base64: toBase64(await file.arrayBuffer()), bytes: file.size };
  }
  try {
    const blob = await shrink(file);
    return { name: file.name, mimeType: 'image/jpeg', base64: toBase64(await blob.arrayBuffer()), bytes: blob.size };
  } catch {
    // Couldn't redraw it: send it as it is if Google takes that kind of file and it isn't huge.
    if (SENDABLE.includes(file.type) && file.size <= MAX_PDF_BYTES) {
      return { name: file.name, mimeType: file.type, base64: toBase64(await file.arrayBuffer()), bytes: file.size };
    }
    throw new ReaderError('bad_file', { detail: 'That photo couldn’t be opened. Try a screenshot, a JPEG photo or the PDF.' });
  }
}
