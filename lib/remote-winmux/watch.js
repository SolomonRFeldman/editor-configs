// Part of bin/remote-winmux; see the comment at the top of that file.
//
// The watcher, on the Mac: one `ssh -T` held open to the server's watch, so
// Claude's state in each Windows session marks its tab here as a local
// session's would. Each event is run through tmux/agent-state.sh with
// TMUX_PANE set to every pane whose @remote names the session, and
// REMOTE_WINMUX_EVENT set, which keeps it from the Slack relay (the event's
// transcript is on Windows). So the tab bar, the sidebar, M-a and the banner
// need nothing of their own.
//
// It keeps each session's last state and gives it again to a tab opened
// later (tmux/remote-tab.zsh appends to NUDGE_FILE), reconnects when the
// connection drops, and exits once the tmux server is gone. Only one runs
// (WATCH_PID); `watch --start` starts it in the background unless it is.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { TYPES, json } = require("./frames");
const { MAC_STATE_DIR, WATCH_PID, WATCH_LOG, NUDGE_FILE, MIRROR_DIR, MAX_HAVE, SESSION_ID, tailHash } = require("./config");
const { connect } = require("./client");

const AGENT_STATE = path.join(os.homedir(), ".config/tmux/agent-state.sh");
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

const log = (...parts) => console.log(`${new Date().toISOString()} ${parts.join(" ")}`);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const running = () => {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(WATCH_PID, "utf8").trim() || 0);
  } catch {}
  return pid && alive(pid) ? pid : 0;
};

// In the background, its output in WATCH_LOG, unless one already runs.
const start = (bin) => {
  fs.mkdirSync(MAC_STATE_DIR, { recursive: true });
  try {
    if (running()) return;
  } catch {}
  const out = fs.openSync(WATCH_LOG, "a");
  spawn(process.execPath, [bin, "watch"], { detached: true, stdio: ["ignore", out, out] }).unref();
};

const TMUX_ENV = { ...process.env, LC_ALL: "en_US.UTF-8" };

// The panes attached to each session, each of which carries the session's
// name in its own @remote (tmux/remote-tab.zsh), so a split beside a Claude
// is a session of its own: { name: { panes: [...], target, info: Map(pane ->
// { session, cwd, front, panePath, branch }) } }, target naming its first pane
// as a session file names its pane ("main:@27.%28").
const tabsByName = () => {
  const out = spawnSync("tmux", ["list-panes", "-a", "-F",
    "#{@remote}\t#{pane_id}\t#{@sidebar}\t#{window_id}\t#{session_name}\t#{@remote_cwd}\t#{&&:#{pane_active},#{&&:#{window_active},#{session_attached}}}\t#{pane_current_path}\t#{@remote_branch}"], {
    encoding: "utf8", env: TMUX_ENV,
  });
  const map = {};
  for (const line of (out.stdout || "").split("\n")) {
    const [name, pane, sidebar, window, session, cwd, front, panePath, branch] = line.split("\t");
    if (!name || !pane || sidebar) continue;
    const tab = (map[name] ??= { panes: [], info: new Map() });
    tab.panes.push(pane);
    tab.target ??= `${session}:${window}.${pane}`;
    tab.info.set(pane, { session, cwd, front: front === "1", panePath, branch });
  }
  return map;
};

// The facts each event carries (the server's factsFor) go on the session's
// panes, for tab-label.sh and tab-status.sh: @remote_branch, @remote_claude,
// @remote_prompt. With the branch goes the tab's color, @remote_color, from
// the Windows folder and branch keyed as accent-color.sh keys a local repo
// ("<dirname> | branch:<branch>"). When the branch changes, the tab's name and
// color do, so its session's tabs are renamed as window-names.sh renames any.
const TMUX_DIR = path.join(os.homedir(), ".config/tmux");
const colors = new Map();
const colorFor = (cwd, branch) => {
  const dir = path.win32.basename(cwd || "");
  const key = branch ? `${dir} | branch:${branch}` : dir;
  if (!colors.has(key)) {
    const out = spawnSync("bash", [path.join(TMUX_DIR, "accent-color.sh"), "--key", key], { encoding: "utf8" }).stdout?.trim();
    colors.set(key, /^[0-9a-f]{6}$/.test(out || "") ? out : "");
  }
  return colors.get(key);
};
// The Mac's stand-in for a Windows pane's repository: a repository of one
// empty commit in STANDINS/<session> (tmux/remote-tab.zsh makes it), which
// the pane's client runs in, so the pane's directory is it. The watcher keeps
// it on the branch Windows is on, with the same origin, so everything that
// asks git and gh about a pane's directory (the tab's PR number, M-r, M-v,
// M-m, the branch-copy commands) finds the branch's PR as for a local one.
// Only a GitHub origin is taken, and rewritten in one form, and only a branch
// name's characters, since both come from the other machine.
const STANDINS = path.join(MAC_STATE_DIR, "repos");
const GITHUB = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;
const standins = new Map();
const updateStandin = (dir, facts) => {
  if (!dir || !dir.startsWith(STANDINS + path.sep) || !fs.existsSync(path.join(dir, ".git"))) return;
  const m = GITHUB.exec(facts.origin || "");
  const origin = m ? `https://github.com/${m[1]}/${m[2]}.git` : "";
  const branch = BRANCH.test(facts.branch || "") && !facts.branch.endsWith(".lock") ? facts.branch : "";
  const key = `${origin}\t${branch}`;
  if (standins.get(dir) === key) return;
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" }).status === 0;
  git("remote", "remove", "origin");
  if (origin) git("remote", "add", "origin", origin);
  if (branch) git("checkout", "-q", "-B", branch);
  standins.set(dir, key);
};

const setFacts = (facts, tab) => {
  if (!facts) return;
  const renames = new Set();
  const recolor = [];
  for (const [pane, { session, cwd, front, panePath, branch: before }] of tab.info) {
    updateStandin(panePath, facts);
    const color = colorFor(cwd, facts.branch);
    const args = [
      "set", "-p", "-t", pane, "@remote_branch", facts.branch || "", ";",
      ...(Number.isInteger(facts.ahead) ? ["set", "-p", "-t", pane, "@remote_ahead", String(facts.ahead)] : ["set", "-pu", "-t", pane, "@remote_ahead"]), ";",
      ...(facts.claude ? ["set", "-p", "-t", pane, "@remote_claude", "1"] : ["set", "-pu", "-t", pane, "@remote_claude"]), ";",
      ...(color ? ["set", "-p", "-t", pane, "@remote_color", color] : ["set", "-pu", "-t", pane, "@remote_color"]), ";",
      "set", "-p", "-t", pane, "@remote_prompt", facts.prompt || "",
    ];
    spawnSync("tmux", args, { stdio: "ignore", env: TMUX_ENV });
    if (before !== (facts.branch || "")) {
      renames.add(session);
      // The tab in front took its colors from its pane when it was focused,
      // before its own color was known.
      if (front) recolor.push([panePath, session, color]);
    }
  }
  // update-colors.sh renames the session's tabs too.
  for (const [panePath, session, color] of recolor) {
    spawnSync("bash", [path.join(TMUX_DIR, "update-colors.sh"), panePath, session, color], { stdio: "ignore", env: TMUX_ENV });
    renames.delete(session);
  }
  for (const session of renames) spawnSync("bash", [path.join(TMUX_DIR, "window-names.sh"), session], { stdio: "ignore", env: TMUX_ENV });
};

// agent-state.sh, one event at a time so they reach a pane in order.
let queue = Promise.resolve();
const apply = (event, panes) => {
  const args = event.kind === "set" ? ["set", event.state] : ["notification"];
  for (const pane of panes) {
    queue = queue.then(() => new Promise((resolve) => {
      const child = spawn("bash", [AGENT_STATE, ...args], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, TMUX_PANE: pane, REMOTE_WINMUX_EVENT: "1", LC_ALL: "en_US.UTF-8" },
      });
      child.on("close", resolve);
      child.on("error", resolve);
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(event.payload || {}));
    }));
  }
};

// The copy of each Windows Claude, laid out as ~/.claude lays them out, so
// the sidebar reads it beside ~/.claude (lib/sidebar/claude.js): a session
// file in sessions/<session name>.json, naming the tab's pane as a local
// Claude's names its own, and the transcript in projects/<dir>/<id>.jsonl.
// The server sends each transcript on from what the copy holds (haveNow, in
// the watch request), so a copy is never more than a connection behind.
const MIRROR_SESSIONS = path.join(MIRROR_DIR, "sessions");
const MIRROR_PROJECTS = path.join(MIRROR_DIR, "projects");
const projectDir = (cwd) => path.join(MIRROR_PROJECTS, String(cwd || "windows").replace(/[^A-Za-z0-9]/g, "-"));

const haveNow = () => {
  const files = [];
  try {
    for (const dir of fs.readdirSync(MIRROR_PROJECTS)) {
      for (const name of fs.readdirSync(path.join(MIRROR_PROJECTS, dir))) {
        const id = name.replace(/\.jsonl$/, "");
        if (id === name || !SESSION_ID.test(id)) continue;
        const file = path.join(MIRROR_PROJECTS, dir, name);
        files.push({ id, file, mtime: fs.statSync(file).mtimeMs });
      }
    }
  } catch {}
  const have = {};
  for (const { id, file } of files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_HAVE)) {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      have[id] = { size, tail: tailHash(fd, size) };
    } finally {
      fs.closeSync(fd);
    }
  }
  return have;
};

// A chunk is written where it says it goes. One from past the copy's end
// would leave a hole, which can only mean the copy changed under the watch:
// false drops the connection, and the next sends on from what the copy holds.
const onTranscript = (event) => {
  if (!SESSION_ID.test(event.sessionId || "") || !Number.isSafeInteger(event.offset)) return true;
  const dir = projectDir(event.cwd);
  const file = path.join(dir, `${event.sessionId}.jsonl`);
  fs.mkdirSync(dir, { recursive: true });
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (event.offset > size) {
    log("a gap in", event.sessionId, "at", event.offset, "of", size);
    return false;
  }
  if (event.offset < size) fs.truncateSync(file, event.offset);
  fs.appendFileSync(file, Buffer.from(event.data || "", "base64"));
  return true;
};

// Claude's session file there, or none once it has none. @remote_title is
// the name it was given with /rename, as tab-status.sh shows a local one's.
const sessionFiles = new Map();
const writeSession = (name, tab) => {
  const s = sessionFiles.get(name);
  const file = path.join(MIRROR_SESSIONS, `${name}.json`);
  const named = s && s.nameSource && s.nameSource !== "derived" ? s.name || "" : "";
  for (const pane of tab.panes) {
    spawnSync("tmux", named ? ["set", "-p", "-t", pane, "@remote_title", named] : ["set", "-pu", "-t", pane, "@remote_title"], { stdio: "ignore", env: TMUX_ENV });
  }
  if (!s) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(MIRROR_SESSIONS, { recursive: true });
  const text = JSON.stringify({ ...s, remote: name, ...(tab.target && { tmux: tab.target }) });
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return;
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
};

const SIDEBAR_NUDGE = path.join(os.homedir(), ".local/state/tmux-sidebar/nudge");

// A Windows Claude's context use and model, from its statusline there, where
// claude/statusline-command.sh writes a local one's for the Sessions view
// (lib/sidebar/sessions.js), in the same shape, and only when it changes.
const CONTEXT_DIR = path.join(os.homedir(), ".local/state/tmux-sidebar/context");
const onContext = (event) => {
  if (!SESSION_ID.test(event.sessionId || "") || typeof event.used !== "number" || typeof event.model !== "string" || /[\t\n]/.test(event.model)) return true;
  const file = path.join(CONTEXT_DIR, event.sessionId);
  const line = `${event.used}\t${event.model}`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === line) return true;
  fs.mkdirSync(CONTEXT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, line, { mode: 0o600 });
  nudgeSidebar();
  return true;
};
const nudgeSidebar = () => {
  try {
    fs.appendFileSync(SIDEBAR_NUDGE, "\n");
  } catch {}
};

const last = new Map();
const lastFacts = new Map();
const NO_TAB = { panes: [], info: new Map() };

// False when the connection should be dropped (onTranscript).
const onEvent = (event) => {
  if (event.kind === "transcript") return onTranscript(event);
  if (event.kind === "context") return onContext(event);
  if (event.kind === "claudes") {
    // The Claudes the server runs; any other copy's Claude ended while the
    // Mac was away.
    const names = new Set(event.names || []);
    for (const name of [...sessionFiles.keys()]) if (!names.has(name)) sessionFiles.delete(name);
    let files = [];
    try {
      files = fs.readdirSync(MIRROR_SESSIONS);
    } catch {}
    for (const file of files) if (!names.has(file.replace(/\.json$/, ""))) fs.rmSync(path.join(MIRROR_SESSIONS, file), { force: true });
    nudgeSidebar();
    return true;
  }
  if (typeof event.name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(event.name)) return true;
  if (event.kind === "claude") {
    if (event.session) sessionFiles.set(event.name, event.session);
    else sessionFiles.delete(event.name);
    writeSession(event.name, tabsByName()[event.name] || NO_TAB);
    nudgeSidebar();
    return true;
  }
  if (event.kind === "set" && event.state === "clear" && event.payload?.hook_event_name === "SessionEnd") {
    sessionFiles.delete(event.name);
    writeSession(event.name, tabsByName()[event.name] || NO_TAB);
  }
  if (event.kind === "set") {
    if (event.state === "clear") last.delete(event.name);
    else last.set(event.name, event);
  }
  if (event.facts) lastFacts.set(event.name, event.facts);
  const tab = tabsByName()[event.name] || NO_TAB;
  setFacts(event.facts, tab);
  if (event.kind !== "facts") apply(event, tab.panes);
  return true;
};

// Every session's last state and facts again, for tabs opened since.
// agent-state.sh leaves a pane already in that state as it is, @agent_since
// included.
const reapply = () => {
  const tabs = tabsByName();
  for (const [name, f] of lastFacts) setFacts(f, tabs[name] || NO_TAB);
  for (const name of sessionFiles.keys()) writeSession(name, tabs[name] || NO_TAB);
  nudgeSidebar();
  for (const [name, event] of last) apply(event, (tabs[name] || NO_TAB).panes);
};

const tmuxGone = () => spawnSync("tmux", ["list-sessions"], { stdio: "ignore" }).status !== 0;

const watch = () => {
  fs.mkdirSync(MAC_STATE_DIR, { recursive: true });
  try {
    const other = running();
    if (other && other !== process.pid) return log("already running as", other);
  } catch {}
  fs.writeFileSync(WATCH_PID, String(process.pid));

  fs.closeSync(fs.openSync(NUDGE_FILE, "a"));
  fs.watch(NUDGE_FILE, () => reapply());

  let retry = RETRY_MIN_MS;
  const once = async () => {
    if (tmuxGone()) {
      log("tmux is gone; stopping");
      process.exit(0);
    }
    log("connecting");
    const began = Date.now();
    // Nobody asked for it, so it never asks for the key again soon after it
    // was refused (ensureMaster in client.js).
    const { ssh, done } = await connect({ op: "watch", have: haveNow() }, (type, body) => {
      if (type !== TYPES.event) return;
      let ok = true;
      try {
        ok = onEvent(json(body));
      } catch (err) {
        log("event", err.message);
      }
      if (!ok) ssh.kill();
    }, { background: true });
    done.then(({ code, stderr }) => {
      log("disconnected", code, (stderr || "").split("\n").filter((l) => /ssh|denied|resolve|refused|timed out/i.test(l)).join(" | "));
      // A connection that held a while was fine; one that failed at once waits
      // longer each time, up to a minute.
      retry = Date.now() - began > 30_000 ? RETRY_MIN_MS : Math.min(retry * 2, RETRY_MAX_MS);
      setTimeout(once, retry);
    });
  };
  once();
};

module.exports = { watch, start };
