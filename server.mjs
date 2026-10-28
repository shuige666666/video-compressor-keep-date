/**
 * 视频压缩器 —— 本地服务（零依赖，只用 Node 内置模块）
 *
 * 流程：ffmpeg(libx265) 重编码 → 从原片读取拍摄时间 → exiftool 写回输出文件
 * 原片全程只读，结果写到同目录的新文件，文件名后缀可配。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTable, createQuickEstimator } from './quick-estimate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4319);
const TMP_ROOT = path.join(os.tmpdir(), 'video-compressor');
const DEFAULT_TZ = '+08:00';

const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.3gp', '.mkv', '.avi', '.webm', '.wmv', '.flv', '.ts', '.mts'];

/* ------------------------------------------------------------------ *
 * 工具探测
 * ------------------------------------------------------------------ */

const FF_CANDIDATES = [
  process.env.FFMPEG_PATH,
  path.join(__dirname, 'ffmpeg', 'ffmpeg.exe'),
  'C:\\Users\\21051\\.workbuddy\\tools\\ffmpeg.exe',
  'ffmpeg',
].filter(Boolean);

const ET_CANDIDATES = [
  process.env.EXIFTOOL_PATH,
  path.join(__dirname, 'exiftool', 'exiftool.exe'),
  path.join(__dirname, '..', 'video-date-changer', 'exiftool', 'exiftool.exe'),
  'C:\\Users\\21051\\.workbuddy\\tools\\exiftool-13.59_64\\exiftool.exe',
  'exiftool',
].filter(Boolean);

let FF = null, FF_VER = '', ET = null, ET_VER = '';

function versionOf(exe) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.LC_ALL; delete env.LANG; delete env.LANGUAGE;
    execFile(exe, ['-version'], { windowsHide: true, timeout: 15000, encoding: 'utf8', env },
      (e, so) => (e ? reject(e) : resolve(so)));
  });
}

function etVersionOf(exe) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.LC_ALL; delete env.LANG; delete env.LANGUAGE;
    execFile(exe, ['-ver'], { windowsHide: true, timeout: 15000, encoding: 'utf8', env },
      (e, so) => (e ? reject(e) : resolve(so.trim())));
  });
}

async function detectTools() {
  for (const c of FF_CANDIDATES) {
    try {
      const out = await versionOf(c);
      FF = c;
      const first = (out.split('\n')[0] || '').replace('ffmpeg version ', '');
      FF_VER = first.split(' Copyright')[0].trim();
      break;
    } catch { /* next */ }
  }
  for (const c of ET_CANDIDATES) {
    try {
      ET_VER = await etVersionOf(c);
      ET = c;
      break;
    } catch { /* next */ }
  }
}

/* ------------------------------------------------------------------ *
 * exiftool：一律走 UTF-8 参数文件，避免中文路径变乱码
 * ------------------------------------------------------------------ */

let argSeq = 0;

function runExifTool(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.LC_ALL; delete env.LANG; delete env.LANGUAGE;
    execFile(ET, args, {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeout || 180000,
      encoding: 'utf8',
      env,
    }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error((stderr || err.message || '').trim()));
      resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
}

async function etRun(options, files, opts = {}) {
  await fsp.mkdir(TMP_ROOT, { recursive: true });
  const argfile = path.join(TMP_ROOT, `args_${process.pid}_${++argSeq}.txt`);
  await fsp.writeFile(argfile, [...options, ...files].join('\n') + '\n', 'utf8');
  try {
    return await runExifTool(['-charset', 'filename=UTF8', '-@', argfile], opts);
  } finally {
    fsp.unlink(argfile).catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * 探测单个视频：ffmpeg 拿编码参数，exiftool 拿拍摄时间
 * ------------------------------------------------------------------ */

const COLOR_PRIM = {
  'BT.709': 'bt709', 'BT.2020': 'bt2020', 'BT.601': 'bt470bg',
  'BT.470 System B, G (historical)': 'bt470bg', 'BT.470 System M': 'bt470m',
  'SMPTE 170M': 'smpte170m', 'SMPTE 240M': 'smpte240m',
  'P3D65': 'smpte432', 'Display P3': 'smpte432',
};
const COLOR_TRC = {
  'BT.709': 'bt709', 'BT.2020 (10-bit)': 'bt2020-10', 'BT.2020 (12-bit)': 'bt2020-12',
  'SMPTE ST 2084': 'smpte2084', 'ARIB STD-B67': 'arib-std-b67',
  'BT.601': 'smpte170m', 'SMPTE 170M': 'smpte170m', 'IEC 61966-2-1 sRGB': 'iec61966-2-1',
};
const COLOR_MATRIX = {
  'BT.709': 'bt709', 'BT.2020 non-constant': 'bt2020nc', 'BT.2020 constant': 'bt2020c',
  'BT.601': 'smpte170m', 'BT.470 System B, G (historical)': 'bt470bg',
  'SMPTE 170M': 'smpte170m',
};

function ffprobeInfo(file) {
  return new Promise((resolve) => {
    execFile(FF, ['-hide_banner', '-i', file], {
      windowsHide: true, timeout: 60000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }, (_e, _so, se) => resolve(se || ''));
  });
}

function parseFfmpegInfo(text) {
  const info = { video: null, audio: null, duration: 0, bitrate: 0 };

  const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (dm) info.duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);

  const bm = /Duration:.*?bitrate:\s*(\d+)\s*kb\/s/.exec(text);
  if (bm) info.bitrate = Number(bm[1]);

  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!/^Stream #/.test(s)) continue;
    if (s.includes('Video:') && !info.video) {
      const codec = (/Video:\s*([a-zA-Z0-9_]+)/.exec(s) || [])[1] || '';
      const pix = (/(yuv[a-z0-9]+|nv12|nv16|p010le|p016le|gbrp)\b/.exec(s) || [])[1] || '';
      const size = /(\d{2,5})x(\d{2,5})/.exec(s);
      const fps = /([\d.]+)\s*fps/.exec(s);
      const br = /(\d+)\s*kb\/s/.exec(s);
      const colorTag = new RegExp(pix + '\\(([^)]*)\\)').exec(s);
      let prim = '', trc = '', space = '';
      if (colorTag) {
        const parts = colorTag[1].split(',').map((x) => x.trim());
        // 形如 (tv, bt709) 或 (tv, bt709, progressive)
        for (const p of parts) {
          if (/^(bt|smpte|bt2020|arib|iec)/.test(p)) { if (!prim) prim = p; else if (!trc) trc = p; }
        }
      }
      info.video = {
        codec,
        pixFmt: pix,
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        fps: fps ? parseFloat(fps[1]) : 0,
        bitrate: br ? Number(br[1]) : 0,
        prim, trc, space,
      };
    } else if (s.includes('Audio:') && !info.audio) {
      const codec = (/Audio:\s*([a-zA-Z0-9_]+)/.exec(s) || [])[1] || '';
      const sr = /(\d+)\s*Hz/.exec(s);
      const br = /(\d+)\s*kb\/s/.exec(s);
      info.audio = {
        codec,
        sampleRate: sr ? Number(sr[1]) : 0,
        bitrate: br ? Number(br[1]) : 0,
      };
    }
  }
  return info;
}

async function readMeta(files) {
  if (!files.length) return new Map();
  const { stdout } = await etRun([
    '-json', '-G1', '-a', '-s', '-api', 'QuickTimeUTC=1',
    '-time:all', '-Duration', '-ImageSize', '-FileSize',
    '-ColorPrimaries', '-TransferCharacteristics', '-MatrixCoefficients',
    '-Rotation', '-AudioFormat', '-AudioBitrate',
  ], files);
  let arr = [];
  try { arr = JSON.parse(stdout); } catch { arr = []; }
  const map = new Map();
  for (const j of arr) {
    const src = path.resolve(j['SourceFile']);
    const keysDate = j['Keys:CreationDate'] || '';
    const qtDate = j['QuickTime:CreateDate'] || '';
    map.set(src, {
      keysDate, qtDate,
      date: keysDate || qtDate,
      prim: j['QuickTime:ColorPrimaries'] || j['Track1:ColorPrimaries'] || '',
      trc: j['QuickTime:TransferCharacteristics'] || j['Track1:TransferCharacteristics'] || '',
      matrix: j['QuickTime:MatrixCoefficients'] || j['Track1:MatrixCoefficients'] || '',
      rotation: Number(j['QuickTime:Rotation'] || j['Composite:Rotation'] || 0) || 0,
    });
  }
  return map;
}

const inspectionCache = new Map();

/** 完整探测：先快速返回参数与粗估，内容样本由独立请求补齐。 */
async function inspect(file) {
  const abs = path.resolve(file);
  const st = await fsp.stat(abs);
  const cached = inspectionCache.get(abs);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return { ...cached.info };
  const [raw, meta] = await Promise.all([
    ffprobeInfo(abs),
    readMeta([abs]),
  ]);
  const fi = parseFfmpegInfo(raw);
  const m = meta.get(abs) || {};
  const v = fi.video || { width: 0, height: 0, fps: 0, bitrate: 0 };
  const duration = fi.duration || 0;

  // 优先用 exiftool 的色彩标记（比 ffmpeg -i 输出可靠），映射成 ffmpeg 的参数名
  const prim = COLOR_PRIM[m.prim] || v.prim || 'bt709';
  const trc = COLOR_TRC[m.trc] || v.trc || 'bt709';
  const matrix = COLOR_MATRIX[m.matrix] || 'bt709';

  const is10bit = /10le|10be|p010|p016/.test(v.pixFmt || '');
  const isHDR = trc === 'smpte2084' || trc === 'arib-std-b67';

  const info = {
    path: abs,
    name: path.basename(abs),
    size: st.size,
    duration,
    width: v.width,
    height: v.height,
    fps: v.fps || 0,
    bitrate: v.bitrate || 0,
    vcodec: v.codec || '',
    pixFmt: v.pixFmt || '',
    audio: fi.audio,
    prim, trc, matrix,
    is10bit, isHDR,
    rotation: m.rotation || 0,
    date: (m.date || '').replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3 '),
    dateRaw: m.date || '',
    keysDate: m.keysDate || '',
    qtDate: m.qtDate || '',
  };
  info.table = buildTable(info);
  inspectionCache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, info });
  return info;
}

/* ------------------------------------------------------------------ *
 * 体积粗估在 quick-estimate.mjs 中统一计算；不再凭 CRF 推算 PSNR。
 * ------------------------------------------------------------------ */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 粗略估压缩耗时：x265 medium，4K 约 4fps，随像素数近似线性 */
function etaSeconds(info) {
  const frames = (info.fps || 30) * (info.duration || 0);
  const mp = ((info.width || 1920) * (info.height || 1080)) / 1e6;
  const fpsEst = clamp(4 * (8.3 / Math.max(mp, 0.5)), 0.5, 60);
  return Math.round(frames / fpsEst);
}

/* ------------------------------------------------------------------ *
 * 压缩
 * ------------------------------------------------------------------ */

const jobs = new Map();
let jobSeq = 0;
const quickEstimator = createQuickEstimator({
  getFfmpeg: () => FF,
  cacheDir: TMP_ROOT,
  isCompressing: () => [...jobs.values()].some((job) => job.status === 'running'),
});

const p2 = (n) => String(n).padStart(2, '0');
const fmtET = (d) => `${d.getFullYear()}:${p2(d.getMonth() + 1)}:${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(-120);
}

function outputPathFor(src, suffix) {
  const dir = path.dirname(src);
  const ext = path.extname(src) || '.mp4';
  const base = path.basename(src, ext);
  let out = path.join(dir, `${base}${suffix}${ext}`);
  // 输出统一成 mp4（x265 in mp4 兼容性最好）
  if (!/\.mp4$/i.test(out)) out = out.replace(/\.[^.]+$/, '.mp4');
  return out;
}

function buildFfmpegArgs(info, src, dst, crf, faststart) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  args.push('-i', src);
  args.push('-map', '0:v:0');
  if (info.audio) args.push('-map', '0:a:0');

  args.push('-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf));

  if (info.is10bit || info.isHDR) {
    args.push('-pix_fmt', 'yuv420p10le', '-profile:v', 'main10');
  } else {
    args.push('-pix_fmt', 'yuv420p', '-profile:v', 'main');
  }

  // 色彩标记一律从原片继承——这一步就是手机相册没做对的地方
  args.push('-color_primaries', info.prim, '-color_trc', info.trc, '-colorspace', info.matrix);

  const fps = info.fps || 30;
  const keyint = Math.max(24, Math.round(fps)); // 1 秒一个关键帧，和实测基准一致
  args.push('-x265-params', [
    `keyint=${keyint}`,
    `min-keyint=${Math.max(12, Math.round(fps / 2))}`,
    'log-level=error',
    `colorprim=${info.prim}`,
    `transfer=${info.trc}`,
    `colormatrix=${info.matrix}`,
  ].join(':'));

  args.push('-tag:v', 'hvc1');

  // 音频能 copy 就 copy，copy 不了（比如 opus 进 mp4）退回落成 aac
  if (info.audio) {
    const ok = ['aac', 'mp3', 'alac', 'ac3', 'eac3'].includes((info.audio.codec || '').toLowerCase());
    if (ok) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k');
  }

  if (faststart) args.push('-movflags', '+faststart');
  args.push(dst);
  return args;
}

/** 把原片的拍摄时间写回输出文件 */
async function restoreDate(srcMeta, dst) {
  const raw = srcMeta.dateRaw || '';
  if (!raw) return { ok: false, error: '原片没有拍摄时间，跳过' };

  // 保留原片自带的时区后缀，没有就用默认
  let tz = DEFAULT_TZ;
  const tm = /([+-]\d{2}:\d{2})\s*$/.exec(raw);
  if (tm) tz = tm[1];

  // "2026:10:02 11:46:03+08:00" → "2026:10:02 11:46:03"
  const stamp = raw.replace(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2}).*$/, '$1:$2:$3 $4');
  if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp)) {
    return { ok: false, error: '拍摄时间格式无法解析：' + raw };
  }

  await etRun([
    '-m', '-overwrite_original', '-api', 'QuickTimeUTC=1',
    `-QuickTime:CreateDate=${stamp}`,
    `-QuickTime:ModifyDate=${stamp}`,
    `-QuickTime:TrackCreateDate=${stamp}`,
    `-QuickTime:TrackModifyDate=${stamp}`,
    `-QuickTime:MediaCreateDate=${stamp}`,
    `-QuickTime:MediaModifyDate=${stamp}`,
    `-Keys:CreationDate=${stamp}${tz}`,
    `-FileCreateDate=${stamp}${tz}`,
    `-FileModifyDate=${stamp}${tz}`,
  ], [dst]);

  return { ok: true, stamp: stamp + tz };
}

function runCompress(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const step = () => {
    if (job.cancelled) return finishJob(job, 'cancelled');
    if (job.index >= job.items.length) return finishJob(job, 'done');

    const item = job.items[job.index];
    if (item.skip) {
      job.index++;
      return setImmediate(step);
    }

    job.current = item;
    item.status = 'running';
    item.percent = 0;
    item.startedAt = Date.now();

    const dst = item.outPath;
    const args = buildFfmpegArgs(item.info, item.path, dst, item.crf, item.faststart);

    const cp = spawn(FF, args, { windowsHide: true });
    job.proc = cp;
    item.proc = cp;

    let stderr = '';
    let buf = '';

    cp.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k === 'out_time_us') {
          const us = Number(v) || 0;
          const total = (item.info.duration || 1) * 1e6;
          item.percent = clamp((us / total) * 100, 0, 99.9);
        } else if (k === 'total_size') {
          item.outBytes = Number(v) || 0;
        } else if (k === 'speed') {
          item.speed = v;
        } else if (k === 'progress' && v === 'end') {
          item.percent = 100;
        }
      }
    });

    cp.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    cp.on('error', (e) => {
      item.status = 'error';
      item.error = 'ffmpeg 启动失败：' + e.message;
      job.index++;
      setImmediate(step);
    });

    cp.on('close', async (code) => {
      job.proc = null;
      item.proc = null;
      if (job.cancelled) return finishJob(job, 'cancelled');

      if (code !== 0) {
        item.status = 'error';
        item.error = (stderr.split('\n').filter(Boolean).slice(-3).join(' ') || 'ffmpeg 退出码 ' + code).slice(0, 300);
        try { await fsp.unlink(dst); } catch { /* ignore */ }
        job.index++;
        return setImmediate(step);
      }

      try {
        const st = await fsp.stat(dst);
        item.outBytes = st.size;
        item.percent = 100;
      } catch { /* ignore */ }

      // 关键一步：把拍摄时间写回输出文件
      try {
        const r = await restoreDate(item.info, dst);
        item.dateResult = r;
      } catch (e) {
        item.dateResult = { ok: false, error: e.message };
      }

      item.status = 'done';
      job.index++;
      setImmediate(step);
    });
  };

  step();
}

function finishJob(job, status) {
  job.status = status;
  job.endedAt = Date.now();
  job.proc = null;
}

/* ------------------------------------------------------------------ *
 * 路径处理
 * ------------------------------------------------------------------ */

const isVideo = (p) => VIDEO_EXT.includes(path.extname(p).toLowerCase());

async function expandPaths(inputs) {
  const out = [];
  const problems = [];
  for (const raw of inputs) {
    const p = String(raw).trim().replace(/^"|"$/g, '');
    if (!p) continue;
    const abs = path.resolve(p);
    let st = null;
    try { st = await fsp.stat(abs); } catch { st = null; }
    if (!st) { problems.push(`路径不存在：${p}`); continue; }
    if (st.isDirectory()) {
      const ents = await fsp.readdir(abs, { withFileTypes: true });
      const vids = ents.filter((e) => e.isFile() && isVideo(e.name)).map((e) => path.join(abs, e.name));
      if (!vids.length) problems.push(`文件夹里没有视频：${p}`);
      out.push(...vids);
    } else if (st.isFile()) {
      if (!isVideo(abs)) { problems.push(`不是视频文件：${p}`); continue; }
      out.push(abs);
    }
  }
  return { files: [...new Set(out)], problems };
}

async function locateByName(workdir, name, depth = 3) {
  const found = [];
  const target = name.toLowerCase();
  async function walk(dir, d) {
    if (d > depth || found.length >= 2) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (found.length >= 2) return;
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === target) found.push(full);
      else if (e.isDirectory() && !e.name.startsWith('.') && d < depth) await walk(full, d + 1);
    }
  }
  await walk(workdir, 0);
  return found;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function json(res, code, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function nativePick(mode) {
  const ps = mode === 'dir'
    ? `Add-Type -AssemblyName System.Windows.Forms;[Console]::OutputEncoding=[Text.Encoding]::UTF8;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='选择视频所在文件夹';if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}`
    : `Add-Type -AssemblyName System.Windows.Forms;[Console]::OutputEncoding=[Text.Encoding]::UTF8;$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Multiselect=$true;$d.Filter='视频|*.mp4;*.mov;*.m4v;*.3gp;*.mkv;*.avi|所有文件|*.*';if($d.ShowDialog() -eq 'OK'){Write-Output ($d.FileNames -join [Environment]::NewLine)}`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps],
      { windowsHide: true, timeout: 180000, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(new Error('选择框被关闭或无法打开（可以直接粘贴路径）'));
        resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
  });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    crf: job.crf,
    index: job.index,
    total: job.items.length,
    elapsed: (job.endedAt || Date.now()) - job.startedAt,
    items: job.items.map((it) => ({
      name: it.name,
      path: it.path,
      crf: it.crf,
      faststart: it.faststart,
      outPath: it.outPath,
      size: it.size,
      outBytes: it.outBytes || 0,
      percent: it.percent || 0,
      speed: it.speed || '',
      status: it.status,
      error: it.error || '',
      dateResult: it.dateResult || null,
      oldDate: it.info ? it.info.date : '',
    })),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(req, res, url.pathname);
    }

    if (url.pathname === '/api/config') {
      return json(res, 200, {
        ok: true, port: PORT,
        ffmpeg: FF, ffmpegVersion: FF_VER,
        exiftool: ET, exiftoolVersion: ET_VER,
        perFileSettings: true,
        runningJobs: [...jobs.values()].filter((job) => job.status === 'running').length,
      });
    }

    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const inputs = Array.isArray(body.paths) ? body.paths : [body.paths];
      const { files, problems } = await expandPaths(inputs);
      const items = [];
      for (const f of files) {
        try {
          const info = await inspect(f);
          info.eta = etaSeconds(info);
          items.push(info);
        } catch (e) {
          problems.push(`${path.basename(f)} 读取失败：${e.message}`);
        }
      }
      return json(res, 200, { ok: true, items, problems });
    }

    if (url.pathname === '/api/resolve' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const dir = body.workdir || '';
      const names = Array.isArray(body.names) ? body.names : [];
      const result = [];
      for (const name of names) {
        let hit = [];
        if (dir) { try { hit = await locateByName(dir, name); } catch { hit = []; } }
        result.push({ name, path: hit.length === 1 ? hit[0] : null, ambiguous: hit.length > 1 });
      }
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === '/api/estimate' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (typeof body.path !== 'string' || !isVideo(body.path)) return json(res, 400, { ok: false, error: '请选择视频文件' });
      const info = await inspect(body.path);
      info.sizeModel = await quickEstimator.get(info);
      info.table = buildTable(info);
      return json(res, 200, { ok: true, item: info });
    }

    if (url.pathname === '/api/compress' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      // 新界面逐文件提交，旧界面仍可用 paths 与统一参数发起任务。
      const entries = Array.isArray(body.items) ? body.items
        : (Array.isArray(body.paths) ? body.paths : []).map((p) => ({ path: p, crf: body.crf, faststart: body.faststart }));
      const suffix = String(body.suffix || '_compressed').replace(/[\\/:*?"<>|]/g, '_') || '_compressed';
      if (!entries.length) return json(res, 400, { ok: false, error: '没有选中文件' });
      if (entries.some((entry) => !entry || typeof entry.path !== 'string' || !entry.path.trim())) {
        return json(res, 400, { ok: false, error: '视频路径不能为空' });
      }

      const items = [];
      for (const entry of entries) {
        const p = path.resolve(entry.path);
        const crf = clamp(Number(entry.crf) || 25, 16, 30);
        // 仅显式开启时启用 faststart；未指定的每个视频默认关闭。
        const faststart = entry.faststart === true;
        try {
          const info = await inspect(p);
          items.push({ path: p, crf, faststart, name: info.name, size: info.size, info, outPath: outputPathFor(p, suffix), status: 'pending', outBytes: 0, percent: 0 });
        } catch (e) {
          // 单个原片被移动或删除时跳过该项，让同批其他视频继续处理。
          items.push({ path: p, crf, faststart, skip: true, name: path.basename(p), size: 0, info: null, outPath: '', status: 'error', error: '读取失败：' + e.message, outBytes: 0, percent: 0 });
        }
      }

      const id = 'j' + (++jobSeq);
      const crf = items.every((item) => item.crf === items[0].crf) ? items[0].crf : null;
      const job = { id, crf, suffix, items, index: 0, status: 'running', startedAt: Date.now(), proc: null, cancelled: false };
      jobs.set(id, job);
      quickEstimator.stop();
      runCompress(id);
      return json(res, 200, { ok: true, jobId: id, total: items.length });
    }

    if (url.pathname.startsWith('/api/job/') && req.method === 'GET') {
      const id = url.pathname.split('/').pop();
      const job = jobs.get(id);
      if (!job) return json(res, 404, { ok: false, error: '任务不存在' });
      return json(res, 200, { ok: true, ...publicJob(job) });
    }

    if (url.pathname.startsWith('/api/cancel/') && req.method === 'POST') {
      const id = url.pathname.split('/').pop();
      const job = jobs.get(id);
      if (!job) return json(res, 404, { ok: false, error: '任务不存在' });
      job.cancelled = true;
      if (job.proc) { try { job.proc.kill(); } catch { /* ignore */ } }
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/browse' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      try {
        const paths = await nativePick(body.mode === 'dir' ? 'dir' : 'file');
        return json(res, 200, { ok: true, paths });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message, paths: [] });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

detectTools().then(() => {
  const missing = [];
  if (!FF) missing.push('ffmpeg');
  if (!ET) missing.push('exiftool');

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`\n  端口 ${PORT} 已经有一个在跑了，直接打开 http://localhost:${PORT} 就行。\n`);
      process.exit(0);
    }
    throw e;
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  视频压缩器已启动');
    console.log(`  地址：http://localhost:${PORT}`);
    console.log(`  ffmpeg：${FF || '未找到'}  ${FF_VER}`);
    console.log(`  exiftool：${ET || '未找到'}  ${ET_VER}`);
    if (missing.length) console.log(`  缺少：${missing.join('、')}，压缩功能不可用`);
    console.log('  关掉这个窗口即退出');
    console.log('');
  });
}).catch((e) => {
  console.error('启动失败：' + e.message);
  process.exit(1);
});
