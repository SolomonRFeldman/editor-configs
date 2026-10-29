// Part of bin/remote-winmux; see the comment at the top of that file.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Windows side. The token and log live in %LOCALAPPDATA%, which only your
// account (and SYSTEM and administrators) can read.
const STATE_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "remote-winmux");
const TOKEN_FILE = path.join(STATE_DIR, "token");
const LOG_FILE = path.join(STATE_DIR, "server.log");
const MAX_LOG_BYTES = 1_000_000;
const PIPE = `\\\\.\\pipe\\remote-winmux-${(process.env.USERNAME || os.userInfo().username).toLowerCase()}`;
// A client that hasn't proved itself by then is dropped.
const HELLO_TIMEOUT_MS = 5_000;

// Mac side: { "host": "user@machine", "repo": "C:\\path\\to\\editor-configs" },
// outside this repository, since it names a machine.
const CONFIG_FILE = path.join(os.homedir(), ".config/remote-winmux/config.json");
// Mac side, for `watch` (watch.js): its pid and log, and the file
// tmux/remote-tab.zsh appends to when it opens a tab, so the new tab gets its
// session's state at once.
const MAC_STATE_DIR = path.join(os.homedir(), ".local/state/remote-winmux");
const WATCH_PID = path.join(MAC_STATE_DIR, "watch.pid");
const WATCH_LOG = path.join(MAC_STATE_DIR, "watch.log");
const NUDGE_FILE = path.join(MAC_STATE_DIR, "nudge");
// Mac side: the copy of each Windows session's Claude session file and
// transcript (watch.js), laid out as ~/.claude lays them out, which the
// sidebar reads beside ~/.claude.
const MIRROR_DIR = path.join(MAC_STATE_DIR, "claude");

// The programs a session may run, by name, each with the server's own fixed
// arguments: nothing else can be started, and the client passes no arguments.
// Claude runs inside PowerShell, so exiting it leaves you at a prompt in the
// same folder, in the same session, as a local tab leaves you at a shell.
//
// A session started again by a tab reconnecting (the session ended while the
// Mac was away: Windows restarted, or the server did) picks up the folder's
// last conversation, as reopening a local tab does, and starts a new one
// when there is none to continue (claude --continue fails then).
// lazygit, for M-p's lazygit in a Windows pane (tmux/pane-in-place.sh),
// runs through PowerShell for your PATH there, and ends with it.
const PROGRAMS = {
  claude: { exe: "pwsh.exe", args: ["-NoLogo", "-NoExit", "-Command", "claude"] },
  pwsh: { exe: "pwsh.exe", args: ["-NoLogo"] },
  lazygit: { exe: "pwsh.exe", args: ["-NoLogo", "-Command", "lazygit"] },
};
const RESUMED = {
  claude: { exe: "pwsh.exe", args: ["-NoLogo", "-NoExit", "-Command", "claude --continue; if ($LASTEXITCODE) { claude }"] },
  pwsh: PROGRAMS.pwsh,
  lazygit: PROGRAMS.lazygit,
};

// What a new session runs: its program, picking up the folder's last
// conversation (resume) or one by its ID (session, which checkRequest has
// held to an ID's characters), starting a new one if that fails.
const programFor = (program, { resume = false, session } = {}) => {
  if (program === "claude" && session) {
    return { exe: "pwsh.exe", args: ["-NoLogo", "-NoExit", "-Command", `claude --resume ${session}; if ($LASTEXITCODE) { claude }`] };
  }
  return (resume ? RESUMED : PROGRAMS)[program];
};

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const OPS = ["attach", "ls", "kill", "watch", "event", "context"];
// What a Claude hook on Windows reports (hook.js), as tmux/agent-state.sh
// takes it: `set <state>` or `notification`.
const KINDS = ["set", "notification"];
const STATES = ["working", "waiting", "done", "clear"];
// A Claude session's ID, which names its transcript's file on the Mac.
const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;
// How many copied transcripts the Mac may say it has.
const MAX_HAVE = 500;

// The request the Mac sends, checked before the bridge passes it on and again
// by the server, since the pipe is the server's only boundary. Returns the
// request with only its known fields, or throws saying what is wrong.
const checkRequest = (req) => {
  if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("the request is not an object");
  if (!OPS.includes(req.op)) throw new Error(`unknown op ${JSON.stringify(req.op)}`);
  if (req.op === "ls") return { op: "ls" };
  if (req.op === "watch") {
    // The transcripts the Mac has copied: { <session id>: { size, tail } },
    // tail being tailHash of the copy's last bytes, so the server sends each
    // on from where the copy ends, or again from the start when the copy
    // isn't the start of the file there.
    const have = {};
    if (req.have !== undefined) {
      if (!req.have || typeof req.have !== "object" || Array.isArray(req.have)) throw new Error("have must be an object");
      const entries = Object.entries(req.have);
      if (entries.length > MAX_HAVE) throw new Error(`have names more than ${MAX_HAVE} transcripts`);
      for (const [id, v] of entries) {
        if (!SESSION_ID.test(id) || !v || !Number.isSafeInteger(v.size) || v.size < 0 || typeof v.tail !== "string" || !/^[0-9a-f]{0,64}$/.test(v.tail)) {
          throw new Error(`have's entry for ${JSON.stringify(id)} is not { size, tail }`);
        }
        have[id] = { size: v.size, tail: v.tail };
      }
    }
    return { op: "watch", have };
  }
  if (typeof req.name !== "string" || !NAME.test(req.name)) {
    throw new Error("a session name is 1 to 64 letters, digits, '.', '_' or '-'");
  }
  if (req.op === "kill") return { op: "kill", name: req.name };
  // A Claude's context use and model, from its statusline on Windows
  // (hook.js's statusline), for the Mac's Sessions view.
  if (req.op === "context") {
    if (typeof req.sessionId !== "string" || !SESSION_ID.test(req.sessionId)) throw new Error("sessionId must be a Claude session's ID");
    if (typeof req.used !== "number" || !(req.used >= 0 && req.used <= 100)) throw new Error("used must be a percentage");
    if (typeof req.model !== "string" || req.model.length > 100 || /[\t\n\r]/.test(req.model)) throw new Error("model must be a short name");
    return { op: "context", name: req.name, sessionId: req.sessionId, used: req.used, model: req.model };
  }
  if (req.op === "event") {
    if (!KINDS.includes(req.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    if (req.kind === "set" && !STATES.includes(req.state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
    if (!req.payload || typeof req.payload !== "object" || Array.isArray(req.payload)) throw new Error("payload must be an object");
    return { op: "event", name: req.name, kind: req.kind, ...(req.kind === "set" && { state: req.state }), payload: req.payload };
  }
  const out = { op: "attach", name: req.name };
  if (req.cwd !== undefined) {
    if (typeof req.cwd !== "string" || !path.win32.isAbsolute(req.cwd) || req.cwd.includes("\0")) {
      throw new Error("cwd must be an absolute Windows path");
    }
    out.cwd = req.cwd;
  }
  if (req.program !== undefined) {
    if (!Object.hasOwn(PROGRAMS, req.program)) throw new Error(`program must be one of ${Object.keys(PROGRAMS).join(", ")}`);
    out.program = req.program;
  }
  if (req.resume !== undefined) {
    if (typeof req.resume !== "boolean") throw new Error("resume must be true or false");
    out.resume = req.resume;
  }
  // A conversation for a new Claude to resume, by its ID, as the sidebar's
  // Closed view reopens a tab (programFor): only an ID's characters, since it
  // goes into the command Claude starts with.
  if (req.session !== undefined) {
    if (typeof req.session !== "string" || !SESSION_ID.test(req.session)) throw new Error("session must be a Claude session's ID");
    out.session = req.session;
  }
  return out;
};

const loadConfig = () => {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    throw new Error(`can't read ${CONFIG_FILE} (${err.code || err.message}); it holds {"host": "user@machine", "repo": "C:\\\\path\\\\to\\\\editor-configs"}`);
  }
  if (typeof config.host !== "string" || !config.host) throw new Error(`${CONFIG_FILE} has no "host"`);
  if (typeof config.repo !== "string" || !path.win32.isAbsolute(config.repo)) throw new Error(`${CONFIG_FILE}'s "repo" is not an absolute Windows path`);
  // "projects": { "<session name>": "C:\\path" }, offered by M-T's picker.
  const projects = config.projects ?? {};
  for (const [name, cwd] of Object.entries(projects)) checkRequest({ op: "attach", name, cwd });
  return { ...config, projects };
};

// A session name for a path typed into the picker: its last part, with
// anything a name can't hold made a '-'.
const nameFor = (cwd) => path.win32.basename(cwd).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "windows";

// The hash of a file's last TAIL_BYTES before `size`: both sides' check that
// a copy is the start of the file it copies.
const TAIL_BYTES = 1024;
const tailHash = (fd, size) => {
  const n = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(n);
  if (n) fs.readSync(fd, buf, 0, n, size - n);
  return require("node:crypto").createHash("sha256").update(buf).digest("hex").slice(0, 32);
};

module.exports = {
  SESSION_ID, MAX_HAVE, MIRROR_DIR, tailHash, programFor,
  STATE_DIR, TOKEN_FILE, LOG_FILE, MAX_LOG_BYTES, PIPE, HELLO_TIMEOUT_MS,
  CONFIG_FILE, MAC_STATE_DIR, WATCH_PID, WATCH_LOG, NUDGE_FILE, PROGRAMS, RESUMED, STATES, checkRequest, loadConfig, nameFor,
};
