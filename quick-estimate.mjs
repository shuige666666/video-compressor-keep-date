/** 用32帧完整画面实测CRF24，其他档位按经验曲线粗估；正式压缩参数不变。 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readVideoTimeline } from './video-timeline.mjs';

const VERSION = 'full-frame-crf24-v3';
const ANCHOR_CRF = 24;
const SLOPE = 0.13;
const FRAME_COUNT = 32;
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
  const frames = Math.max(1, model.totalFrames || (info.fps || 30) * (info.duration || 1));
  const pixels = Math.max(1, (info.width || 1920) * (info.height || 1080));
  const audio = audioBytes(info);
  const points = model.points;
  let bpp;
  if (points?.length) {
    // 只有24档为实测点，其他档位均沿用固定经验斜率，不把推算标成多档实测。
    bpp = points[0].bpp * Math.exp(-(model.slope || SLOPE) * (crf - points[0].crf));
  } else {
    bpp = model.bpp22 * Math.exp(-model.slope * (crf - 22));
  }
  const video = bpp * pixels * frames / 8;
  // 编码包之外预留少量封装空间，避免短片的音频/MP4 开销被忽略。
  const overhead = Math.max(4096, (video + audio) * 0.003);
  const bytes = Math.round(video + audio + overhead);
  const outside = model.kind === 'sample' ? Math.abs(crf - ANCHOR_CRF) : 0;
  const uncertainty = clamp(model.uncertainty + outside * 0.025, 0.3, 0.75);
  // 单窗口曾出现实际大小接近预估两倍的情况，上界独立放宽，避免范围给出虚假的把握。
  const upperUncertainty = model.kind === 'sample'
    ? clamp((model.upperUncertainty ?? model.uncertainty) + outside * 0.025, 0.3, 1.5) : uncertainty;
  return { crf, bytes, lowBytes: Math.round(video * (1 - uncertainty) + audio + overhead),
    highBytes: Math.round(video * (1 + upperUncertainty) + audio + overhead),
    ratio: info.size ? bytes / info.size : 0, bigger: !!info.size && bytes > info.size };
}

/** 一次生成所有档位，拖动 CRF 时直接读表，不再重复分析。 */
export function buildTable(info) {
  return Array.from({ length: 15 }, (_, i) => estimateOne(info, i + 16));
}

/** 解析内存中的编码包统计，把片段首帧按正式 GOP 摊销。 */
function parsePackets(text, pixels, keyint, frameCount) {
  const packets = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.split(',');
    const bytes = Number(fields[4]);
    if (Number(fields[0]) === 0 && Number.isFinite(bytes) && bytes > 0) packets.push(bytes);
  }
  if (packets.length !== frameCount) throw new Error('有效样本不足');
  // 沿用对比试验的统计口径，不在切换采样策略时同时引入未经验证的新修正。
  const stable = packets.slice(Math.min(12, Math.floor(frameCount / 4)), -Math.max(1, Math.min(6, Math.floor(frameCount / 8))));
  const inter = stable.reduce((a, b) => a + b, 0) / stable.length;
  return (packets[0] / keyint + inter * (1 - 1 / keyint)) * 8 / pixels;
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

  /** 在中间位置试压完整画面，保持与正式编码相同的旋转处理及像素精度。 */
  function sample(info, totalFrames) {
    const width = info.width;
    const height = info.height;
    if (width < 32 || height < 32) return Promise.reject(new Error('画面过小，使用参数粗估'));
    const frameCount = Math.min(FRAME_COUNT, totalFrames - 1);
    if (frameCount < 10) return Promise.reject(new Error('视频过短，使用参数粗估'));
    const keyint = Math.max(24, Math.round(info.fps || 30));
    const time = Math.min((info.duration || 0) * 0.5,
      Math.max(0, (info.duration || 0) - (frameCount + 1) / (info.fps || 30)));
    const args = ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-ss', time.toFixed(3),
      '-i', info.path, '-filter_threads', '1', '-map', '0:v:0',
      '-an', '-sn', '-dn', '-c:v', 'libx265', '-preset', 'medium', '-crf', String(ANCHOR_CRF),
      '-pix_fmt', info.is10bit || info.isHDR ? 'yuv420p10le' : 'yuv420p',
      '-x265-params', [`keyint=${keyint}`, `min-keyint=${Math.max(12, Math.round((info.fps || 30) / 2))}`,
        'log-level=error', 'info=0', info.prim && `colorprim=${info.prim}`,
        info.trc && `transfer=${info.trc}`, info.matrix && `colormatrix=${info.matrix}`].filter(Boolean).join(':'),
      '-frames:v', String(frameCount), '-fps_mode', 'passthrough', '-enc_time_base', '-1', '-f', 'framecrc', 'pipe:1'];
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = execFile(getFfmpeg(), args, { windowsHide: true, timeout: TIMEOUT_MS,
          maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
          active.delete(child);
          if (error) return reject(error);
          try { resolve({ bpp: parsePackets(stdout, width * height, keyint, frameCount), frameCount }); }
          catch (e) { reject(e); }
        });
        active.add(child);
      } catch (e) { reject(e); }
    });
  }

  /** 只实测24档的一个短窗口，MP4/MOV优先读取真实帧数，其他容器沿用元数据。 */
  async function analyze(info) {
    const started = performance.now();
    if (!getFfmpeg() || isCompressing()) return fallbackModel('压缩时暂用参数粗估');
    const timeline = await readVideoTimeline(info.path).catch(() => null);
    const totalFrames = timeline?.count || Math.floor((info.duration || 0) * (info.fps || 30));
    if (isCompressing()) return fallbackModel('压缩时暂用参数粗估');
    try {
      const result = await sample(info, totalFrames);
      return { kind: 'sample', points: [{ crf: ANCHOR_CRF, bpp: result.bpp }], slope: SLOPE,
        totalFrames, fullFrame: true, uncertainty: info.isHDR || info.is10bit ? 0.65 : 0.5,
        upperUncertainty: info.isHDR || info.is10bit ? 1.15 : 1,
        elapsedMs: Math.round(performance.now() - started), sampleWindows: 1,
        framesPerWindow: result.frameCount, anchors: [ANCHOR_CRF] };
    } catch {
      // 超时、样本不足或被正式压缩中止时保留参数参考，不缓存失败样本。
      return { ...fallbackModel('快速分析未完成，已使用参数粗估'), elapsedMs: Math.round(performance.now() - started) };
    }
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
