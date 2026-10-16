/**
 * 品牌名的唯一真相源。
 *
 * 为什么需要它：`agent-ex` 这个名字散落在日志前缀、MCP server 名、init 生成的配置片段、
 * 默认数据目录、飞书卡片关键词等处。2026-10-16 实测过它的代价——`notify.keyword` 是一个
 * 用户配置项，本机 live config 里留着改名前的 `agent-flow-ex`，于是连续 23 个任务的终态卡
 * 被飞书静默拒收（code=19024），而仓库里的 `config.example.json` / `README` 早已是新名：
 * **代码默认值与用户覆盖值可以各自漂移，仓库测试再多也照不到 live config。**
 *
 * 所以规则是：凡是"产品叫什么"，一律读 BRAND；凡是"用户想自己指定"，才是配置项。
 * keyword 的缺省值由此派生（见 config.ts），用户显式写 keyword 仍然优先——
 * 那是机器人侧登记词的选择权，属于用户界面，不该被默认值夺走。
 */
export const BRAND = "agent-ex";

/** 缺省数据目录名（相对 HOME）。可用 AGENT_EX_HOME 覆盖。 */
export const HOME_DIR_NAME = `.${BRAND}`;
