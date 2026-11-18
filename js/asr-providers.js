/**
 * 云端识别服务商预设。
 *
 * 两家内置服务 + 自定义，各自独立保存 url / key / model，可随时切换：
 * - siliconflow：OpenAI 兼容的 /audio/transcriptions（multipart 上传 WAV）
 * - bailian：阿里百炼 Qwen-ASR，走 /chat/completions（base64 Data URL 放进 input_audio）
 * - custom：自建或任何 OpenAI 兼容的 multipart 接口
 *
 * 旧版只有 asrCloudUrl / asrCloudKey / asrCloudModel 三个字段，
 * normalizeAsrSettings() 会把它们按 URL 归类到对应服务商，不丢已有配置。
 */

export const ASR_PROVIDERS = [
  {
    id: 'siliconflow',
    labelKey: 'set.asrProvSiliconflow',
    hintKey: 'set.asrProvSiliconflowHint',
    url: 'https://api.siliconflow.cn/v1/audio/transcriptions',
    model: 'FunAudioLLM/SenseVoiceSmall',
    protocol: 'multipart',
  },
  {
    id: 'bailian',
    labelKey: 'set.asrProvBailian',
    hintKey: 'set.asrProvBailianHint',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen3-asr-flash',
    protocol: 'chat-audio',
  },
  {
    id: 'custom',
    labelKey: 'set.asrProvCustom',
    hintKey: 'set.asrProvCustomHint',
    url: '',
    model: 'whisper-1',
    protocol: 'multipart',
  },
];

export function providerById(id) {
  return ASR_PROVIDERS.find((p) => p.id === id) || ASR_PROVIDERS[2];
}

export function emptyProvider(id) {
  const p = providerById(id);
  return { url: p.url, key: '', model: p.model, protocol: p.protocol };
}

/** 从旧的 interface 地址猜归属：百炼 → bailian，非硅基流动的其它地址 → custom */
function guessProvider(url) {
  if (/dashscope|aliyun|bailian/i.test(url)) return 'bailian';
  if (/siliconflow/i.test(url)) return 'siliconflow';
  return 'custom';
}

/**
 * 归一化设置：保证三家配置齐全、当前服务商有效，并把旧字段同步为当前服务商的值。
 * 纯函数，不碰数据库；getSettings / setSettings 都会过一遍。
 */
export function normalizeAsrSettings(settings = {}) {
  const s = { ...settings };
  const providers = { ...(s.asrProviders || {}) };
  for (const p of ASR_PROVIDERS) {
    const cur = providers[p.id] || {};
    providers[p.id] = { ...emptyProvider(p.id), ...cur };
  }

  let active = s.asrProvider;
  if (!ASR_PROVIDERS.some((p) => p.id === active)) {
    const legacyUrl = (s.asrCloudUrl || '').trim();
    active = legacyUrl ? guessProvider(legacyUrl) : 'siliconflow';
    if (legacyUrl) {
      providers[active] = {
        ...providers[active],
        url: legacyUrl,
        key: s.asrCloudKey || '',
        model: s.asrCloudModel || providers[active].model,
      };
    }
  }

  s.asrProvider = active;
  s.asrProviders = providers;
  const cur = providers[active];
  s.asrCloudUrl = cur.url || '';
  s.asrCloudKey = cur.key || '';
  s.asrCloudModel = cur.model || '';
  return s;
}

/** 取当前生效的服务商（含协议）。所有调用方只读这里，不再直接读旧的 asrCloud* 字段。 */
export function getActiveAsrProvider(settings = {}) {
  const s = normalizeAsrSettings(settings);
  const preset = providerById(s.asrProvider);
  const cfg = s.asrProviders[s.asrProvider];
  return {
    id: preset.id,
    labelKey: preset.labelKey,
    protocol: cfg.protocol || preset.protocol,
    url: (cfg.url || '').trim(),
    key: cfg.key || '',
    model: (cfg.model || '').trim() || preset.model,
    configured: !!(cfg.url || '').trim(),
  };
}
