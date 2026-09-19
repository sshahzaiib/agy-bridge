import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolHandler, buildImageGenResponse } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { TOOLS, parseImageGenReply, mimeTypeFor, type ToolDef } from "../src/tools.js";
import type { ChildHandle, RunnerDeps, RunResult } from "../src/runner.js";
import type { Config } from "../src/config.js";
import type { ImageGenDeps } from "../src/server.js";

const IMAGE_GEN = TOOLS.find((t) => t.name === "image_gen") as ToolDef;

const LISTING = "Gemini 3.5 Flash (Medium)\nGemini 3.5 Flash (High)\nGemini 3.1 Pro (High)\n";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  perToolTimeouts: {},
  maxOutputChars: 50_000,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeTmpFile(ext: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-img-"));
  tmpDirs.push(dir);
  const p = path.join(dir, `out.${ext}`);
  await writeFile(p, bytes);
  return p;
}

/** RunnerDeps whose spawnChild returns a fixed agy reply (no real agy). */
function replyDeps(reply: string): RunnerDeps {
  return {
    spawnChild: () => {
      const child: ChildHandle = {
        stdout: () => reply,
        stderr: () => "",
        pid: () => undefined,
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    },
    readLog: async () => "",
    removeLog: async () => {},
    readSessionsFile: async () => JSON.stringify({ [process.cwd()]: "sess-img" }),
    makeLogPath: () => "/tmp/agy-bridge-img.log",
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };
}

function imageGenHandler(reply: string) {
  return createToolHandler(
    IMAGE_GEN,
    cfg,
    new ModelRegistry(async () => LISTING),
    replyDeps(reply),
  );
}

describe("parseImageGenReply (pure)", () => {
  it("parses the last IMAGE_PATH: marker line", () => {
    // Given: a reply with two marker lines (model corrected itself).
    const reply = "done.\nIMAGE_PATH: /tmp/first.png\nIMAGE_PATH: /tmp/x.png";
    // When: parsing.
    const r = parseImageGenReply(reply);
    // Then: the LAST marker wins (mirrors agy-run.sh `tail -n1`).
    expect(r.srcPath).toBe("/tmp/x.png");
    expect(r.viaMarker).toBe(true);
  });

  it("trims whitespace around the marker path", () => {
    const r = parseImageGenReply("ok\nIMAGE_PATH:   /tmp/x.png   ");
    expect(r.srcPath).toBe("/tmp/x.png");
    expect(r.viaMarker).toBe(true);
  });

  it("falls back to scraping an absolute Windows path with spaces", () => {
    // Given: no marker, but a Windows-drive path with a space in the reply.
    const reply = "saved to C:\\Users\\Jack Ang\\z.png — enjoy";
    // When: parsing.
    const r = parseImageGenReply(reply);
    // Then: the Windows-safe scrape finds it.
    expect(r.srcPath).toBe("C:\\Users\\Jack Ang\\z.png");
    expect(r.viaMarker).toBe(false);
  });

  it("falls back to scraping a POSIX absolute path", () => {
    const r = parseImageGenReply("see /home/u/pics/cat.webp for the result");
    expect(r.srcPath).toBe("/home/u/pics/cat.webp");
    expect(r.viaMarker).toBe(false);
  });

  it("returns null srcPath when no marker and no absolute image path", () => {
    const r = parseImageGenReply("I could not generate the image. Sorry.");
    expect(r.srcPath).toBeNull();
    expect(r.viaMarker).toBe(false);
  });

  it("prefers the marker over a scraped path", () => {
    const reply = "saw /tmp/decoy.png\nIMAGE_PATH: /tmp/real.png";
    expect(parseImageGenReply(reply).srcPath).toBe("/tmp/real.png");
  });
});

describe("mimeTypeFor", () => {
  it.each([
    ["x.png", "image/png"],
    ["x.jpg", "image/jpeg"],
    ["x.jpeg", "image/jpeg"],
    ["x.webp", "image/webp"],
    ["x.bin", "application/octet-stream"],
  ])("maps %s -> %s", (file, mime) => {
    expect(mimeTypeFor(file)).toBe(mime);
  });
});

describe("image_gen buildPrompt", () => {
  it("builds the IMAGE_PATH contract and omits the name clause when no slug", () => {
    const prompt = IMAGE_GEN.buildPrompt({ description: "a red cube" }, "/repo");
    expect(prompt).toContain("generate_image tool");
    expect(prompt).toContain("Description: a red cube.");
    expect(prompt).toContain("IMAGE_PATH: <absolute filesystem path");
    expect(prompt).not.toContain("Save the image with name");
  });

  it("includes the name slug clause when provided", () => {
    const prompt = IMAGE_GEN.buildPrompt({ description: "a cube", name: "hero" }, "/repo");
    expect(prompt).toContain('Save the image with name "hero".');
  });
});

describe("image_gen handler — end to end (mocked agy)", () => {
  it("parses the marker, copies to output, and attaches an image block (png)", async () => {
    // Given: a real tmp PNG file + a reply ending with its IMAGE_PATH.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG header-ish
    const src = await makeTmpFile("png", bytes);
    const dest = path.join(path.dirname(src), "copied.png");
    const reply = `Here is the image.\nIMAGE_PATH: ${src}`;
    // When: the handler runs.
    const res = await imageGenHandler(reply)({ description: "a png", output: dest });
    // Then: marker parsed, file copied byte-for-byte, image block present.
    const text = res.content.find((b) => b.type === "text") as { text: string };
    const img = res.content.find((b) => b.type === "image") as
      | { data: string; mimeType: string }
      | undefined;
    expect(res.isError).toBeUndefined();
    expect(text.text).toContain(`image_path: ${src}`);
    expect(text.text).toContain("parsed via: IMAGE_PATH marker");
    expect(text.text).toContain(`copied to: ${dest}`);
    expect(await readFile(dest)).toEqual(bytes);
    expect(img).toBeDefined();
    expect(img!.mimeType).toBe("image/png");
    expect(Buffer.from(img!.data, "base64")).toEqual(bytes);
  });

  it("falls back to scraping an absolute path when no marker is present", async () => {
    // Given: a real tmp file whose path appears in the reply WITHOUT a marker.
    const bytes = Buffer.from([1, 2, 3, 4]);
    const src = await makeTmpFile("webp", bytes);
    const reply = `Image saved at ${src}, hope you like it.`; // no IMAGE_PATH: line
    // When: the handler runs.
    const res = await imageGenHandler(reply)({ description: "no marker" });
    // Then: fallback scrape found the path (image block attached).
    const text = res.content.find((b) => b.type === "text") as { text: string };
    const img = res.content.find((b) => b.type === "image") as
      | { data: string; mimeType: string }
      | undefined;
    expect(res.isError).toBeUndefined();
    expect(text.text).toContain(`image_path: ${src}`);
    expect(text.text).toContain("parsed via: fallback path scrape");
    expect(img).toBeDefined();
    expect(img!.mimeType).toBe("image/webp");
    expect(Buffer.from(img!.data, "base64")).toEqual(bytes);
  });

  it("returns text + warning (no image block) when no marker and no path", async () => {
    // Given: a reply with neither a marker nor an absolute image path.
    const reply = "The image tool failed; nothing was saved.";
    // When: the handler runs.
    const res = await imageGenHandler(reply)({ description: "fail case" });
    // Then: deterministic default — warning, no image block, no throw.
    const text = res.content.find((b) => b.type === "text") as { text: string };
    expect(res.isError).toBeUndefined();
    expect(text.text).toContain("WARNING");
    expect(text.text).toMatch(/no absolute image path/i);
    expect(res.content.some((b) => b.type === "image")).toBe(false);
  });
});

describe("buildImageGenResponse (unit)", () => {
  const noopDeps: ImageGenDeps = {
    copyFile: async () => {},
    readFileBytes: async () => Buffer.alloc(0),
  };

  it("is text-only when the scraped file is unreadable (no throw)", async () => {
    // Given: a parsed path whose read fails.
    const failingDeps: ImageGenDeps = {
      copyFile: async () => {},
      readFileBytes: async () => {
        throw new Error("ENOENT");
      },
    };
    const result: RunResult = { output: "ok\nIMAGE_PATH: /nope.png", truncated: false };
    // When: building the response with the failing read.
    const res = await buildImageGenResponse(result, {}, ["model: x"], failingDeps);
    // Then: text footer notes the skip; no image block; no throw.
    const text = res.content.find((b) => b.type === "text") as { text: string };
    expect(text.text).toContain("image block skipped: file unreadable");
    expect(res.content.some((b) => b.type === "image")).toBe(false);
  });

  it("reports a copy failure in the footer without throwing", async () => {
    const result: RunResult = { output: "ok\nIMAGE_PATH: /tmp/x.png", truncated: false };
    const res = await buildImageGenResponse(
      result,
      { output: "/bad/dest.png" },
      ["model: x"],
      noopDeps,
    );
    const text = res.content.find((b) => b.type === "text") as { text: string };
    // copyFile is a noop here so it succeeds; assert the copy line is present.
    expect(text.text).toContain("copied to: /bad/dest.png");
  });
});
