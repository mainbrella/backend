import { gzipSync } from 'node:zlib';

// Write the small reference bundle as portable USTAR directly. Host tar defaults
// differ between macOS and Linux and may copy xattrs, ownership and timestamps.
export function agentReferenceArchive(files) {
  const entries = {
    'mainbrella-containers/': null,
    'mainbrella-containers/references/': null,
    ...(Object.keys(files).some(name => name.startsWith('scripts/')) ? { 'mainbrella-containers/scripts/': null } : {}),
    ...Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`mainbrella-containers/${name}`, bytes])),
  };
  const blocks = [];
  for (const name of Object.keys(entries).sort()) {
    if (Buffer.byteLength(name) > 100 || !/^mainbrella-containers\/[a-zA-Z0-9./_-]*$/.test(name) || name.includes('..')) {
      throw new Error(`Unsupported reference archive path: ${name}`);
    }
    const directory = entries[name] === null;
    const bytes = directory ? Buffer.alloc(0) : Buffer.from(entries[name]);
    const header = Buffer.alloc(512);
    const octal = (value, offset, length) => {
      const digits = value.toString(8);
      if (digits.length >= length) throw new Error('Reference archive exceeds USTAR limits');
      header.write(`${digits.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
    };
    header.write(name, 0, 100, 'ascii');
    octal(directory ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8); // uid
    octal(0, 116, 8); // gid
    octal(bytes.length, 124, 12);
    octal(0, 136, 12); // mtime
    header.fill(0x20, 148, 156);
    header.write(directory ? '5' : '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  // gzipSync writes a zero timestamp and no filename/comment header.
  const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
  archive[9] = 255; // unspecified OS, independent of the build host
  return archive;
}
