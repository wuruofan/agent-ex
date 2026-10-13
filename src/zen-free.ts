/**
 * opencode zen 免费模型的动态解析（{model:zen-free} 占位符）。
 *
 * 背景：zen 的 free 模型集会轮换（mimo-v2.5-free → mimo-v2.6-flash-free 已发生过，
 * glm-4.7-free 已整体消失），且撞限流会 429。因此：
 *   - 事实来源 = spawn 时的实时列表（https://opencode.ai/zen/v1/models，免鉴权，~1s）；
 *   - 配置里**零硬引用**模型名：ZEN_FREE_PREFER 只是"家族前缀口味"（软偏好），
 *     过期的唯一后果是退化为"不挑食"，绝不因此失败；
 *   - fail-safe：列表拉取失败 → 退回内置回退常量，解析失败绝不阻塞任务启动。
 *
 * ⚠️ 不能按"报错内容"自愈：模型下线时 opencode 报的
 * `UnknownError: "Unexpected server error..."`（且 exit=0）与真实服务端故障无法区分
 * （2026-10-13 实测）——所以必须 spawn 前主动解析，不做错误驱动换模。
 */

/** 占位符：profile env 值里出现它即触发动态解析。载荷保持小写（模型 id 惯例），命名空间与 {env:...} 同族。 */
export const ZEN_FREE_PLACEHOLDER = "{model:zen-free}";

/** 实时模型清单端点（zen 文档明示；免鉴权；OpenAI list 格式 {data:[{id}]}）。 */
export const ZEN_FREE_MODEL_LIST_URL = "https://opencode.ai/zen/v1/models";

/**
 * fail-safe 回退常量（数据默认，非"推荐"）：仅在实时列表不可得时使用。
 * 它会过期——过期的代价只是那次解析退回去掉，下次列表可得即自愈。
 */
export const ZEN_FREE_FALLBACK_MODEL = "opencode/mimo-v2.6-flash-free";

/** 前缀口味的代码默认：空 = 不挑食（任意可用 free 文本模型，稳定排序）。 */
export const ZEN_FREE_DEFAULT_PREFER = "";

/** 非文本/不适合跑任务的 free 模型黑名单：jev-* 只做结构化决策，不生成文本。 */
const ID_BLACKLIST = [/^jev-/];

/** 从 zen 清单条目里挑 free 文本模型 id（纯函数，便于单测与 runner 排除集复用）。 */
export function pickZenFreeModel(
  ids: string[],
  preferCsv: string,
  exclude: ReadonlySet<string>,
): string | null {
  const prefixes = preferCsv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const candidates = ids
    .map((id) => id.trim())
    .filter((id) => id.endsWith("-free") && !ID_BLACKLIST.some((re) => re.test(id)) && !exclude.has(id))
    .sort(); // 稳定排序：无偏好的兜底顺序不随上游列表顺序抖动
  if (candidates.length === 0) return null;
  for (const p of prefixes) {
    const hit = candidates.find((id) => id.toLowerCase().startsWith(p));
    if (hit) return hit;
  }
  return candidates[0];
}

/** 拉实时清单并解析成 `opencode/<id>`；5s 超时，失败返回 null（由调用方走回退常量）。 */
export async function fetchZenFreeIds(fetchImpl?: typeof fetch): Promise<string[] | null> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(ZEN_FREE_MODEL_LIST_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(j.data)) return null;
    return j.data.map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * 把 env 里所有含占位符的值解析成实际模型引用；无占位符则原样返回（零成本旁路）。
 * 返回 resolvedModel 供 runner 重试路由维护"已撞限排除集"。
 */
export async function resolveZenFreeEnv(
  env: Record<string, string>,
  exclude: ReadonlySet<string> = new Set(),
  fetchImpl?: typeof fetch,
): Promise<{ env: Record<string, string>; model: string | null }> {
  if (!Object.values(env).some((v) => v.includes(ZEN_FREE_PLACEHOLDER))) {
    return { env, model: null };
  }
  const ids = await fetchZenFreeIds(fetchImpl);
  // 排除集元素可能是 `opencode/<id>`（runner 传入 resolved.model 原样值），归一化成裸 id 再比对。
  const idExclude = new Set([...exclude].map((m) => m.replace(/^opencode\//, "")));
  const id = ids ? pickZenFreeModel(ids, env.ZEN_FREE_PREFER ?? ZEN_FREE_DEFAULT_PREFER, idExclude) : null;
  // id 为 null = 列表不可得或全被排除 → fail-safe 用回退常量，任务照常启动。
  const model = id ? `opencode/${id}` : ZEN_FREE_FALLBACK_MODEL;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v.replaceAll(ZEN_FREE_PLACEHOLDER, model);
  return { env: out, model };
}
