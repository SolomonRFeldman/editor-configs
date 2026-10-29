// Part of bin/remote-winmux; see the comment at the top of that file.
//
// The hook, on Windows: what Claude Code's hooks there run
// (`remote-winmux hook set <state>` or `remote-winmux hook notification`, put
// in ~/.claude/settings.json by `remote-winmux install-hooks`). It sends the
// hook's JSON to the server, which passes it to the Macs watching, where
// tmux/agent-state.sh marks the tab. A Claude not started by the server (no
// REMOTE_WINMUX_SESSION) sends nothing. Claude Code waits on its hooks, so it
// never takes more than HOOK_TIMEOUT_MS, prints nothing, and always exits 0.

const fs = require("node:fs");
const net = require("node:net");
const { TYPES, encode } = require("./frames");
const { TOKEN_FILE, PIPE, checkRequest } = require("./config");

const HOOK_TIMEOUT_MS = 2_000;

const cut = (s, n) => (typeof s === "string" ? s.slice(0, n) : undefined);

// Only the fields agent-state.sh reads (its DETAILS and the notification), cut
// short: a Write's tool_input carries the whole file. And the transcript's
// path, which the server copies to the Mac (server.js's claudes).
const trim = (p) => {
  const input = p.tool_input || {};
  const question = Array.isArray(input.questions) ? cut(input.questions[0]?.question, 200) : undefined;
  return {
    session_id: cut(p.session_id, 100),
    transcript_path: cut(p.transcript_path, 1000),
    hook_event_name: cut(p.hook_event_name, 50),
    tool_name: cut(p.tool_name, 100),
    tool_input: {
      description: cut(input.description, 200),
      command: cut(input.command, 300),
      file_path: cut(input.file_path, 300),
      notebook_path: cut(input.notebook_path, 300),
      pattern: cut(input.pattern, 200),
      skill: cut(input.skill, 100),
      ...(question !== undefined && { questions: [{ question }] }),
    },
    prompt: cut(p.prompt, 300),
    notification_type: cut(p.notification_type, 50),
    message: cut(p.message, 300),
  };
};

const hook = (kind, state) => {
  const done = () => process.exit(0);
  setTimeout(done, HOOK_TIMEOUT_MS).unref();
  const name = process.env.REMOTE_WINMUX_SESSION;
  if (!name) done();

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    let request;
    try {
      request = checkRequest({ op: "event", name, kind, state, payload: trim(JSON.parse(input || "{}")) });
    } catch {
      done();
    }
    let token;
    try {
      token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    } catch {
      done();
    }
    const pipe = net.connect(PIPE, () => pipe.end(encode(TYPES.hello, { token, request })));
    pipe.on("error", done);
    pipe.on("close", done);
  });
};

// The statusline, on Windows (`remote-winmux statusline`, put in
// ~/.claude/settings.json by install-hooks when there is no statusline). It
// prints what claude/statusline-command.sh prints on the Mac: the model in the
// project's accent color and the context use in a color for how full it is;
// in a Windows tab (REMOTE_WINMUX_SESSION) only those, as in tmux, where the
// tab names the folder and branch, and anywhere else the folder and branch
// too, as in a plain terminal. accentFor is that script's color, from the
// same key, so a project is one color in both. Claude Code gives a statusline
// alone the context use and model, so it also sends them to the server for
// the Mac's Sessions view, only when they change (the last sent is kept in
// STATE_DIR/context/<session>).
const accentFor = (key) => {
  const hue = parseInt(require("node:crypto").createHash("sha256").update(key).digest("hex").slice(0, 8), 16) % 360;
  const seg = Math.floor(hue / 60);
  const frac = Math.floor(((hue % 60) * 255) / 60);
  const c = 204;
  const x = Math.floor((c * (255 - Math.abs(frac * 2 - 255))) / 255);
  const m = 35;
  const [r, g, b] = [[c + m, x + m, m], [x + m, c + m, m], [m, c + m, x + m], [m, x + m, c + m], [x + m, m, c + m], [c + m, m, x + m]][Math.min(seg, 5)]
    .map((v) => Math.max(0, Math.min(255, v)));
  return `\x1b[38;2;${r};${g};${b}m`;
};
const contextColor = (used) => {
  const n = Math.round(used);
  return n < 20 ? "\x1b[97m" : n < 40 ? "\x1b[32m" : n < 60 ? "\x1b[38;5;178m" : n < 80 ? "\x1b[38;5;208m" : "\x1b[38;5;160m";
};
const RESET = "\x1b[0m";

const statusText = (s, inTab) => {
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const model = String(s.model?.display_name ?? "");
  const dir = String(s.workspace?.current_dir ?? s.cwd ?? "");
  const used = s.context_window?.used_percentage;
  let branch = "";
  let key = path.win32.basename(dir);
  try {
    const [common, gitDir, head] = execFileSync("git", ["-C", dir, "--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 1_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/);
    branch = head || "";
    const same = path.resolve(common).toLowerCase() === path.resolve(gitDir).toLowerCase();
    if (branch) key = same ? `${key} | branch:${branch}` : `${key} | worktree:${path.win32.basename(gitDir)}`;
  } catch {}
  const accent = accentFor(key);
  let out = `${accent}${model}${RESET}`;
  if (!inTab) {
    const home = process.env.USERPROFILE || "";
    const shown = home && dir.toLowerCase().startsWith(home.toLowerCase()) ? `~${dir.slice(home.length)}` : dir;
    out += ` | ${accent}${shown}${RESET}`;
    if (branch) out += ` | ${accent}${branch}${RESET}`;
  }
  if (typeof used === "number") out += ` | Context: ${contextColor(used)}${used.toFixed(1)}% used${RESET}`;
  return out;
};

const statusline = () => {
  const done = () => process.exit(0);
  setTimeout(done, HOOK_TIMEOUT_MS).unref();
  const name = process.env.REMOTE_WINMUX_SESSION;
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    let s;
    try {
      s = JSON.parse(input || "{}");
    } catch {
      done();
    }
    // Written at once, since exiting doesn't wait for a pipe.
    try {
      fs.writeSync(1, statusText(s, Boolean(name)));
    } catch {}
    if (!name) done();
    let request;
    try {
      const used = s.context_window?.used_percentage;
      if (typeof used !== "number") done();
      request = checkRequest({ op: "context", name, sessionId: s.session_id, used, model: String(s.model?.display_name ?? "") });
    } catch {
      done();
    }
    const path = require("node:path");
    const { STATE_DIR } = require("./config");
    const file = path.join(STATE_DIR, "context", request.sessionId);
    const line = `${request.used}\t${request.model}`;
    try {
      if (fs.readFileSync(file, "utf8") === line) done();
    } catch {}
    let token;
    try {
      token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    } catch {
      done();
    }
    const pipe = net.connect(PIPE, () => pipe.end(encode(TYPES.hello, { token, request })));
    pipe.on("error", done);
    pipe.on("close", () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, line);
      } catch {}
      done();
    });
  });
};

// The hooks, as the Mac's claude/settings.json runs agent-state.sh: event,
// matcher (null for the events that take none) and what to run.
const HOOKS = [
  ["PreToolUse", "*", "set working"],
  ["UserPromptSubmit", null, "set working"],
  ["PostToolUse", "*", "set working"],
  ["PostToolUseFailure", "*", "set working"],
  ["PermissionRequest", "*", "set waiting"],
  ["Notification", "*", "notification"],
  ["Stop", null, "set done"],
  ["SessionStart", null, "set clear"],
  ["SessionEnd", null, "set clear"],
];

// Adds the hooks to ~/.claude/settings.json on Windows, after copying it to
// settings.json.bak, leaving everything else in it as it was. A hook already
// there (any command naming remote-winmux's hook) isn't added twice. Forward
// slashes, since Claude Code may run hooks under Git Bash or cmd.
const installHooks = (bin) => {
  const os = require("node:os");
  const path = require("node:path");
  const file = path.join(os.homedir(), ".claude", "settings.json");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
  const settings = JSON.parse(text);
  const command = (args) => `node "${bin.replace(/\\/g, "/")}" hook ${args}`;
  settings.hooks ??= {};
  let added = 0;
  for (const [event, matcher, args] of HOOKS) {
    const groups = (settings.hooks[event] ??= []);
    const has = groups.some((g) => (g.hooks || []).some((h) => / hook (set |notification)/.test(h.command || "") && /remote-winmux/.test(h.command || "")));
    if (has) continue;
    groups.push({ ...(matcher && { matcher }), hooks: [{ type: "command", command: command(args) }] });
    added++;
  }
  // The statusline only where there is none: one of your own stays, and the
  // Sessions view goes without the context use of Claude there.
  if (!settings.statusLine) {
    settings.statusLine = { type: "command", command: `node "${bin.replace(/\\/g, "/")}" statusline` };
    added++;
  }
  if (!added) return 0;
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return added;
};

module.exports = { hook, statusline, statusText, accentFor, trim, installHooks, HOOKS };
