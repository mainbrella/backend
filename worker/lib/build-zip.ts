import { validBuildPath, validateBuildFiles, type BuildFiles } from './build-contract';
import { BUILD_IMAGE_MAX_BYTES } from './build-images';

// Small source exports use the ZIP store method; no archive dependency is needed.
export function buildSourceZip(files: BuildFiles, assets: Record<string, Uint8Array> = {}): Uint8Array<ArrayBuffer> {
  validateBuildFiles(files);
  if (Object.keys(assets).length > 12 || Object.entries(assets).some(([path, data]) => !validBuildPath(path)
    || Object.hasOwn(files, path) || data.byteLength > BUILD_IMAGE_MAX_BYTES)) throw new Error('invalid_build_assets');
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [], directory: Uint8Array[] = [];
  let offset = 0, directorySize = 0;
  const crc32 = (data: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const entries = [...Object.entries(files).map(([path, content]) => [path, encoder.encode(content)] as const), ...Object.entries(assets)];
  for (const [path, data] of entries) {
    const name = encoder.encode(path), crc = crc32(data);
    const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true); header.set(name, 30);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    local.push(header, data); directory.push(central); directorySize += central.length; offset += header.length + data.length;
  }
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, directory.length, true); ev.setUint16(10, directory.length, true);
  ev.setUint32(12, directorySize, true); ev.setUint32(16, offset, true);
  const zip = new Uint8Array(offset + directorySize + end.length);
  let cursor = 0;
  for (const chunk of [...local, ...directory, end]) { zip.set(chunk, cursor); cursor += chunk.length; }
  return zip;
}
