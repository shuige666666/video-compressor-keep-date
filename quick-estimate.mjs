/** 用多个原尺寸区域实测五档 CRF，正式压缩仍沿用原参数。 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const VERSION = 'multi-anchor-v2';
const ANCHORS = [18, 21, 24, 26, 28];
const FRAME_COUNT = 48;
const TIMEOUT_MS = 12000;
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));

/** 优先沿用音轨；与正式编码一样，无法直拷的音频按 192 kbps 计。 */
function audioBytes(info) {
  if (!info.audio) return 0;
  const copy = ['aac', 'mp3', 'alac', 'ac3', 'eac3'].includes((info.audio.codec || '').toLowerCase());
  return (copy ? (info.audio.bitrate || 128) : 192) * 1000 * (info.duration || 0) / 8;
}

/** 没有内容样本时先提供宽范围参考值，界面不必等试算完成。 */
function fallbackModel(reason = '') {
  return { kind: 'metadata', bpp22: 0.045 * Math.exp(0.13 * 3), slope: 0.13,
    uncertainty: 0.6, elapsedMs: 0, reason };
}

/** 由当前视频的模型生成某档大小及经验范围；范围不是统计置信区间。 */
export function estimateOne(info, crf) {
  const model = info.sizeModel || fallbackModel();
  const frames = Math.max(1, (info.fps || 30) * (info.duration || 1));
  const pixels = Math.max(1, (info.width || 1920) * (info.height || 1080));
  const audio = audioBytes(info);
  const points = model.points;
  let bpp;
  if (points?.length >= 2) {
    // 在相邻实测点之间按对数插值，不再用一条曲线覆盖所有画质档位。
    let right = points.findIndex((point) => point.crf >= crf);
    right = clamp(right < 0 ? points.length - 1 : right, 1, points.length - 1);
    const a = points[right - 1], b = points[right];
    const weight = (crf - a.crf) / (b.crf - a.crf);
    bpp = Math.exp(Math.log(a.bpp) + weight * Math.log(b.bpp / a.bpp));
  } else {
    bpp = model.bpp22 * Math.exp(-model.slope * (crf - 22));
  }
  const video = bpp * pixels * frames / 8;
  // 编码包之外预留少量封装空间，避免短片的音频/MP4 开销被忽略。
  const overhead = Math.max(4096, (video + audio) * 0.003);
  const bytes = Math.round(video + audio + overhead);
  const outside = Math.max(0, ANCHORS[0] - crf, crf - ANCHORS.at(-1));
  const uncertainty = clamp(model.uncertainty + outside * 0.025, 0.3, 0.75);
  return { crf, bytes, lowBytes: Math.round(video * (1 - uncertainty) + audio + overhead),
    highBytes: Math.round(video * (1 + uncertainty) + audio + overhead),
    ratio: info.size ? bytes / info.size : 0, bigger: !!info.size && bytes > info.size };
}

/** 一次生成所有档位，拖动 CRF 时直接读表，不再重复分析。 */
export function buildTable(info) {
  return Array.from({ length: 15 }, (_, i) => estimateOne(info, i + 16));
}

/** 解析内存中的编码包统计，把片段首帧按正式 GOP 摊销。 */
function parsePackets(text, pixels, keyint, frameCount) {
  const streams = ANCHORS.map(() => []);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.split(',');
    const stream = Number(fields[0]);
    const bytes = Number(fields[4]);
    if (streams[stream] && Number.isFinite(bytes) && bytes > 0) streams[stream].push(bytes);
  }
  return streams.map((packets) => {
    if (packets.length < frameCount) throw new Error('有效样本不足');
    // 极短片段的起步与收尾码率不代表稳定编码，保留中间帧统计。
    const stable = packets.slice(Math.min(12, Math.floor(frameCount / 4)), -Math.max(1, Math.min(6, Math.floor(frameCount / 8))));
    const inter = stable.reduce((a, b) => a + b, 0) / stable.length;
    return (packets[0] / keyint + inter * (1 - 1 / keyint)) * 8 / pixels;
  });
}

/** 创建带缓存和时间上限的快速估算器，整个过程不写试压视频。 */
export function createQuickEstimator({ getFfmpeg, cacheDir, isCompressing = () => false }) {
  const cache = new Map();
  const pending = new Map();
  const active = new Set();
  const cacheFile = path.join(cacheDir, `size-estimates-${VERSION}.json`);
  const cacheTemp = `${cacheFile}.${process.pid}.tmp`;
  let queue = Promise.resolve();
  let saving = Promise.resolve();
  const ready = fs.readFile(cacheFile, 'utf8').then((raw) => {
    for (const [key, value] of JSON.parse(raw)) cache.set(key, value);
  }).catch(() => {});

  /** 文件有改动就重新估算；改 CRF、重新导入或重启服务均可复用未变的样本。 */
  async function cacheKey(info) {
    const st = await fs.stat(info.path);
    return `${VERSION}|${info.path}|${st.size}|${st.mtimeMs}`;
  }

  /** 串行写缓存，避免同时导入文件时相互覆盖。 */
  function saveCache() {
    saving = saving.then(async () => {
      while (cache.size > 128) cache.delete(cache.keys().next().value);
      await fs.mkdir(cacheDir, { recursive: true });
      // 先写临时文件再替换，重启时不会读到尚未写完的缓存。
      await fs.writeFile(cacheTemp, JSON.stringify([...cache]), 'utf8');
      await fs.rename(cacheTemp, cacheFile);
    }).catch(() => {});
    return saving;
  }

  /** 分散时间与空间取连续原尺寸区域，减少小块拼接边界的影响。 */
  function sample(info, fraction) {
    const width = Math.min(640, Math.floor(info.width / 2) * 2);
    const height = Math.min(360, Math.floor(info.height / 2) * 2);
    if (width < 32 || height < 32) return Promise.reject(new Error('画面过小，使用参数粗估'));
    const frameCount = Math.min(FRAME_COUNT, Math.floor((info.duration || 0) * (info.fps || 30)) - 1);
    if (frameCount < 10) return Promise.reject(new Error('视频过短，使用参数粗估'));
    const keyint = Math.max(24, Math.round(info.fps || 30));
    const filter = `[0:v:0]crop=${width}:${height}:(iw-${width})*${fraction}:(ih-${height})*${fraction},split=${ANCHORS.length}${ANCHORS.map((_, i) => `[p${i}]`).join('')}`;
    const time = Math.min((info.duration || 0) * fraction,
      Math.max(0, (info.duration || 0) - (frameCount + 1) / (info.fps || 30)));
    const args = ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-ss', time.toFixed(3),
      '-noautorotate', '-i', info.path, '-filter_complex_threads', '1', '-filter_complex', filter,
      ...ANCHORS.flatMap((_, i) => ['-map', `[p${i}]`]), '-an', '-sn', '-dn', '-c:v', 'libx265', '-preset', 'medium',
      ...ANCHORS.flatMap((crf, i) => [`-crf:v:${i}`, String(crf)]),
      '-pix_fmt', info.is10bit || info.isHDR ? 'yuv420p10le' : 'yuv420p',
      '-x265-params', `pools=1:frame-threads=1:keyint=${keyint}:min-keyint=${Math.max(12, Math.round(keyint / 2))}:log-level=error`,
      ...ANCHORS.flatMap((_, i) => [`-frames:v:${i}`, String(frameCount)]),
      '-fps_mode', 'passthrough', '-f', 'framecrc', 'pipe:1'];
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = execFile(getFfmpeg(), args, { windowsHide: true, timeout: TIMEOUT_MS,
          maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
          active.delete(child);
          if (error) return reject(error);
          try { resolve(parsePackets(stdout, width * height, keyint, frameCount)); }
          catch (e) { reject(e); }
        });
        active.add(child);
      } catch (e) { reject(e); }
    });
  }

  /** 多个时间窗并行分析五档 CRF，仍只试压局部画面，不生成完整视频。 */
  async function analyze(info) {
    const started = performance.now();
    if (!getFfmpeg() || isCompressing()) return fallbackModel('压缩时暂用参数粗估');
    const settled = await Promise.allSettled([0.15, 0.5, 0.85].map((fraction) => sample(info, fraction)));
    const samples = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!samples.length) return { ...fallbackModel('快速分析未完成，已使用参数粗估'), elapsedMs: Math.round(performance.now() - started) };
    const means = ANCHORS.map((_, i) => samples.reduce((sum, row) => sum + row[i], 0) / samples.length);
    const spread = samples.length > 1 ? Math.max(...means.map((mean, i) =>
      Math.sqrt(samples.reduce((sum, row) => sum + (row[i] - mean) ** 2, 0) / samples.length) / mean)) : 0.5;
    // 局部样本仍不能代表整幅画面，保留边界修正与场景差异的宽范围。
    const points = ANCHORS.map((crf, i) => ({ crf, bpp: means[i] * 0.96 }));
    // 极少量样本可能让相邻点轻微反转，维持选档时体积随 CRF 增大而不增。
    for (let i = 1; i < points.length; i++) points[i].bpp = Math.min(points[i].bpp, points[i - 1].bpp);
    return { kind: 'sample', points,
      uncertainty: clamp(0.3 + spread * 0.5 + (info.isHDR || info.is10bit ? 0.15 : 0), 0.3, 0.65),
      elapsedMs: Math.round(performance.now() - started), sampleWindows: samples.length,
      framesPerWindow: Math.min(FRAME_COUNT, Math.floor((info.duration || 0) * (info.fps || 30)) - 1), anchors: ANCHORS };
  }

  return {
    /** 合并重复请求，每个文件只分析一次；列表逐个更新，首个结果无需等待整批。 */
    async get(info) {
      await ready;
      const key = await cacheKey(info);
      if (cache.has(key)) return { ...cache.get(key), cached: true };
      if (pending.has(key)) return pending.get(key);
      const task = queue.then(async () => {
        const model = await analyze(info);
        if (model.kind === 'sample' && !isCompressing()) { cache.set(key, model); await saveCache(); }
        return model;
      });
      pending.set(key, task);
      queue = task.catch(() => {});
      try { return await task; } finally { pending.delete(key); }
    },
    /** 开始正式压缩时停止正在进行的小样分析，把算力交给用户任务。 */
    stop() {
      for (const child of active) child.kill();
    },
  };
}
