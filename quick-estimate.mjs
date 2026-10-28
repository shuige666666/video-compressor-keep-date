/** 用少量原尺寸局部画面提供数秒级体积粗估，正式压缩仍沿用原参数。 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const VERSION = 'local-patches-v1';
const ANCHORS = [22, 28];
const FRAME_COUNT = 18;
const TIMEOUT_MS = 4500;
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
  const video = model.bpp22 * Math.exp(-model.slope * (crf - 22)) * pixels * frames / 8;
  // 编码包之外预留少量封装空间，避免短片的音频/MP4 开销被忽略。
  const overhead = Math.max(4096, (video + audio) * 0.003);
  const bytes = Math.round(video + audio + overhead);
  const outside = Math.max(0, ANCHORS[0] - crf, crf - ANCHORS[1]);
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
function parsePackets(text, pixels, keyint) {
  const streams = [[], []];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.split(',');
    const stream = Number(fields[0]);
    const bytes = Number(fields[4]);
    if (streams[stream] && Number.isFinite(bytes) && bytes > 0) streams[stream].push(bytes);
  }
  return streams.map((packets) => {
    if (packets.length < 10) throw new Error('有效样本不足');
    const inter = packets.slice(1).reduce((a, b) => a + b, 0) / (packets.length - 1);
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

  /** 直接跳到短时间窗，保留三个位置的原始像素，不做整帧 4K 试压。 */
  function sample(info, fraction) {
    const width = Math.min(320, Math.floor(info.width / 2) * 2);
    const height = Math.min(180, Math.floor(info.height / 2) * 2);
    if (width < 32 || height < 32) return Promise.reject(new Error('画面过小，使用参数粗估'));
    const keyint = Math.max(24, Math.round(info.fps || 30));
    const filter = `[0:v:0]split=3[a][b][c];`
      + `[a]crop=${width}:${height}:(iw-${width})*0.2:(ih-${height})*0.25[a0];`
      + `[b]crop=${width}:${height}:(iw-${width})*0.5:(ih-${height})*0.5[b0];`
      + `[c]crop=${width}:${height}:(iw-${width})*0.8:(ih-${height})*0.75[c0];`
      + '[a0][b0][c0]hstack=3,split=2[p0][p1]';
    const time = Math.min((info.duration || 0) * fraction, Math.max(0, (info.duration || 0) - 0.65));
    const args = ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-ss', time.toFixed(3),
      '-noautorotate', '-i', info.path, '-filter_complex_threads', '1', '-filter_complex', filter,
      '-map', '[p0]', '-map', '[p1]', '-an', '-sn', '-dn', '-c:v', 'libx265', '-preset', 'medium',
      '-crf:v:0', String(ANCHORS[0]), '-crf:v:1', String(ANCHORS[1]),
      '-pix_fmt', info.is10bit || info.isHDR ? 'yuv420p10le' : 'yuv420p',
      '-x265-params', `pools=1:frame-threads=1:keyint=${keyint}:min-keyint=${Math.max(12, Math.round(keyint / 2))}:log-level=error`,
      '-frames:v:0', String(FRAME_COUNT), '-frames:v:1', String(FRAME_COUNT),
      '-fps_mode', 'passthrough', '-f', 'framecrc', 'pipe:1'];
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = execFile(getFfmpeg(), args, { windowsHide: true, timeout: TIMEOUT_MS,
          maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
          active.delete(child);
          if (error) return reject(error);
          try { resolve(parsePackets(stdout, width * height * 3, keyint)); }
          catch (e) { reject(e); }
        });
        active.add(child);
      } catch (e) { reject(e); }
    });
  }

  /** 两个时间窗并行分析；超时或失败就保留粗估，避免用户等待完整编码。 */
  async function analyze(info) {
    const started = performance.now();
    if (!getFfmpeg() || isCompressing()) return fallbackModel('压缩时暂用参数粗估');
    const settled = await Promise.allSettled([sample(info, 0.25), sample(info, 0.7)]);
    const samples = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!samples.length) return { ...fallbackModel('快速分析未完成，已使用参数粗估'), elapsedMs: Math.round(performance.now() - started) };
    const means = ANCHORS.map((_, i) => samples.reduce((sum, row) => sum + row[i], 0) / samples.length);
    const slope = clamp(Math.log(means[0] / means[1]) / 6, 0.06, 0.25);
    const spread = samples.length > 1 ? Math.abs(samples[0][0] - samples[1][0]) / means[0] : 0.5;
    // 局部边界比整帧多，统一保守修正；不同场景的残余误差体现在范围里。
    return { kind: 'sample', bpp22: means[0] * 0.96, slope,
      uncertainty: clamp(0.3 + spread * 0.5 + (info.isHDR || info.is10bit ? 0.15 : 0), 0.3, 0.65),
      elapsedMs: Math.round(performance.now() - started), sampleWindows: samples.length,
      framesPerWindow: FRAME_COUNT, anchors: ANCHORS };
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
