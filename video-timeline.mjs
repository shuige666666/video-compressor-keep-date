/** 只读取 MP4/MOV 的 moov 样本表，快速核对帧数和逐帧显示时间。 */
import fs from 'node:fs/promises';

/** 遍历内存中的子容器；mdat 视频数据不参与解析。 */
function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  for (let offset = start; offset + 8 <= end;) {
    let size = buffer.readUInt32BE(offset), header = 8;
    if (size === 1) { size = Number(buffer.readBigUInt64BE(offset + 8)); header = 16; }
    if (size === 0) size = end - offset;
    if (size < header || offset + size > end) throw new Error('MP4 容器长度不完整');
    result.push({ type: buffer.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

/** 按顶层容器长度跳过大视频数据，只把较小的 moov 元数据读入内存。 */
async function readMoov(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(16);
    for (let offset = 0; offset + 8 <= fileSize;) {
      const read = await handle.read(header, 0, Math.min(16, fileSize - offset), offset);
      if (read.bytesRead < 8) return null;
      let size = header.readUInt32BE(0), prefix = 8;
      if (size === 1) { size = Number(header.readBigUInt64BE(8)); prefix = 16; }
      if (size === 0) size = fileSize - offset;
      if (size < prefix || offset + size > fileSize) return null;
      if (header.toString('ascii', 4, 8) === 'moov') {
        // 异常或超大的元数据不整块载入，保留其他容器的兼容路径。
        if (size - prefix > 128 * 1024 * 1024) return null;
        const data = Buffer.alloc(size - prefix);
        let filled = 0;
        while (filled < data.length) {
          const part = await handle.read(data, filled, data.length - filled, offset + prefix + filled);
          if (!part.bytesRead) return null;
          filled += part.bytesRead;
        }
        return data;
      }
      offset += size;
    }
    return null;
  } finally { await handle.close(); }
}

/** 返回第一条视频轨道的帧序列；非普通 MP4/MOV 样本表返回 null。 */
export async function readVideoTimeline(file) {
  const buffer = await readMoov(file);
  if (!buffer) return null;
  const children = (box) => boxes(buffer, box.start, box.end);
  for (const trak of boxes(buffer).filter((box) => box.type === 'trak')) {
    const mdia = children(trak).find((box) => box.type === 'mdia');
    if (!mdia) continue;
    const entries = children(mdia);
    const hdlr = entries.find((box) => box.type === 'hdlr');
    if (!hdlr || buffer.toString('ascii', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    const mdhd = entries.find((box) => box.type === 'mdhd');
    const timescale = buffer.readUInt32BE(mdhd.start + (buffer[mdhd.start] === 1 ? 20 : 12));
    const minf = entries.find((box) => box.type === 'minf');
    const stbl = children(minf).find((box) => box.type === 'stbl');
    const tables = children(stbl);
    const stsz = tables.find((box) => box.type === 'stsz');
    const stts = tables.find((box) => box.type === 'stts');
    if (!stsz || !stts || !timescale) return null;
    const count = buffer.readUInt32BE(stsz.start + 8);
    if (!count) return null; // 分片 MP4 的帧记录在 moof，不能当作零帧核对。
    const pts = new Float64Array(count);
    let index = 0, dts = 0;
    for (let i = 0; i < buffer.readUInt32BE(stts.start + 4); i++) {
      const frames = buffer.readUInt32BE(stts.start + 8 + i * 8);
      const delta = buffer.readUInt32BE(stts.start + 12 + i * 8);
      for (let j = 0; j < frames; j++) { pts[index++] = dts; dts += delta; }
    }
    if (index !== count) throw new Error('视频样本数量与时间表不一致');
    const ctts = tables.find((box) => box.type === 'ctts');
    if (ctts) {
      index = 0;
      for (let i = 0; i < buffer.readUInt32BE(ctts.start + 4); i++) {
        const frames = buffer.readUInt32BE(ctts.start + 8 + i * 8);
        const offset = buffer[ctts.start] === 1
          ? buffer.readInt32BE(ctts.start + 12 + i * 8) : buffer.readUInt32BE(ctts.start + 12 + i * 8);
        for (let j = 0; j < frames; j++) pts[index++] += offset;
      }
      if (index !== count) throw new Error('视频显示时间表不完整');
    }
    // B 帧按解码顺序存放，核对时恢复显示顺序并忽略整体起点平移。
    pts.sort();
    const first = pts[0];
    for (let i = 0; i < count; i++) pts[i] = (pts[i] - first) / timescale;
    return { count, timescale, pts };
  }
  return null;
}

/** 核对帧数和相邻显示时间；失败时由任务明确报错，不能静默标记完成。 */
export async function verifyVideoTimeline(source, output) {
  const original = await readVideoTimeline(source);
  if (!original) return { ok: true, checked: false, reason: '原片容器不支持快速样本表核对' };
  const result = await readVideoTimeline(output);
  if (!result) throw new Error('无法读取输出的视频时间表');
  const detail = { checked: true, sourceFrames: original.count, outputFrames: result.count };
  if (original.count !== result.count) return { ...detail, ok: false,
    error: `帧数不一致：原片 ${original.count} 帧，输出 ${result.count} 帧` };
  let maxTimestampError = 0;
  for (let i = 0; i < original.count; i++) maxTimestampError = Math.max(maxTimestampError, Math.abs(original.pts[i] - result.pts[i]));
  const tolerance = Math.max(1 / original.timescale, 1 / result.timescale) * 1.5 + 0.000001;
  return { ...detail, ok: maxTimestampError <= tolerance, maxTimestampError,
    ...(maxTimestampError > tolerance ? { error: '逐帧显示时间与原片不一致' } : {}) };
}
