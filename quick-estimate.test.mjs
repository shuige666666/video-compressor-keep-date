/** 检查单点模型的选档、帧数与参考范围契约，不依赖外部视频或FFmpeg。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTable, estimateOne } from './quick-estimate.mjs';

const info = {
  width: 1920, height: 1080, fps: 30, duration: 60, size: 32 * 1024 * 1024,
  audio: { codec: 'aac', bitrate: 192 },
  sizeModel: { kind: 'sample', points: [{ crf: 24, bpp: 0.1 }], slope: 0.13,
    totalFrames: 1800, uncertainty: 0.5, upperUncertainty: 1 },
};

test('单个实测点生成全部选档，允许低CRF估算大于原片', () => {
  const rows = buildTable(info);
  assert.equal(rows.length, 15);
  assert.equal(rows[0].crf, 16);
  assert.equal(rows.at(-1).crf, 30);
  assert.ok(rows.every(row => Number.isFinite(row.bytes) && row.bytes > 0));
  assert.ok(rows.every((row, i) => !i || row.bytes <= rows[i - 1].bytes));
  assert.equal(rows.find(row => row.crf === 24).bigger, true);
  assert.equal(rows.find(row => row.crf === 30).bigger, false);
});

test('读取到真实帧数后，不因元数据帧率不同重复改变预估大小', () => {
  const reference = buildTable(info);
  assert.deepEqual(buildTable({ ...info, fps: 60 }), reference);
  const withoutCount = { ...info, sizeModel: { ...info.sizeModel, totalFrames: undefined } };
  assert.ok(estimateOne({ ...withoutCount, fps: 60 }, 24).bytes > estimateOne(withoutCount, 24).bytes);
});

test('单窗参考上界覆盖接近两倍的已知低估量级，远档范围继续放宽', () => {
  const near = estimateOne(info, 24);
  const far = estimateOne(info, 18);
  assert.ok(near.highBytes >= near.bytes * 1.85);
  assert.ok(near.lowBytes < near.bytes * 0.6);
  assert.ok(far.highBytes / far.bytes > near.highBytes / near.bytes);
  assert.ok(far.lowBytes / far.bytes < near.lowBytes / near.bytes);
});

test('内容试压未完成时仍能提供有限的参数参考值', () => {
  const rows = buildTable({ ...info, sizeModel: undefined });
  assert.ok(rows.every(row => Number.isFinite(row.bytes) && row.lowBytes < row.bytes && row.highBytes > row.bytes));
});
