import { describe, expect, it } from "vitest";
import {
  parseModelList,
  parseOpencodeModel,
  extractModelRef,
  checkModelLiveness,
  type RunImpl,
} from "../src/model-check.js";

describe("parseModelList", () => {
  it("splits lines, trims, drops blanks and lines without '/'", () => {
    const out = parseModelList(
      "\nminimax-cn-coding-plan/MiniMax-M3\n  minimax-cn-coding-plan/MiniMax-M3.1-Flash  \nMODEL  PROVIDER  ID\nno-slash-line\n\n",
    );
    expect(out).toEqual([
      "minimax-cn-coding-plan/MiniMax-M3",
      "minimax-cn-coding-plan/MiniMax-M3.1-Flash",
    ]);
  });

  it("returns [] for empty stdout", () => {
    expect(parseModelList("")).toEqual([]);
  });
});

describe("parseOpencodeModel", () => {
  it("extracts model from a valid JSON config", () => {
    expect(parseOpencodeModel(JSON.stringify({ model: "p/m" }))).toBe("p/m");
  });
  it("returns null for invalid JSON", () => {
    expect(parseOpencodeModel("{not json")).toBeNull();
  });
  it("returns null when model is missing or not a string", () => {
    expect(parseOpencodeModel(JSON.stringify({ other: 1 }))).toBeNull();
    expect(parseOpencodeModel(JSON.stringify({ model: 42 }))).toBeNull();
  });
  it("returns null for undefined / empty", () => {
    expect(parseOpencodeModel(undefined)).toBeNull();
    expect(parseOpencodeModel("")).toBeNull();
  });
});

describe("extractModelRef", () => {
  const env = (model: string) => ({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model }) });

  it("extracts model and provider for opencode", () => {
    expect(extractModelRef("opencode", env("minimax-cn-coding-plan/MiniMax-M3.1-Flash"))).toEqual({
      model: "minimax-cn-coding-plan/MiniMax-M3.1-Flash",
      provider: "minimax-cn-coding-plan",
    });
  });

  it("returns null for the {model:zen-free} placeholder (resolved at spawn time)", () => {
    expect(extractModelRef("opencode", env("{model:zen-free}"))).toBeNull();
  });

  it("returns null for a non-opencode executor", () => {
    expect(extractModelRef("claude", env("claude-sonnet-4"))).toBeNull();
    expect(extractModelRef("fake", env("p/m"))).toBeNull();
  });

  it("returns null when model has no '/' (provider unknown)", () => {
    expect(extractModelRef("opencode", env("bare-model"))).toBeNull();
  });

  it("returns null when OPENCODE_CONFIG_CONTENT is absent or invalid", () => {
    expect(extractModelRef("opencode", {})).toBeNull();
    expect(extractModelRef("opencode", { OPENCODE_CONFIG_CONTENT: "nope" })).toBeNull();
  });
});

describe("checkModelLiveness", () => {
  const ref = { model: "prov/Live", provider: "prov" };
  const okRun: RunImpl = async () => ({ code: 0, stdout: "prov/Live\nprov/Other\n", stderr: "" });

  it("ok when the model id is in the list", async () => {
    expect(await checkModelLiveness(ref, { bin: "/bin/opencode", executor: "opencode", runImpl: okRun })).toBe("ok");
  });

  it("missing when the command succeeds with a non-empty list lacking the id", async () => {
    const run: RunImpl = async () => ({ code: 0, stdout: "prov/Other\n", stderr: "" });
    expect(await checkModelLiveness(ref, { bin: "/bin/opencode", executor: "opencode", runImpl: run })).toBe("missing");
  });

  it("unknown when the command fails, times out, or returns an empty list", async () => {
    const fail: RunImpl = async () => ({ code: 1, stdout: "prov/Live\n", stderr: "boom" });
    expect(await checkModelLiveness(ref, { bin: "x", executor: "opencode", runImpl: fail })).toBe("unknown");

    const timeout: RunImpl = async () => ({ code: null, stdout: "", stderr: "" });
    expect(await checkModelLiveness(ref, { bin: "x", executor: "opencode", runImpl: timeout })).toBe("unknown");

    const empty: RunImpl = async () => ({ code: 0, stdout: "\n\n", stderr: "" });
    expect(await checkModelLiveness(ref, { bin: "x", executor: "opencode", runImpl: empty })).toBe("unknown");

    const throws: RunImpl = async () => { throw new Error("spawn ENOENT"); };
    expect(await checkModelLiveness(ref, { bin: "x", executor: "opencode", runImpl: throws })).toBe("unknown");
  });

  it("unsupported when the executor has no model-list command", async () => {
    let called = false;
    const run: RunImpl = async () => { called = true; return { code: 0, stdout: "", stderr: "" }; };
    expect(await checkModelLiveness(ref, { bin: "x", executor: "claude", runImpl: run })).toBe("unsupported");
    expect(await checkModelLiveness(ref, { bin: "x", executor: "fake", runImpl: run })).toBe("unsupported");
    expect(called).toBe(false);
  });

  it("builds the opencode argv as [bin, 'models', provider]", async () => {
    let seen: string[] = [];
    const run: RunImpl = async (argv) => { seen = argv; return { code: 0, stdout: "prov/Live\n", stderr: "" }; };
    await checkModelLiveness(ref, { bin: "/bin/opencode", executor: "opencode", runImpl: run });
    expect(seen).toEqual(["/bin/opencode", "models", "prov"]);
  });
});
