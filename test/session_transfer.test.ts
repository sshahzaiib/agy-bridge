import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveSessionTransfer, SESSION_TRANSFER_TOOL } from "../src/tools.js";
import { createSessionTransferHandler } from "../src/server.js";

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

describe("resolveSessionTransfer (pure)", () => {
  it("resolves the id for a cwd and builds a resume command", () => {
    // Given: agy's sessions cache keyed by resolved cwd.
    const cwd = "/repo";
    const map = JSON.stringify({ [path.resolve(cwd)]: "conv-123" });
    // When: resolving for that cwd.
    const r = resolveSessionTransfer(map, cwd);
    // Then: id + resume command are returned.
    expect(r.session_id).toBe("conv-123");
    expect(r.resume_command).toBe("agy --conversation conv-123");
  });

  it("returns null session_id when the cwd is absent", () => {
    const r = resolveSessionTransfer(JSON.stringify({ "/other": "x" }), "/repo");
    expect(r.session_id).toBeNull();
    expect(r.resume_command).toBeNull();
  });

  it("returns null session_id on empty/missing/unparseable map without throwing", () => {
    expect(resolveSessionTransfer("", "/repo").session_id).toBeNull();
    expect(resolveSessionTransfer("not json", "/repo").session_id).toBeNull();
    expect(resolveSessionTransfer("{}", "/repo").session_id).toBeNull();
    expect(resolveSessionTransfer("null", "/repo").session_id).toBeNull();
  });
});

describe("session_transfer handler", () => {
  it("returns the id + resume command for a known cwd", async () => {
    // Given: an injected cache reader for a known cwd.
    const cwd = "/repo";
    const handler = createSessionTransferHandler(async () =>
      JSON.stringify({ [path.resolve(cwd)]: "conv-9" }),
    );
    // When: called with that cwd.
    const res = await handler({ cwd });
    // Then: the response surfaces the id and resume command.
    const text = textOf(res);
    expect(res.isError).toBeUndefined();
    expect(text).toContain("session_id: conv-9");
    expect(text).toContain("agy --conversation conv-9");
  });

  it("returns session_id: null when the cache read fails (missing file)", async () => {
    // Given: the sessions file is absent / unreadable.
    const handler = createSessionTransferHandler(async () => {
      throw new Error("ENOENT");
    });
    // When: called.
    const res = await handler({ cwd: "/repo" });
    // Then: graceful null, no throw, no isError.
    const text = textOf(res);
    expect(text).toContain("session_id: null");
    expect(res.isError).toBeUndefined();
  });

  it("defaults cwd to process.cwd() when omitted", async () => {
    const cwd = process.cwd();
    const handler = createSessionTransferHandler(async () =>
      JSON.stringify({ [path.resolve(cwd)]: "self-1" }),
    );
    const text = textOf(await handler({}));
    expect(text).toContain("self-1");
  });

  it("exposes the session_transfer ToolDef name + cwd schema", () => {
    expect(SESSION_TRANSFER_TOOL.name).toBe("session_transfer");
    expect(SESSION_TRANSFER_TOOL.schema).toHaveProperty("cwd");
  });
});
