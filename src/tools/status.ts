import { openStore, type Task } from "../store.js";
import { dbPath } from "../paths.js";

export interface StatusArgs {
  task_id?: string;
  /**
   * 是否把**已结束**的任务也列出来（默认只列进行中的）。
   *
   * 为什么需要它：默认的 listActive() 只列 queued/running/needs_input，
   * **已结束的任务查不到**。而宿主的兜底查询需要在会话重启 / 上下文压缩之后
   * 认回「我上次派的那个任务」—— 那通常已经结束。没有这个开关，宿主无法恢复现场。
   */
  include_finished?: boolean;
  /** 配合 include_finished：返回最近 N 个任务（默认 20，上限 200）。 */
  limit?: number;
}

interface TaskView {
  task_id: string;
  status: string;
  rounds: number;
  profile: string;
  timeout_sec: number;
  elapsed_sec: number | null;
  progress: string | null;
  files_changed: string[];
  /**
   * 任务的工作目录。
   *
   * 为什么暴露它：宿主在会话重启/上下文压缩后要认回「我上次派的那个任务」，
   * 靠的就是 project_path + 时间戳——库里一直有这一列，但此前没返回，
   * 认领规则实际无法执行。
   */
  project_path: string;
  /** Unix 秒。null = 还没开始跑（仍在 queued）。 */
  started_at: number | null;
  /** Unix 秒。null = 还没创建完。 */
  created_at: number;
  question?: string;
  result?: string;
  error?: string;
  notify_failed?: boolean;
}

function view(t: Task): TaskView {
  const now = Math.floor(Date.now() / 1000);
  return {
    task_id: t.id,
    status: t.status,
    rounds: t.rounds,
    profile: t.profile,
    timeout_sec: t.timeout_sec,
    elapsed_sec: t.started_at ? (t.ended_at ?? now) - t.started_at : null,
    progress: t.progress,
    files_changed: t.files_changed,
    project_path: t.project_path,
    started_at: t.started_at,
    created_at: t.created_at,
    ...(t.status === "needs_input" && t.question ? { question: t.question } : {}),
    ...(t.result ? { result: t.result } : {}),
    ...(t.error ? { error: t.error } : {}),
    ...(t.notify_failed ? { notify_failed: true } : {}),
  };
}

export function status(args: StatusArgs): TaskView | TaskView[] | { error: string } {
  const store = openStore(dbPath());
  // 显式关闭：server 长跑，靠 GC 回收连接会把 -wal/-shm 一直钉在磁盘上（见 store.ts）。
  try {
    if (args.task_id) {
      const t = store.getTask(args.task_id);
      if (!t) return { error: `task ${args.task_id} not found` };
      return view(t);
    }
    // 无参 = 只列进行中的任务（保持旧行为）；include_finished = 连已结束的一起列（按创建时间倒序）。
    if (args.include_finished) {
      return store.listRecent(args.limit ?? 20).map(view);
    }
    return store.listActive().map(view);
  } finally {
    store.close();
  }
}