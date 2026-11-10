/** 统一正式编码与试压的预设，避免两端参数和缓存混用。 */
export const DEFAULT_PRESET = 'fast';
/** 只开放本轮人工复审选定的两个 x265 预设。 */
export function normalizePreset(value) {
  if (value == null || value === '') return DEFAULT_PRESET;
  if (value !== 'fast' && value !== 'medium') throw new Error('编码预设仅支持 fast 或 medium');
  return value;
}
