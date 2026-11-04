import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // wait-task.test.mjs 是 skill 的独立 node 测试（自带 runner，直接 `node` 执行），
    // 依赖 node:sqlite 且不走 vitest；默认 glob 会把它误收进来并因模块解析失败而报 FAIL。
    exclude: ["**/node_modules/**", "skills/**/*.test.mjs"],
    // ⚠️ 必须显式放宽：多个测试文件会 spawn 真进程（`tsx src/server.ts` / runner），
    // vitest 默认 5s 在并行满载时不够 ⇒ 实测出现「209 passed / 4 failed / 4 skipped」，
    // 单独跑该文件却 4/4 通过——"全绿"曾经只是那台机器空闲时的属性（同 §9 的 PATH 巧合）。
    // 60s：spawn 的 server 要加载整个 MCP SDK；文件 open 慢的机器（实测 25-50ms/次）单次启动 10s 量级。
    // 这些用例里真正的"挂死"上界由各自的内部 deadline 判定，这里只兜底。
    testTimeout: 60_000,
    // 并发上限 4：这套测试的耗时全在 spawn 真进程（server / runner / CLI），不是 CPU 计算。
    // 机器文件 open 慢时（2026-11-04 实测 25-50ms/次），并发越高越互相拖：
    // 12 并发 → 6 failed，6 并发 → 1 failed，4 并发 → 0 failed。
    // 而且 4 并发不比 12 并发慢（234s vs 261s），因为 12 路时大部分时间花在抢 I/O 上。
    maxWorkers: 4,
    minWorkers: 2,
  },
});
