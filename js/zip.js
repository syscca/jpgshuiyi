/*
 * 极简 ZIP 打包器（Store 不压缩，纯 JS，无第三方依赖）
 * 用于浏览器不支持 File System Access API（无法直接写文件夹）时兜底导出。
 * 用法：
 *   const zw = new SimpleZip();
 *   zw.addFile('a.jpg', blobOrArrayBuffer);
 *   const blob = await zw.generate();
 */
(function (global) {
  'use strict';

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) {
      c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function strBytes(s) {
    return new TextEncoder().encode(s);
  }

  function writeU16(view, off, v) { view.setUint16(off, v, true); }
  function writeU32(view, off, v) { view.setUint32(off, v >>> 0, true); }

  function dosTime(date) {
    const t =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const d =
      (((date.getFullYear() - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f);
    return { t, d };
  }

  class SimpleZip {
    constructor() {
      this.files = [];
    }

    addFile(name, data) {
      this.files.push({ name, data });
    }

    async generate() {
      const now = new Date();
      const { t: time, d: date } = dosTime(now);
      const chunks = [];
      const central = [];
      let offset = 0;

      for (const f of this.files) {
        const buf = (f.data instanceof Blob)
          ? await f.data.arrayBuffer()
          : (f.data instanceof ArrayBuffer ? f.data : f.data.buffer);
        const u8 = new Uint8Array(buf);
        const crc = crc32(u8);
        const nameB = strBytes(f.name);

        // ---- 本地文件头 (30 + name) ----
        const local = new ArrayBuffer(30);
        const lv = new DataView(local);
        writeU32(lv, 0, 0x04034b50);
        writeU16(lv, 4, 20);            // 解压版本
        writeU16(lv, 6, 0x0800);        // 标志：UTF-8 名称
        writeU16(lv, 8, 0);             // 压缩方式：Store
        writeU16(lv, 10, time);
        writeU16(lv, 12, date);
        writeU32(lv, 14, crc);
        writeU32(lv, 18, u8.length);    // 压缩后大小
        writeU32(lv, 22, u8.length);    // 原始大小
        writeU16(lv, 26, nameB.length);
        writeU16(lv, 28, 0);

        chunks.push(new Blob([local, nameB, u8]));
        central.push({ nameB, crc, size: u8.length, offset });
        offset += 30 + nameB.length + u8.length;
      }

      // ---- 中央目录 ----
      let centralSize = 0;
      for (const c of central) {
        const cd = new ArrayBuffer(46);
        const cv = new DataView(cd);
        writeU32(cv, 0, 0x02014b50);
        writeU16(cv, 4, 20);
        writeU16(cv, 6, 20);
        writeU16(cv, 8, 0x0800);
        writeU16(cv, 10, 0);
        writeU16(cv, 12, time);
        writeU16(cv, 14, date);
        writeU32(cv, 16, c.crc);
        writeU32(cv, 20, c.size);
        writeU32(cv, 24, c.size);
        writeU16(cv, 28, c.nameB.length);
        writeU16(cv, 30, 0);
        writeU16(cv, 32, 0);
        writeU16(cv, 34, 0);
        writeU16(cv, 36, 0);
        writeU32(cv, 38, 0);
        writeU32(cv, 42, c.offset);
        chunks.push(new Blob([cd, c.nameB]));
        centralSize += 46 + c.nameB.length;
      }

      // ---- EOCD ----
      const eocd = new ArrayBuffer(22);
      const ev = new DataView(eocd);
      writeU32(ev, 0, 0x06054b50);
      writeU16(ev, 4, 0);
      writeU16(ev, 6, 0);
      writeU16(ev, 8, this.files.length);
      writeU16(ev, 10, this.files.length);
      writeU32(ev, 12, centralSize);
      writeU32(ev, 16, offset);
      writeU16(ev, 20, 0);
      chunks.push(new Blob([eocd]));

      return new Blob(chunks, { type: 'application/zip' });
    }
  }

  global.SimpleZip = SimpleZip;
})(window);
