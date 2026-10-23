import { describe, expect, it, afterEach } from "vitest";
import { ansi, colorEnabled } from "../src/ansi.js";

/**
 * 终端着色的开关规则。
 *
 * 为什么要有这些规则：转义序列在**人看**的终端里是加分项，在**机器读**的管道里
 * 是噪音（`agent-ex doctor | grep error` 会看到一堆乱码，`grep` 到的行也带控制字符）。
 * 所以默认只在 TTY 下开。
 */
const savedNoColor = process.env.NO_COLOR;
const savedForceColor = process.env.FORCE_COLOR;
const savedIsTTY = process.stdout.isTTY;

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
  Object.defineProperty(process.stdout, "isTTY", { value: savedIsTTY, configurable: true });
});

describe("ansi —— 颜色开关", () => {
  it("NO_COLOR 存在时关闭（用户明确要求别给颜色）", () => {
    process.env.NO_COLOR = "1";
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(colorEnabled()).toBe(false);
    expect(ansi.red("x")).toBe("x");
    expect(ansi.green("x")).toBe("x");
  });

  it("NO_COLOR 的值任意（包括空串）都算关闭", () => {
    process.env.NO_COLOR = "";
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(colorEnabled()).toBe(false);
  });

  it("非 TTY 时关闭（重定向到文件/管道不该有转义序列）", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(colorEnabled()).toBe(false);
    expect(ansi.bold("x")).toBe("x");
  });

  it("TTY 下开启", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(colorEnabled()).toBe(true);
    expect(ansi.red("x")).toContain("\u001b[");
    expect(ansi.red("x")).toContain("x");
  });

  it("FORCE_COLOR 可以在非 TTY 下强制开启（CI 截图等场景）", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(colorEnabled()).toBe(true);
  });

  it("FORCE_COLOR=0 不强制开启", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "0";
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(colorEnabled()).toBe(false);
  });

  it("NO_COLOR 优先于 FORCE_COLOR", () => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(colorEnabled()).toBe(false);
  });

  it("关闭时所有函数都原样返回（不留转义序列）", () => {
    process.env.NO_COLOR = "1";
    for (const fn of [ansi.bold, ansi.dim, ansi.green, ansi.yellow, ansi.red, ansi.cyan]) {
      expect(fn("plain")).toBe("plain");
    }
  });
});
