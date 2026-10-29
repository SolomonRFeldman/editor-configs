// Part of bin/remote-winmux; see the comment at the top of that file.
//
// The server, on Windows. It keeps each session's program running in a
// ConPTY, and a headless terminal beside it holding the screen, so a client
// that attaches later is drawn the screen as it is now. It listens only on a
// named pipe, never on the network, and answers only a client whose first
// frame is a hello carrying the token.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { TYPES, PING_MS, DEAD_MS, encode, Decoder, json } = require("./frames");
const { STATE_DIR, TOKEN_FILE, LOG_FILE, MAX_LOG_BYTES, PIPE, HELLO_TIMEOUT_MS, SESSION_ID, checkRequest, tailHash, programFor } = require("./config");

const log = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.join(" ")}\n`;
  try {
    if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
  fs.appendFileSync(LOG_FILE, line);
};

// A new token on every start, readable by this account alone: inheritance is
// cut and only the user is granted access, so not even a process running as
// another user on this machine can read it. The account is named by its SID,
// since USERDOMAIN is WORKGROUP under sshd and icacls can't find that name. If
// the permissions can't be set the server doesn't start.
const writeToken = () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim().split(",").pop().replace(/"/g, "");
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error(`whoami gave no SID (${sid})`);
  fs.writeFileSync(TOKEN_FILE, "");
  execFileSync("icacls", [TOKEN_FILE, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: "ignore" });
  fs.writeFileSync(TOKEN_FILE, token);
  return Buffer.from(token);
};

// The program's full path, from PATH as the server started with it.
const resolve = (exe) => {
  for (const dir of (process.env.Path || process.env.PATH || "").split(";")) {
    if (!dir) continue;
    const file = path.join(dir, exe);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`${exe} is not on the server's PATH`);
};

const sessions = new Map();
const ALONE_MS = 12 * 60 * 60_000;

// The headless conhost.exe processes this server has started, one per
// pseudo-console, newest first, as pids. Asked of Windows in the background:
// the server's one thread never waits on it.
const conhosts = () =>
  new Promise((resolve) =>
    execFile("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'conhost.exe'" | Sort-Object CreationDate -Descending | ForEach-Object ProcessId`],
    { timeout: 15_000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).split(/\s+/).filter(Boolean).map(Number))));
// A new session's: the newest of them no other session holds. The pseudo-
// console starts its host before spawn returns, so asked any time after, it
// is there. Sessions start one at a time, each after its own look, so two
// can't take the same one.
let looking = Promise.resolve();
const newConhost = (name) => {
  const found = looking.then(async () => {
    const now = await conhosts();
    if (!now) return null;
    const others = [...sessions.values()].filter((s) => s.name !== name);
    const taken = new Set(await Promise.all(others.map((s) => s.conhost)));
    return now.find((pid) => !taken.has(pid)) ?? null;
  });
  looking = found.catch(() => null);
  return found;
};

// Claude's state in each session, from its hooks: the last `set` event per
// session, sent to a Mac when it starts watching, and every event as it comes
// to the Macs watching (tmux/agent-state.sh runs it there).
const lastSet = new Map();
const lastContext = new Map();
const watchers = new Set();

// What the Mac's second status line and tab name show for a session, which
// it can't work out itself: the folder's git branch, its origin (which the
// Mac's stand-in for the repository takes, so gh finds the branch's PR there),
// the commits not pushed yet, whether Claude is running (rather than the
// PowerShell it runs in), and the last prompt of three words or more, as
// tab-status.sh shows a local one. Every event carries them, and a watch
// starts with them.
const facts = new Map();
const GIT_FRESH_MS = 5_000;
const GIT_POLL_MS = 5_000;
const git = (cwd, args) =>
  new Promise((resolve) =>
    execFile("git", ["-C", cwd, "--no-optional-locks", ...args], { timeout: 2_000, windowsHide: true }, (err, out) => resolve(err ? "" : String(out).trim())));
const gitOf = async (session) => {
  if (session.gitAt && Date.now() - session.gitAt < GIT_FRESH_MS) return session.git;
  const [branch, origin, upstream] = await Promise.all([
    git(session.cwd, ["branch", "--show-current"]),
    git(session.cwd, ["remote", "get-url", "origin"]),
    git(session.cwd, ["rev-list", "--count", "@{upstream}..HEAD"]),
  ]);
  // Against origin's copy of the branch when it has no upstream, as
  // tab-status.sh counts a local one.
  const ahead = upstream || (branch && /^[A-Za-z0-9._/-]+$/.test(branch) ? await git(session.cwd, ["rev-list", "--count", `origin/${branch}..HEAD`]) : "");
  session.git = { branch, origin, ahead: /^\d+$/.test(ahead) ? Number(ahead) : null };
  session.gitAt = Date.now();
  return session.git;
};
const factsFor = async (event) => {
  const session = sessions.get(event.name);
  const was = facts.get(event.name) || { claude: false, prompt: "", branch: "", origin: "", ahead: null };
  const hookName = event.payload?.hook_event_name;
  const ended = hookName === "SessionEnd";
  let prompt = was.prompt;
  if (ended || hookName === "SessionStart") prompt = "";
  else if (hookName === "UserPromptSubmit") {
    const text = String(event.payload.prompt || "").replace(/\s+/g, " ").trim();
    if (text.split(" ").length >= 3) prompt = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  }
  const { branch, origin, ahead } = session ? await gitOf(session) : was;
  // Facts sent for no hook (GIT_POLL_MS) leave Claude as it was.
  const next = { claude: ended ? false : hookName ? true : was.claude, prompt, branch, origin, ahead };
  if (session) facts.set(event.name, next);
  else facts.delete(event.name);
  return next;
};

// The Mac keeps a copy of each session's Claude session file and transcript
// (watch.js), so its sidebar reads them as it reads a local Claude's. Which
// Claude a session runs comes from its hooks: name -> { sessionId,
// transcript, file, json }. A session's file is found among
// ~/.claude/sessions/*.json by its ID, and sent again whenever it changes;
// each transcript is sent on from the size each watcher's copy has reached
// (socket.have, from the watch request), checked every SYNC_MS, so nothing
// rests on any one message arriving: a connection lost midway starts again
// from what reached the Mac.
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const claudes = new Map();
const SYNC_MS = 500;
const CHUNK_BYTES = 1024 * 1024;
const BACKLOG_BYTES = 8 * 1024 * 1024;

const noteClaude = (name, payload) => {
  const sessionId = payload?.session_id;
  const transcript = payload?.transcript_path;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || typeof transcript !== "string") return;
  // Only Claude's own transcripts are ever sent.
  const resolved = path.resolve(transcript);
  if (!resolved.toLowerCase().startsWith(path.join(CLAUDE_HOME, "projects").toLowerCase() + path.sep) || !resolved.endsWith(".jsonl")) return;
  const was = claudes.get(name);
  if (was?.sessionId === sessionId) return;
  claudes.set(name, { sessionId, transcript: resolved, cwd: sessions.get(name)?.cwd, file: null, json: null });
};

// What the sidebar reads of a session file, and nothing else of it.
const SESSION_FIELDS = ["sessionId", "cwd", "name", "nameSource", "startedAt", "status", "kind", "entrypoint", "jobId", "parkedJobId", "version"];
const sessionFileFor = (claude) => {
  const read = (file) => {
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8"));
      return s?.sessionId === claude.sessionId ? s : null;
    } catch {
      return null;
    }
  };
  if (claude.file) {
    const s = read(claude.file);
    if (s) return s;
  }
  const dir = path.join(CLAUDE_HOME, "sessions");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {}
  for (const n of names) {
    const s = read(path.join(dir, n));
    if (s) {
      claude.file = path.join(dir, n);
      return s;
    }
  }
  claude.file = null;
  return null;
};
const claudeEvent = (name, claude) => ({ name, kind: "claude", session: claude.json ? JSON.parse(claude.json) : null, cwd: claude.cwd });

// The transcript's bytes a watcher hasn't got, a chunk at a time.
const sendTranscript = (socket, name, claude) => {
  let fd;
  try {
    fd = fs.openSync(claude.transcript, "r");
  } catch {
    return;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let at = socket.have.get(claude.sessionId);
    if (at === undefined) {
      // From the watch request: the copy counts only if it is this file's start.
      const had = socket.had?.[claude.sessionId];
      at = had && had.size <= size && tailHash(fd, had.size) === had.tail ? had.size : 0;
    } else if (at > size) at = 0;
    while (at < size && socket.writableLength < BACKLOG_BYTES) {
      const buf = Buffer.alloc(Math.min(size - at, CHUNK_BYTES));
      const n = fs.readSync(fd, buf, 0, buf.length, at);
      if (!n) break;
      socket.write(encode(TYPES.event, { name, kind: "transcript", sessionId: claude.sessionId, cwd: claude.cwd, offset: at, data: buf.subarray(0, n).toString("base64") }));
      at += n;
    }
    socket.have.set(claude.sessionId, at);
  } finally {
    fs.closeSync(fd);
  }
};

const sync = () => {
  for (const [name, claude] of claudes) {
    const s = sessionFileFor(claude);
    const json = s ? JSON.stringify(Object.fromEntries(SESSION_FIELDS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]))) : null;
    if (json !== claude.json) {
      claude.json = json;
      const frame = encode(TYPES.event, claudeEvent(name, claude));
      for (const socket of watchers) socket.write(frame);
    }
    for (const socket of watchers) sendTranscript(socket, name, claude);
  }
};

// In the order they came, though working out the facts may wait on git.
let publishing = Promise.resolve();
const publish = (event) => {
  publishing = publishing.then(async () => {
    event.facts = await factsFor(event);
    if (event.kind === "set") {
      if (event.state === "clear") lastSet.delete(event.name);
      else lastSet.set(event.name, event);
    }
    const frame = encode(TYPES.event, event);
    for (const socket of watchers) socket.write(frame);
  }).catch((err) => log("publish", err.message));
};

const startSession = (name, program, cwd, cols, rows, resume, claudeSession) => {
  const pty = require("node-pty");
  const { Terminal } = require("@xterm/headless");
  const { SerializeAddon } = require("@xterm/addon-serialize");

  const { exe, args } = programFor(program, { resume, session: claudeSession });
  // REMOTE_WINMUX_SESSION tells Claude's hooks (hook.js) whose events theirs are.
  const env = { ...process.env, REMOTE_WINMUX_SESSION: name };
  const term = pty.spawn(resolve(exe), args, { name: "xterm-256color", cols, rows, cwd, env });
  const screen = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  const serializer = new SerializeAddon();
  screen.loadAddon(serializer);

  const session = { name, program, cwd, term, screen, serializer, clients: new Set(), started: Date.now(), alone: Date.now(), conhost: newConhost(name) };
  term.onData((data) => {
    screen.write(data);
    const frame = encode(TYPES.output, data);
    for (const client of session.clients) client.write(frame);
  });
  term.onExit(({ exitCode }) => {
    log("exit", name, exitCode);
    sessions.delete(name);
    // The last of its transcript first.
    try {
      sync();
    } catch {}
    claudes.delete(name);
    lastContext.delete(name);
    // node-pty leaves the pseudo-console's host (a headless conhost.exe)
    // running after the program exits. Closing the pseudo-console then
    // (term.kill) hangs the server: it waits for the host to drain output
    // nothing reads any more. So the host is ended by its pid instead.
    session.conhost.then((pid) => {
      if (!pid) return;
      try {
        process.kill(pid);
      } catch {}
    });
    // Claude may not have said so on its way out.
    publish({ name, kind: "set", state: "clear", payload: { hook_event_name: "SessionEnd" } });
    for (const client of session.clients) client.end(encode(TYPES.exit, { code: exitCode }));
  });
  sessions.set(name, session);
  log("start", name, program, JSON.stringify(cwd), term.pid);
  session.conhost.then((pid) => log("conhost", name, pid ?? "not found"));
  return session;
};

// The last client to attach or resize sets the size, as tmux's latest-client
// sizing does.
const resize = (session, cols, rows) => {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 1000) return;
  if (cols === session.term.cols && rows === session.term.rows) return;
  session.term.resize(cols, rows);
  session.screen.resize(cols, rows);
};

const attach = (socket, req, decoder, size) => {
  let session = sessions.get(req.name);
  if (!session) {
    if (!req.cwd) throw new Error(`no session ${req.name}, and no cwd to start one in`);
    if (!fs.statSync(req.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${req.cwd} is not a directory`);
    session = startSession(req.name, req.program || "claude", req.cwd, size.cols, size.rows, req.resume, req.session);
  } else {
    resize(session, size.cols, size.rows);
    // Clear the client's screen, then draw this one as it stands.
    socket.write(encode(TYPES.output, `\x1b[H\x1b[2J${session.serializer.serialize()}`));
  }
  session.clients.add(socket);
  log("attach", req.name, session.clients.size);

  const keys = new StringDecoder("utf8");
  decoder.onFrame = (type, body) => {
    if (type === TYPES.input) session.term.write(keys.write(body));
    else if (type === TYPES.resize) {
      const { cols, rows } = json(body);
      resize(session, cols, rows);
    } else if (type === TYPES.ping) {
      // From then on it is dropped if it falls silent; a client from before
      // the pings never is.
      socket.pings = true;
    }
  };
  socket.on("close", () => {
    session.clients.delete(socket);
    if (!session.clients.size) session.alone = Date.now();
    log("detach", req.name, session.clients.size);
  });
};

const handle = (req, socket, decoder, size) => {
  if (req.op === "ls") {
    const list = [...sessions.values()].map((s) => ({
      name: s.name, program: s.program, cwd: s.cwd, pid: s.term.pid, clients: s.clients.size, started: s.started,
    }));
    socket.end(encode(TYPES.reply, list));
  } else if (req.op === "watch") {
    watchers.add(socket);
    socket.on("close", () => watchers.delete(socket));
    socket.have = new Map();
    socket.had = req.have;
    // Each Claude this server runs, then which they are, so the Mac forgets
    // any it had that ended while it was away; their transcripts follow.
    for (const [name, claude] of claudes) socket.write(encode(TYPES.event, claudeEvent(name, claude)));
    socket.write(encode(TYPES.event, { kind: "claudes", names: [...claudes.keys()] }));
    for (const [name, claude] of claudes) sendTranscript(socket, name, claude);
    for (const event of lastSet.values()) socket.write(encode(TYPES.event, event));
    for (const event of lastContext.values()) socket.write(encode(TYPES.event, event));
    // A session whose Claude is between turns or not yet asked anything has
    // no state to send, but its tab still wants its branch and program.
    for (const [name, f] of facts) {
      if (!lastSet.has(name)) socket.write(encode(TYPES.event, { name, kind: "facts", facts: f }));
    }
    log("watch", watchers.size);
  } else if (req.op === "context") {
    // As for events: only a session this server runs. The last one each is
    // kept for a Mac that starts watching later.
    if (sessions.has(req.name)) {
      const event = { name: req.name, kind: "context", sessionId: req.sessionId, used: req.used, model: req.model };
      lastContext.set(req.name, event);
      const frame = encode(TYPES.event, event);
      for (const watcher of watchers) watcher.write(frame);
    }
    socket.end();
  } else if (req.op === "event") {
    // Only for a session this server runs, so nothing else can mark a tab.
    if (sessions.has(req.name)) noteClaude(req.name, req.payload);
    if (sessions.has(req.name)) publish({ name: req.name, kind: req.kind, state: req.state, payload: req.payload });
    socket.end();
  } else if (req.op === "kill") {
    const session = sessions.get(req.name);
    if (!session) throw new Error(`no session ${req.name}`);
    session.term.kill();
    socket.end(encode(TYPES.reply, { killed: req.name }));
  } else {
    attach(socket, req, decoder, size);
  }
};

const serve = () => {
  const token = writeToken();
  const server = net.createServer((socket) => {
    let proven = false;
    let req = null;
    const refuse = (message) => {
      log("refused", message);
      socket.end(encode(TYPES.error, { message }));
    };
    const timer = setTimeout(() => proven || socket.destroy(), HELLO_TIMEOUT_MS);

    const decoder = new Decoder((type, body) => {
      if (!proven) {
        // The first frame is the hello, or the client is dropped without an
        // answer, so a stranger learns nothing from the pipe.
        const hello = type === TYPES.hello ? json(body) : null;
        const given = Buffer.from(String(hello?.token ?? ""));
        if (given.length !== token.length || !crypto.timingSafeEqual(given, token)) {
          log("bad hello");
          socket.destroy();
          return;
        }
        proven = true;
        clearTimeout(timer);
        try {
          req = checkRequest(hello.request);
        } catch (err) {
          refuse(err.message);
          return;
        }
        if (req.op !== "attach") {
          handle(req, socket, decoder, null);
          decoder.onFrame = (t) => {
            if (t === TYPES.ping) socket.pings = true;
          };
        }
        return;
      }
      // An attach waits for its first size before it starts or draws anything.
      if (type === TYPES.resize) {
        const size = json(body);
        try {
          handle(req, socket, decoder, size);
        } catch (err) {
          refuse(err.message);
        }
      }
    });
    socket.on("data", (chunk) => {
      socket.heard = Date.now();
      try {
        decoder.push(chunk);
      } catch (err) {
        log("bad frame", err.message);
        socket.destroy();
      }
    });
    socket.on("error", () => {});
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error("remote-winmux: a server is already running");
      process.exit(1);
    }
    throw err;
  });
  server.listen(PIPE, () => log("listening", PIPE, process.pid));

  // An attach or watch the Mac stopped pinging is gone, though its bridge
  // still holds the pipe: dropping it ends the bridge too (see DEAD_MS).
  setInterval(() => {
    const now = Date.now();
    for (const socket of [...watchers, ...[...sessions.values()].flatMap((s) => [...s.clients])]) {
      if (socket.pings && now - socket.heard > DEAD_MS) {
        log("dropped a silent client");
        socket.destroy();
      }
    }
    // A tab closed ends its session (client.js), so one left with no tab for
    // ALONE_MS lost its tab some other way (the Mac died with it), as a local
    // Claude would have died with it. A tab that comes back after all starts
    // it again where it left off (RESUMED in config.js).
    for (const session of sessions.values()) {
      if (!session.clients.size && now - session.alone > ALONE_MS) {
        log("ended", session.name, "after", Math.round((now - session.alone) / 3_600_000), "hours with no tab");
        session.term.kill();
      }
    }
  }, PING_MS).unref();
  // A branch changed in a PowerShell beside Claude, or with no Claude at all,
  // reaches the tab within GIT_POLL_MS, as a local tab follows its branch.
  setInterval(() => {
    for (const session of sessions.values()) {
      const was = facts.get(session.name);
      gitOf(session).then((g) => {
        if (!sessions.has(session.name)) return;
        if (!was || was.branch !== g.branch || was.origin !== g.origin || was.ahead !== g.ahead) publish({ name: session.name, kind: "facts" });
      }).catch(() => {});
    }
  }, GIT_POLL_MS).unref();
  setInterval(() => {
    try {
      sync();
    } catch (err) {
      log("sync", err.message);
    }
  }, SYNC_MS).unref();
};

module.exports = { serve };
