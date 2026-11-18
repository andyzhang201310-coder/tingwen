/* 模型 ID 归一（无任何依赖，store.js 与 llm.js 共用）

   为什么单独放一个文件：store.js 读设置时要顺手把模型名修正，
   但它不能 import llm.js（llm.js 会动态 import store.js，成环）。
   这里只做纯字符串处理，谁都能引。
*/

/* 展示名 / 常见手误 → 接口 ID。
   只收敛明显能推断的写法，真正的兜底靠服务端返回的列表（见 llm.js 的 chat）。 */
const MODEL_ALIAS = {
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-flash-v4': 'deepseek-flash',
  'deepseek-flash-v4.1': 'deepseek-flash',
  'deepseek-v4.1': 'deepseek-flash',
  'deepseek-v4': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-pro': 'deepseek-v4-pro',
};

export function normalizeModel(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const k = raw.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  if (MODEL_ALIAS[k]) return MODEL_ALIAS[k];
  /* deepseek-v4.1-flash / deepseek-v4.1-0125-flash 之类带版本号的 flash 变体 */
  if (/^deepseek-v?\d+(\.\d+)?(-[\w.]+)?-flash$/.test(k)) return 'deepseek-flash';
  if (/^deepseek-v?\d+(\.\d+)?-pro$/.test(k)) return 'deepseek-v4-pro';
  return raw;
}
