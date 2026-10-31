const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const DEFAULT_CRF = 25;

// 只提供选档方向，不把经验范围当成当前视频的实测画质。
const CRF_GUIDE = [
  { min: 16, max: 18, label: '接近视觉无损取向', short: '接近无损取向', tone: 'good', note: '优先保留细节，适合重要素材；体积可能很大。' },
  { min: 19, max: 23, label: '高画质', short: '高画质', tone: 'good', note: '画质优先，日常留存可以从这一范围尝试。' },
  { min: 24, max: 26, label: '画质与体积平衡', short: '均衡', tone: 'guide-neutral', note: '兼顾观看效果和空间，可结合大小预估选档。' },
  { min: 27, max: 28, label: '小体积优先', short: '小体积优先', tone: 'warn', note: '更省空间，建议留意文字、纹理和暗部细节。' },
  { min: 29, max: 30, label: '较强压缩', short: '较强压缩', tone: 'warn', note: '更容易看到细节损失，建议先对照片段。' },
];

/** 统一提供滑块说明和表格中的经验画质标签。 */
function qualityForCrf(crf) {
  return CRF_GUIDE.find((band) => crf >= band.min && crf <= band.max) || CRF_GUIDE[2];
}

const state = {
  items: [],
  jobId: null,
  timer: null,
  busy: false,
  importing: false,
  toolsReady: true,
  toolError: '',
  selectedPath: '',
};

/* ---------- 格式化 ---------- */

function fmtBytes(n) {
  if (!n) return '—';
  const mb = n / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(1) + ' MB';
}

function fmtDur(s) {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m} 分 ${sec} 秒` : `${sec.toFixed(1)} 秒`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 体积粗估：只读后端生成的表，避免两端各套一套公式 ---------- */

/** 返回当前正在查看的文件，移除文件后自动切换到下一个。 */
function selectedInfo() {
  return state.items.find((it) => it.path === state.selectedPath) || state.items[0] || null;
}

function estimate(info, crf) {
  return info && info.table ? info.table.find((row) => row.crf === crf) : null;
}

/** 把分析状态写成可读提示，等待期间仍可选择档位和开始压缩。 */
function estimateStatus(info) {
  if (info.estimateState === 'loading') return '快速分析中…';
  if (info.estimateState === 'pending') return '参考值 · 等待快速分析';
  const model = info.sizeModel;
  if (model && model.kind === 'sample') {
    const count = model.anchors?.length || 2;
    const warning = model.sampleWindows < 3 ? ' · 部分样本' : '';
    return `${count} 档局部实测粗估 · ${model.cached ? '已缓存' : (model.elapsedMs / 1000).toFixed(1) + ' 秒'}${warning}`;
  }
  return '参数粗估';
}

/* ---------- 渲染 ---------- */

function renderList() {
  const ul = $('#filelist');
  const scrollTop = ul.scrollTop;
  $('.files').classList.toggle('has-files', state.items.length > 0);
  $('#emptyState').hidden = state.items.length > 0;
  if (!state.items.length) { ul.innerHTML = ''; return; }

  ul.innerHTML = state.items.map((it, i) => {
    const meta = [
      it.width && it.height ? `${it.width}×${it.height}` : '',
      it.fps ? `${it.fps.toFixed(1)}fps` : '',
      it.duration ? fmtDur(it.duration) : '',
      it.bitrate ? `${(it.bitrate / 1000).toFixed(0)} Mbps` : '',
      it.isHDR ? 'HDR' : (it.prim ? it.prim.toUpperCase() : ''),
    ].filter(Boolean).join(' · ');

    const selected = selectedInfo()?.path === it.path;
    return `<li class="file-item${selected ? ' selected' : ''}" data-i="${i}">
      <button type="button" class="file-select" data-select="${i}" aria-pressed="${selected}" aria-label="查看 ${esc(it.name)} 的预估">
      <div class="f-main">
        <div class="f-title"><span class="f-name" title="${esc(it.path)}">${esc(it.name)}</span><span class="selection-tag"${selected ? '' : ' hidden'}>查看中</span></div>
        <div class="f-meta">${esc(meta)}</div>
      </div>
      <div class="f-right">
        <span class="f-size">${fmtBytes(it.size)}</span>
        <span class="f-old">${esc((it.date || '无拍摄时间').slice(0, 16))}</span>
      </div>
      <div class="estimate-line" data-estimate="${i}"></div>
      <div class="result-line ${it.resultTone || ''}" data-result="${i}">${esc(it.resultText || '')}</div>
      </button>
      <button type="button" class="f-remove" data-remove="${i}" title="移除" aria-label="移除 ${esc(it.name)}"${state.busy ? ' disabled' : ''}>&times;</button>
    </li>`;
  }).join('');
  ul.scrollTop = scrollTop;
}

/** 切换查看时只更新选中态，保留列表滚动位置和各文件的压缩进度。 */
function syncFileSelection() {
  $$('#filelist .file-item').forEach((row) => {
    const selected = state.items[Number(row.dataset.i)]?.path === state.selectedPath;
    row.classList.toggle('selected', selected);
    row.querySelector('.file-select').setAttribute('aria-pressed', String(selected));
    row.querySelector('.selection-tag').hidden = !selected;
  });
}

/** 切换文件时回显各自保存的设置与预估，不影响其他文件。 */
function selectFile(index, focus = false) {
  const item = state.items[index];
  if (!item) return;
  state.selectedPath = item.path;
  renderTable();
  updateMetrics();
  if (focus) {
    const button = document.querySelector(`[data-select="${index}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: 'nearest' });
  }
}

/** 仅滚动对照表内部，让当前档位在有限高度中始终能被找到。 */
function revealCrfRow() {
  requestAnimationFrame(() => {
    const wrap = $('.table-wrap');
    const row = $('#crfTable tr.active');
    if (!row) return;
    const bounds = wrap.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const top = bounds.top + $('#crfTable thead').getBoundingClientRect().height;
    if (rect.bottom > bounds.bottom) wrap.scrollTop += rect.bottom - bounds.bottom + 2;
    else if (rect.top < top) wrap.scrollTop -= top - rect.top + 2;
  });
}

function renderTable() {
  const info = selectedInfo();
  const crf = info ? info.crf : DEFAULT_CRF;
  const rows = info ? info.table || [] : [];
  state.selectedPath = info ? info.path : '';
  $('#tableNote').textContent = info ? estimateStatus(info) : '添加视频后显示各档大小';

  $('#crfTable').querySelector('tbody').innerHTML = rows.length ? rows.map((r) => `
    <tr data-crf="${r.crf}" class="${r.crf === crf ? 'active' : ''}">
      <td>${r.crf}</td>
      <td><span class="tag ${qualityForCrf(r.crf).tone}" title="经验参考，实际观感依素材而变">${qualityForCrf(r.crf).short}</span></td>
      <td>约 ${fmtBytes(r.bytes)}</td>
      <td>${fmtBytes(r.lowBytes)}–${fmtBytes(r.highBytes)}</td>
      <td class="${r.bigger ? 'over' : ''}">${(r.ratio * 100).toFixed(0)}%</td>
    </tr>`).join('') : '<tr><td colspan="5">选择文件后查看各档粗估大小。</td></tr>';
  syncFileSelection();
  revealCrfRow();
}

/** 只更新估算文字，后台结果返回时不覆盖正在显示的压缩进度。 */
function updateEstimateLines() {
  state.items.forEach((it, i) => {
    const line = document.querySelector(`[data-estimate="${i}"]`);
    const row = estimate(it, it.crf);
    if (line) line.textContent = row
      ? `CRF ${it.crf} · faststart ${it.faststart ? '开' : '关'} · 约 ${fmtBytes(row.bytes)}（原片 ${(row.ratio * 100).toFixed(0)}%） · ${estimateStatus(it)}`
      : '无法读取视频参数';
  });
}

/** 用汇总区分统一配置与混合配置，提交时始终按每个文件的设置处理。 */
function batchSettingsSummary() {
  if (!state.items.length) return '添加视频后开始压缩';
  const crfs = new Set(state.items.map((item) => item.crf));
  const enabled = state.items.filter((item) => item.faststart).length;
  const crf = crfs.size === 1 ? `CRF ${state.items[0].crf}` : 'CRF 分别设置';
  const faststart = enabled === 0 ? 'faststart 全关' : enabled === state.items.length
    ? 'faststart 全开' : `faststart ${enabled} 开 / ${state.items.length - enabled} 关`;
  return `${state.items.length} 个文件 · ${crf} · ${faststart}`;
}

/** 滑块、预设和档位表都只修改当前文件。 */
function setCurrentCrf(value) {
  const item = selectedInfo();
  if (!item || state.busy) return;
  item.crf = Number(value);
  updateMetrics();
}

/** 显式复制当前一项设置到现有列表，CRF 与 faststart 独立批量应用。 */
function applyCurrentToAll(setting) {
  const current = selectedInfo();
  if (!current || state.busy) return;
  for (const item of state.items) item[setting] = current[setting];
  updateMetrics();
}

function updateMetrics() {
  const info = selectedInfo();
  const crf = info ? info.crf : DEFAULT_CRF;
  const e = estimate(info, crf);
  const totalSize = state.items.reduce((sum, item) => sum + (item.size || 0), 0);
  $('#fileCount').textContent = state.items.length;
  $('#listSummary').textContent = state.items.length ? `共 ${state.items.length} 个 · ${fmtBytes(totalSize)}` : '尚未添加文件';
  $('#selectedFileName').textContent = info ? info.name : '选择一个视频';
  $('#selectedFileName').title = info ? info.path : '';
  $('#selectedPosition').textContent = info ? `${state.items.indexOf(info) + 1} / ${state.items.length}` : '—';
  $('#selectedFileMeta').textContent = info
    ? [fmtBytes(info.size), info.width && info.height ? `${info.width}×${info.height}` : '', fmtDur(info.duration)].filter(Boolean).join(' · ')
    : '点击左侧文件，即可查看对应预估。';
  $('#batchSummary').textContent = batchSettingsSummary();
  $('#start').textContent = state.busy ? '压缩中…' : state.items.length ? `开始压缩 ${state.items.length} 个文件` : '开始压缩';

  $('#crfValue').textContent = crf;
  const band = qualityForCrf(crf);
  $('#crfGuideLabel').textContent = `画质参考：${band.label}（${band.min}–${band.max}）`;
  $('#crf').value = crf;
  $('#faststart').checked = !!info && info.faststart;
  $$('#crf, #faststart, .chip').forEach((control) => { control.disabled = state.busy || !info; });
  $$('#applyCrfAll, #applyFaststartAll').forEach((control) => { control.disabled = state.busy || state.items.length < 2; });
  $('#mSize').textContent = e ? '约 ' + fmtBytes(e.bytes) : '—';
  $('#mRange').textContent = e ? `${fmtBytes(e.lowBytes)}–${fmtBytes(e.highBytes)}` : '';
  $('#mRatio').textContent = e ? (e.ratio * 100).toFixed(0) + '%' : '—';
  const recommended = info && info.table ? info.table.reduce((best, row) =>
    Math.abs(row.ratio - 0.55) < Math.abs(best.ratio - 0.55) ? row : best) : null;
  $('#mRecommended').textContent = recommended ? 'CRF ' + recommended.crf : '—';
  $('#mSize').classList.toggle('over', !!e && e.bigger);
  $('#mRatio').classList.toggle('over', !!e && e.bigger);
  $('#crfNote').hidden = !!e && !e.bigger;

  if (!e) {
    $('#crfNote').textContent = '添加视频后即可查看粗估大小。CRF 越低通常保留越多细节，体积也越大。';
  } else if (e.bigger) {
    $('#crfNote').textContent = '这一档可能比原片更大，可以尝试提高 CRF。体积以最终输出为准。';
  } else {
    $('#crfNote').textContent = '降低 CRF 通常保留更多细节；可结合粗估大小与参考范围选档。';
  }

  $$('#crfTable tr').forEach((tr) => tr.classList.toggle('active', Number(tr.dataset.crf) === crf));
  $$('.chip').forEach((c) => c.classList.toggle('active', Number(c.dataset.crf) === crf));
  $('#start').disabled = state.busy || state.importing || !state.toolsReady || !state.items.length;
  updateEstimateLines();
  revealCrfRow();
}

/* ---------- 数据加载 ---------- */

async function api(url, opts) {
  try {
    const r = await fetch(url, opts);
    return await r.json().catch(() => ({ ok: false, error: '服务返回异常，请重新启动工具。' }));
  } catch {
    return { ok: false, error: '无法连接本地服务，请双击工具目录中的「启动.bat」重新启动后刷新网页。' };
  }
}

/** 在页面内持续显示查找、读取进度及错误，避免批量导入像是没有响应。 */
function importStatus(message, error = false) {
  const el = $('#importStatus');
  el.hidden = !message;
  el.textContent = message;
  el.classList.toggle('error', error);
}

/** 串行执行一次导入操作，期间保留文件查看与参数调整。 */
async function runImport(action) {
  if (state.busy || state.importing) return;
  state.importing = true;
  $('#drop').setAttribute('aria-busy', 'true');
  $$('#pickFiles, #pickDir, #clearAll, #pathInput, #workdir, #start').forEach((el) => { el.disabled = true; });
  try {
    if (!state.toolsReady) throw new Error(state.toolError);
    await action();
  } catch (error) {
    importStatus(error.message || '导入失败，请重试。', true);
  } finally {
    state.importing = false;
    $('#drop').setAttribute('aria-busy', 'false');
    $$('#pickFiles, #pickDir, #clearAll, #pathInput, #workdir').forEach((el) => { el.disabled = state.busy; });
    $('#start').disabled = state.busy || !state.toolsReady || !state.items.length;
  }
}

async function scanPaths(paths) {
  const arr = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!arr.length) return;
  const added = [];
  const problems = [];
  // 每读完一个路径就更新列表；目录路径由后台展开。
  for (let index = 0; index < arr.length; index++) {
    importStatus(`正在读取 ${index + 1}/${arr.length}：${arr[index]}`);
    const j = await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [arr[index]] }),
    });
    if (!j.ok) throw new Error(j.error || '读取失败');

    for (const it of j.items) {
      if (state.items.some((x) => x.path === it.path)) continue;
      // 新添加的视频独立使用默认值，批量应用仅作用于操作时已有的文件。
      it.crf = DEFAULT_CRF;
      it.faststart = false;
      it.estimateState = 'pending';
      state.items.push(it);
      added.push(it);
    }
    if (j.problems && j.problems.length) {
      problems.push(...j.problems);
    }
    renderList();
    renderTable();
    updateMetrics();
  }
  importStatus(`已添加 ${added.length} 个视频${problems.length ? '\n' + problems.join('\n') : ''}`, problems.length > 0);
  scheduleEstimates(added);
}

let estimateQueue = Promise.resolve();

/** 导入后自动更新每个文件；滑块和表格直接复用结果，不发起重复试算。 */
function scheduleEstimates(items) {
  for (const item of items) {
    estimateQueue = estimateQueue.then(async () => {
      if (!state.items.includes(item) || state.busy) return;
      item.estimateState = 'loading';
      if (selectedInfo() === item) { renderTable(); updateMetrics(); }
      else updateEstimateLines();
      try {
        const result = await api('/api/estimate', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: item.path }) });
        if (state.items.includes(item)) {
          // 后台分析期间用户可能已调整参数，返回元数据不能覆盖本地设置。
          if (result.ok) {
            const { crf, faststart } = item;
            Object.assign(item, result.item, { crf, faststart });
          }
          item.estimateState = result.ok ? 'done' : 'fallback';
        }
      } catch {
        // 请求失败时已有参考值仍然可用，不阻塞选档和压缩。
        item.estimateState = 'fallback';
      }
      // 其他文件的分析结果不应打断当前查看，也不应重置列表或表格滚动。
      if (selectedInfo() === item) { renderTable(); updateMetrics(); }
      else updateEstimateLines();
    }).catch((error) => console.warn('快速估算未完成', error));
  }
}

/* ---------- 拖拽 ---------- */

async function handleDrop(files) {
  const names = [...files].map((f) => f.name).filter(Boolean);
  if (!names.length) return;

  const workdir = $('#workdir').value.trim();
  if (!workdir) {
    throw new Error('请先填写「拖拽查找目录」，或者直接把完整路径粘贴到上面的输入框。');
  }

  const j = await api('/api/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workdir, names }),
  });
  if (!j.ok) throw new Error(j.error || '查找失败');

  const hits = j.result.filter((r) => r.path).map((r) => r.path);
  const miss = j.result.filter((r) => !r.path).map((r) => r.name);

  if (hits.length) await scanPaths(hits);
  if (miss.length) {
    importStatus(`已找到 ${hits.length} 个。以下文件在「${workdir}」中未找到或存在重名，请缩小查找目录或粘贴完整路径：\n${miss.join('\n')}`, true);
  }
}

/* ---------- 压缩任务 ---------- */

function setBusy(b) {
  state.busy = b;
  $('#start').disabled = b || state.importing || !state.toolsReady || !state.items.length;
  $('#cancel').hidden = !b;
  $('#progressArea').hidden = !b;
  $$('.f-remove').forEach((el) => { el.disabled = b; });
  $$('#crf, #suffix, #faststart, #pathInput, #workdir, #pickFiles, #pickDir, #clearAll, .chip').forEach((el) => { el.disabled = b; });
  updateMetrics();
}

async function startCompress() {
  if (state.importing || !state.toolsReady) return;
  if (!state.items.length || state.busy) return;

  const items = state.items.filter((item) => item && item.path)
    .map((item) => ({ path: item.path, crf: item.crf, faststart: item.faststart }));
  const body = { items, suffix: $('#suffix').value.trim() || '_compressed' };
  // 提交前锁定本批参数，避免等待服务读取文件时又被修改。
  setBusy(true);
  try {
    const j = await api('/api/compress', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!j.ok) throw new Error(j.error || '启动失败');
    state.jobId = j.jobId;
  } catch (error) {
    setBusy(false);
    alert(error.message || '启动失败');
    return;
  }
  state.timer = setInterval(poll, 700);
  poll();
}

async function poll() {
  if (!state.jobId) return;
  const j = await api('/api/job/' + state.jobId);
  if (!j.ok) return;

  const running = j.items.filter((x) => x.status === 'running')[0];
  if (running) {
    $('#progressLabel').textContent = `${running.name}　${running.percent.toFixed(0)}%`;
    const eta = running.percent > 2
      ? fmtDur((j.elapsed / 1000) * (100 - running.percent) / running.percent)
      : '';
    $('#progressMeta').textContent = [
      running.speed ? running.speed : '',
      running.outBytes ? '已写 ' + fmtBytes(running.outBytes) : '',
      eta ? '剩余约 ' + eta : '',
    ].filter(Boolean).join('　');
    $('#barFill').style.width = running.percent + '%';
  } else {
    $('#barFill').style.width = '100%';
  }

  for (const it of j.items) {
    const idx = state.items.findIndex((x) => x.path === it.path);
    if (idx < 0) continue;
    const el = document.querySelector(`[data-result="${idx}"]`);
    if (!el) continue;

    if (it.status === 'done') {
      const saved = it.size ? Math.round((1 - it.outBytes / it.size) * 100) : 0;
      const d = it.dateResult;
      const dateTxt = d && d.ok ? `时间已写回 ${d.stamp}` : `时间未写回（${d ? d.error : '未知'}）`;
      const frames = it.frameCheck;
      const frameTxt = frames?.checked ? `帧数 ${frames.outputFrames}/${frames.sourceFrames}，时间轴已核对` : '未自动核对帧序列';
      el.className = 'result-line ' + (d && d.ok ? 'ok' : 'err');
      el.textContent = `${fmtBytes(it.size)} → ${fmtBytes(it.outBytes)}（省 ${saved}%）· ${dateTxt} · ${frameTxt}`;
    } else if (it.status === 'error') {
      el.className = 'result-line err';
      el.textContent = '失败：' + it.error;
    } else if (it.status === 'running') {
      el.className = 'result-line';
      el.textContent = `压缩中 ${it.percent.toFixed(0)}%`;
    }
    state.items[idx].resultText = el.textContent;
    state.items[idx].resultTone = el.classList.contains('ok') ? 'ok' : el.classList.contains('err') ? 'err' : '';
  }

  if (j.status !== 'running') {
    clearInterval(state.timer);
    state.timer = null;
    setBusy(false);
    const okCount = j.items.filter((x) => x.status === 'done').length;
    const failCount = j.items.filter((x) => x.status === 'error').length;
    $('#progressLabel').textContent = j.status === 'cancelled'
      ? '已取消'
      : `完成：成功 ${okCount} 个${failCount ? '，失败 ' + failCount + ' 个' : ''}`;
    $('#progressMeta').textContent = '原片未被修改';
    scheduleEstimates(state.items.filter((it) => it.estimateState === 'pending'));
  }
}

/* ---------- 初始化 ---------- */

async function init() {
  $('#workdir').value = localStorage.getItem('vc.workdir') || 'E:\\VideoEdit';
  $('#suffix').value = localStorage.getItem('vc.suffix') || '_compressed';
  $('#crfGuideBody').innerHTML = CRF_GUIDE.map((band) => `<tr>
    <td class="guide-range">${band.min}–${band.max}</td><td>${band.label}</td><td>${band.note}</td>
  </tr>`).join('');

  const cfg = await api('/api/config');
  if (cfg.ok) {
    const ff = cfg.ffmpeg ? `<b>ffmpeg</b> ${esc(cfg.ffmpegVersion)}` : '<span class="miss">ffmpeg 未找到</span>';
    const et = cfg.exiftool ? `<b>exiftool</b> ${esc(cfg.exiftoolVersion)}` : '<span class="miss">exiftool 未找到</span>';
    $('#engines').innerHTML = `${ff}<br>${et}`;
    state.toolsReady = !!(cfg.ffmpeg && cfg.exiftool);
    state.toolError = cfg.toolError || '找不到 ffmpeg 或 exiftool，请检查工具目录后双击「启动.bat」重新启动。';
    if (!state.toolsReady) {
      $('#start').disabled = true;
      importStatus(state.toolError, true);
    }
  } else {
    $('#engines').textContent = '引擎检测失败';
    state.toolsReady = false;
    state.toolError = cfg.error || '无法连接本地服务，请重新启动工具。';
    importStatus(state.toolError, true);
  }

  renderTable();
  updateMetrics();

  // 窗口或输出设置改变可视高度时，只调整表内滚动，保持当前档位可见。
  new ResizeObserver(revealCrfRow).observe($('.table-wrap'));

  /* 拖拽 */
  const dz = $('#drop');
  dz.addEventListener('click', () => $('#pickFiles').click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#pickFiles').click(); }
  });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('over');
  }));
  dz.addEventListener('drop', (e) => {
    const files = [...e.dataTransfer.files];
    runImport(async () => {
      importStatus(`正在查找 ${files.length} 个文件…`);
      await handleDrop(files);
    });
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  /* 路径输入 */
  $('#pathInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (!v) return;
    e.target.value = '';
    runImport(() => scanPaths(v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  });

  $('#workdir').addEventListener('change', (e) => localStorage.setItem('vc.workdir', e.target.value.trim()));
  $('#suffix').addEventListener('change', (e) => localStorage.setItem('vc.suffix', e.target.value.trim()));

  /* 原生选择框 */
  $('#pickFiles').addEventListener('click', async () => {
    runImport(async () => {
      importStatus('正在打开文件选择框…');
      const j = await api('/api/browse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"file"}' });
      if (j.ok && j.paths.length) await scanPaths(j.paths);
      else if (!j.ok) throw new Error(j.error);
      else importStatus('已取消选择');
    });
  });

  $('#pickDir').addEventListener('click', async () => {
    runImport(async () => {
      importStatus('正在打开文件夹选择框…');
      const j = await api('/api/browse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"dir"}' });
      if (j.ok && j.paths.length) await scanPaths(j.paths);
      else if (!j.ok) throw new Error(j.error);
      else importStatus('已取消选择');
    });
  });

  /* 文件卡片直接切换；移除按钮独立处理，避免顺带切换到别的文件。 */
  $('#filelist').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (!remove) {
      const button = e.target.closest('[data-select]');
      if (button) selectFile(Number(button.dataset.select));
      return;
    }
    if (state.busy) return;
    const index = Number(remove.dataset.remove);
    const wasSelected = selectedInfo() === state.items[index];
    state.items.splice(index, 1);
    if (wasSelected) state.selectedPath = state.items[Math.min(index, state.items.length - 1)]?.path || '';
    renderList();
    renderTable();
    updateMetrics();
  });

  /** 上下键切换查看，键盘操作与鼠标点击保持一致。 */
  $('#filelist').addEventListener('keydown', (e) => {
    const button = e.target.closest('[data-select]');
    if (!button || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const index = Number(button.dataset.select);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? state.items.length - 1
      : Math.max(0, Math.min(state.items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
    selectFile(next, true);
  });

  $('#clearAll').addEventListener('click', () => {
    if (state.busy) return;
    state.items = [];
    renderList();
    renderTable();
    updateMetrics();
  });

  /* CRF */
  const crfEl = $('#crf');
  crfEl.addEventListener('input', (e) => setCurrentCrf(e.target.value));

  $$('.chip').forEach((c) => c.addEventListener('click', () => setCurrentCrf(c.dataset.crf)));
  $('#faststart').addEventListener('change', (e) => {
    const current = selectedInfo();
    if (!current || state.busy) return;
    current.faststart = e.target.checked;
    updateMetrics();
  });
  $('#applyCrfAll').addEventListener('click', () => applyCurrentToAll('crf'));
  $('#applyFaststartAll').addEventListener('click', () => applyCurrentToAll('faststart'));

  /* 表格点击选档 */
  $('#crfTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.crf || state.busy) return;
    setCurrentCrf(tr.dataset.crf);
  });

  /* 开始 / 取消 */
  $('#start').addEventListener('click', startCompress);
  $('#cancel').addEventListener('click', async () => {
    if (!state.jobId) return;
    await api('/api/cancel/' + state.jobId, { method: 'POST' });
  });
}

init();
