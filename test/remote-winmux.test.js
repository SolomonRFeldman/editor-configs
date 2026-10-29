// Tests for bin/remote-winmux's parts that need no Windows: the frames and
// the checks on a request. The server itself runs only on Windows, under ConPTY.

const test = require("node:test");
const assert = require("node:assert");
const { TYPES, MAX_FRAME, encode, Decoder } = require("../lib/remote-winmux/frames");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkRequest, tailHash, programFor } = require("../lib/remote-winmux/config");
const { bridgeCommand, copier } = require("../lib/remote-winmux/client");

test("frames survive being split and joined across chunks", () => {
  const got = [];
  const decoder = new Decoder((type, body) => got.push([type, body.toString()]));
  const bytes = Buffer.concat([encode(TYPES.input, "héllo"), encode(TYPES.resize, { cols: 80, rows: 24 })]);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepStrictEqual(got, [[TYPES.input, "héllo"], [TYPES.resize, '{"cols":80,"rows":24}']]);
});

test("a stopped decoder keeps what came after for the bridge to pass on", () => {
  const decoder = new Decoder(() => decoder.stop());
  const after = encode(TYPES.resize, { cols: 1, rows: 1 });
  decoder.push(Buffer.concat([encode(TYPES.request, { op: "ls" }), after]));
  assert.deepStrictEqual(decoder.rest(), after);
});

test("a frame over the limit or of no known type is refused", () => {
  const big = Buffer.alloc(5);
  big[0] = TYPES.input;
  big.writeUInt32BE(MAX_FRAME + 1, 1);
  assert.throws(() => new Decoder(() => {}).push(big), /over the limit/);
  assert.throws(() => new Decoder(() => {}).push(Buffer.from([99, 0, 0, 0, 0])), /unknown frame type/);
});

test("a request keeps only its known fields", () => {
  assert.deepStrictEqual(checkRequest({ op: "ls", extra: "x" }), { op: "ls" });
  assert.deepStrictEqual(
    checkRequest({ op: "attach", name: "ffx", cwd: "C:\\Games\\FFX&FFX-2", program: "pwsh", token: "x" }),
    { op: "attach", name: "ffx", cwd: "C:\\Games\\FFX&FFX-2", program: "pwsh" },
  );
});

test("a request with a bad name, path, program or op is refused", () => {
  for (const req of [
    null,
    [],
    { op: "exec" },
    { op: "attach", name: "a b" },
    { op: "attach", name: "x;rm" },
    { op: "attach", name: "x".repeat(65) },
    { op: "attach", name: "ok", cwd: "relative\\dir" },
    { op: "attach", name: "ok", cwd: "C:\\a\0b" },
    { op: "attach", name: "ok", program: "cmd" },
    { op: "attach", name: "ok", program: "toString" },
    { op: "kill" },
  ]) {
    assert.throws(() => checkRequest(req), undefined, JSON.stringify(req));
  }
});

test("the bridge's command line quotes the repository's path for PowerShell", () => {
  assert.strictEqual(bridgeCommand("C:\\it's here"), "& node 'C:\\it''s here\\bin\\remote-winmux' bridge");
});

test("what Claude on Windows copies (OSC 52) is copied here, whole or split across frames", () => {
  const got = [];
  const feed = copier((text) => got.push(text));
  const seq = (text, end = "\x07") => `\x1b]52;c;${Buffer.from(text).toString("base64")}${end}`;
  feed(Buffer.from(`before ${seq("héllo ✓")} after`));
  const split = seq("split one", "\x1b\\");
  feed(Buffer.from(`x${split.slice(0, 9)}`));
  feed(Buffer.from(`${split.slice(9)}y`));
  feed(Buffer.from("\x1b]52;c;\x07"));
  assert.deepStrictEqual(got, ["héllo ✓", "split one"]);
});

test("a reattach may ask for the session to resume, as true or false only", () => {
  assert.deepStrictEqual(checkRequest({ op: "attach", name: "ffx", resume: true }), { op: "attach", name: "ffx", resume: true });
  assert.throws(() => checkRequest({ op: "attach", name: "ffx", resume: "yes" }), /resume/);
});

test("a watch says which transcripts the Mac has copied, and nothing that could name another file", () => {
  const have = { "00000000-0000-4000-8000-000000000000": { size: 10, tail: "ab12" } };
  assert.deepStrictEqual(checkRequest({ op: "watch", have, extra: 1 }), { op: "watch", have });
  assert.deepStrictEqual(checkRequest({ op: "watch" }), { op: "watch", have: {} });
  assert.throws(() => checkRequest({ op: "watch", have: { "../x": { size: 1, tail: "" } } }), /not \{ size, tail \}/);
  assert.throws(() => checkRequest({ op: "watch", have: { a: { size: -1, tail: "" } } }), /not \{ size, tail \}/);
  assert.throws(() => checkRequest({ op: "watch", have: [] }), /must be an object/);
});

test("a copy's tail hash matches the file it copies only where the copy ends", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winmux-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, `${"a".repeat(3000)}\nmore\n`);
  const fd = fs.openSync(file, "r");
  const copy = path.join(dir, "c.jsonl");
  fs.writeFileSync(copy, "a".repeat(3000));
  const cfd = fs.openSync(copy, "r");
  assert.strictEqual(tailHash(fd, 3000), tailHash(cfd, 3000));
  assert.notStrictEqual(tailHash(fd, 3001), tailHash(cfd, 3000));
  assert.strictEqual(tailHash(fd, 0), tailHash(cfd, 0));
  fs.closeSync(fd);
  fs.closeSync(cfd);
  fs.rmSync(dir, { recursive: true });
});

test("a conversation to resume is named by its ID alone, and resumed by Claude", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  assert.deepStrictEqual(checkRequest({ op: "attach", name: "ffx", session: id }), { op: "attach", name: "ffx", session: id });
  assert.throws(() => checkRequest({ op: "attach", name: "ffx", session: "x; rm -rf ~" }), /session must be/);
  assert.match(programFor("claude", { session: id }).args.at(-1), new RegExp(`^claude --resume ${id};`));
  assert.deepStrictEqual(programFor("pwsh", { session: id }).args, ["-NoLogo"]);
  assert.match(programFor("claude", { resume: true }).args.at(-1), /claude --continue/);
  assert.match(programFor("lazygit").args.at(-1), /^lazygit$/);
});

test("a context report holds a percentage and a short model name, for a session by ID", () => {
  const ok = { op: "context", name: "ffx", sessionId: "00000000-0000-4000-8000-000000000000", used: 42.5, model: "Opus 5.5" };
  assert.deepStrictEqual(checkRequest({ ...ok, extra: 1 }), ok);
  assert.throws(() => checkRequest({ ...ok, used: 101 }), /percentage/);
  assert.throws(() => checkRequest({ ...ok, model: "a\tb" }), /short name/);
  assert.throws(() => checkRequest({ ...ok, sessionId: "../x" }), /session's ID/);
});

test("the Windows statusline prints what the Mac's prints, accent color and all", () => {
  const { execFileSync } = require("node:child_process");
  const { statusText } = require("../lib/remote-winmux/hook");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winmux-sl-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "winmux-home-"));
  const repo = path.join(dir, "ffx-shaders");
  fs.mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "make-project-loopable"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "t"]);
  for (const [where, used] of [[dir, 5], [dir, 25.4], [repo, 50], [repo, 70], [dir, 95]]) {
    const input = { model: { display_name: "Opus 5.5" }, workspace: { current_dir: where }, context_window: { used_percentage: used } };
    const mac = execFileSync("bash", [path.join(__dirname, "../claude/statusline-command.sh")], {
      input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, HOME: home, TMUX: "x" },
    });
    assert.strictEqual(statusText(input, true), mac);
  }
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(home, { recursive: true });
});

// The shared connection, against a stand-in ssh: `-O check` answers from a
// file, and a master records itself and is refused while another file is
// there. Run in a child with its own HOME, since the paths are read at load.
const masterRun = (script, { refuse = false } = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wm-master-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, ".config/remote-winmux"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/remote-winmux/config.json"), JSON.stringify({ host: "me@win", repo: "C:\\r" }));
  if (refuse) fs.writeFileSync(path.join(home, "refuse"), "");
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/bash
case " $* " in
  *" -O check "*) [ -e "$HOME/up" ] ;;
  *" -G "*) echo "controlpath $HOME/.ssh/wm-x" ;;
  *" -M "*)
    echo master >> "$HOME/masters"
    sleep 0.3
    if [ -e "$HOME/refuse" ]; then echo 'sign_and_send_pubkey: signing failed for ED25519 "k" from agent: agent refused operation' >&2; exit 255; fi
    touch "$HOME/up" ;;
  *) exit 255 ;;
esac
`, { mode: 0o755 });
  const out = require("node:child_process").execFileSync(process.execPath, ["-e", `
    const { ensureMaster } = require(${JSON.stringify(path.join(__dirname, "../lib/remote-winmux/client"))});
    (async () => { console.log(JSON.stringify(await (${script})(ensureMaster))); })();
  `], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  let masters = 0;
  try {
    masters = fs.readFileSync(path.join(home, "masters"), "utf8").trim().split("\n").length;
  } catch {}
  fs.rmSync(home, { recursive: true, force: true });
  return { result: JSON.parse(out), masters };
};

test("many connections wanting Windows at once start one master, so the key is asked for once", () => {
  const { result, masters } = masterRun(`(ensure) => Promise.all([1, 2, 3, 4, 5].map((i) => ensure("me@win", { background: i > 1 })))`);
  assert.deepStrictEqual(result, [null, null, null, null, null]);
  assert.strictEqual(masters, 1);
});

test("once the key is refused, the background stops asking, and so does an ask right after", () => {
  const { result, masters } = masterRun(`async (ensure) => {
    const first = await ensure("me@win");
    const later = await Promise.all([1, 2, 3].map(() => ensure("me@win", { background: true })));
    const now = await ensure("me@win");
    return [first, later, now];
  }`, { refuse: true });
  assert.match(result[0], /agent refused operation/);
  result[1].forEach((why) => assert.match(why, /key was refused/));
  assert.match(result[2], /key was refused/);
  assert.strictEqual(masters, 1);
});
