import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // wait-task.test.mjs 是 skill 的独立 node 测试（自带 runner，直接 `node` 执行），
    // 依赖 node:sqlite 且不走 vitest；默认 glob 会把它误收进来并因模块解析失败而报 FAIL。
    exclude: ["**/node_modules/**", "skills/**/*.test.mjs"],
    // ⚠️ 必须显式放宽：tests/cli-env.test.ts 会 spawn `tsx` 子进程跑真 CLI，
    // vitest 默认 5s 在并行满载时不够 ⇒ 实测出现「209 passed / 4 failed / 4 skipped」，
    // 单独跑该文件却 4/4 通过——"全绿"曾经只是那台机器空闲时的属性（同 §9 的 PATH 巧合）。
    testTimeout: 30_000,
  },
});
