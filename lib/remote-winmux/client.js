// Part of bin/remote-winmux; see the comment at the top of that file.
//
// The Mac side. Every command is one `ssh -T` to the machine in config.json,
// running the bridge, with the request sent as the first frame. -T because
// without a pseudo-terminal Windows's sshd passes the bytes through as they
// are, where with one it would draw them again through a ConPTY of its own.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { TYPES, PING_MS, encode, Decoder, json } = require("./frames");
const { loadConfig, checkRequest, MAC_STATE_DIR } = require("./config");

// The shared connection's socket, in ~/.ssh, which only you can open: %C, a
// hash of the host, user and port, and a short directory keep it short of the
// 104 bytes a Unix socket's path may be on macOS, with the 17 ssh adds while
// it makes one.
const CONTROL_PATH = path.join(os.homedir(), ".ssh", "wm-%C");

// The shared connection is the only ssh that ever signs in with the key, so
// an agent that has you approve each use (1Password's) asks once, however
// many tabs, splits, closes and watchers want Windows at the same moment, as
// they all do after the network drops. One process at a time may start it
// (MASTER_LOCK); the rest wait for it and join it, and a command never signs
// in on its own (ControlMaster=no). When the key is refused, the master
// failing says so (KEY_REFUSED), and nothing in the background asks again
// for REFUSED_WAIT_MS; something you do (a new tab, ls, a key pressed in a
// tab waiting to reconnect) asks again at once, unless a refusal came in the
// last REFUSED_NOW_MS, which is the same request you just turned down.
const MASTER_LOCK = path.join(MAC_STATE_DIR, "master.lock");
const KEY_REFUSED = path.join(MAC_STATE_DIR, "key-refused");
const REFUSED_WAIT_MS = 10 * 60_000;
const REFUSED_NOW_MS = 30_000;
// Longer than an approval is ever left waiting, so a lock left by a process
// that died is taken over.
const LOCK_STALE_MS = 2 * 60_000;
const REFUSED = /agent refused operation|Permission denied \(publickey|sign_and_send_pubkey|Too many authentication failures/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One local call to the master, which answers from its socket.
const masterUp = (host) => spawnSync("ssh", ["-O", "check", "-o", `ControlPath=${CONTROL_PATH}`, host], { stdio: "ignore" }).status === 0;

// The socket's path as ssh expands %C for the host, for removing one left by
// a master that died, which would otherwise make the next master run without
// multiplexing and every command sign in again.
const socketPath = (host) => {
  const out = spawnSync("ssh", ["-G", "-o", `ControlPath=${CONTROL_PATH}`, host], { encoding: "utf8" }).stdout || "";
  return /^controlpath (.+)$/m.exec(out)?.[1];
};

const refusedWithin = (ms) => {
  try {
    return Date.now() - fs.statSync(KEY_REFUSED).mtimeMs < ms;
  } catch {
    return false;
  }
};

const takeLock = () => {
  fs.mkdirSync(MAC_STATE_DIR, { recursive: true });
  try {
    fs.writeFileSync(MASTER_LOCK, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  let alive = false;
  try {
    const pid = Number(fs.readFileSync(MASTER_LOCK, "utf8"));
    alive = pid > 0 && Date.now() - fs.statSync(MASTER_LOCK).mtimeMs < LOCK_STALE_MS && (process.kill(pid, 0), true);
  } catch {}
  if (!alive) fs.rmSync(MASTER_LOCK, { force: true });
  return false;
};
const dropLock = () => {
  try {
    if (fs.readFileSync(MASTER_LOCK, "utf8") === String(process.pid)) fs.rmSync(MASTER_LOCK);
  } catch {}
};

// The master: it signs in (the one approval), then goes to the background (-f)
// and stays while any command uses it and an hour after. Its keepalives are
// these, not your ssh config's: a master to a machine that went away holds
// every command handed to it until it notices, and this one notices within 30
// seconds. ConnectTimeout, so an unreachable machine (asleep, off Tailscale)
// is said to be in seconds rather than after TCP gives up.
const startMaster = (host) => new Promise((resolve) => {
  const ssh = spawn("ssh", ["-M", "-N", "-f", "-o", `ControlPath=${CONTROL_PATH}`, "-o", "ControlPersist=1h",
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", host], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  ssh.stderr.on("data", (d) => (stderr += d));
  ssh.on("error", (err) => resolve({ code: 255, stderr: err.message }));
  // The master keeps stderr open once it is in the background, so this waits
  // for the process ssh started as, not for the stream to close.
  ssh.on("exit", (code) => setTimeout(() => {
    ssh.stderr.destroy();
    resolve({ code, stderr });
  }, 50));
});

// Makes sure the master is up, starting it if this process is the one to.
// Resolves with null once it is, or with why not.
const ensureMaster = async (host, { background = false } = {}) => {
  const refusal = () => refusedWithin(background ? REFUSED_WAIT_MS : REFUSED_NOW_MS) &&
    `the key was refused; asking again in ${background ? "a few minutes, or press a key here" : "a moment"}`;
  for (;;) {
    if (masterUp(host)) return null;
    if (refusal()) return refusal();
    if (takeLock()) {
      try {
        if (masterUp(host)) return null;
        if (refusal()) return refusal();
        const stale = socketPath(host);
        if (stale) fs.rmSync(stale, { force: true });
        fs.mkdirSync(path.dirname(CONTROL_PATH), { recursive: true, mode: 0o700 });
        const { code, stderr } = await startMaster(host);
        if (code === 0 && masterUp(host)) {
          fs.rmSync(KEY_REFUSED, { force: true });
          return null;
        }
        if (REFUSED.test(stderr)) fs.writeFileSync(KEY_REFUSED, "");
        return stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "ssh failed";
      } finally {
        dropLock();
      }
    }
    // Another process is starting it, perhaps waiting on your approval.
    await sleep(300);
  }
};

// The bridge's command line, for the PowerShell sshd starts: the repository's
// path is the only thing in it, quoted as PowerShell quotes ('' for ').
const bridgeCommand = (repo) => `& node '${repo.replace(/'/g, "''")}\\bin\\remote-winmux' bridge`;

// Leaves the terminal as it was, whatever modes the program turned on.
const RESET = "\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u\x1b[?25h\x1b[0m\r\n";

// Runs one request; resolves with the exit code once the connection closes.
// onFrame(type, body) gets each frame the server sends. background, for a
// reconnect nobody asked for, keeps it from asking for the key again soon
// after it was refused (ensureMaster). Without the shared connection there
// is no ssh, and done gives 255 and why.
const connect = async (request, onFrame, { quiet = false, background = false } = {}) => {
  const { host, repo } = loadConfig();
  checkRequest(request);
  const why = await ensureMaster(host, { background });
  if (why) {
    if (!quiet) process.stderr.write(`${why}\n`);
    return { ssh: null, done: Promise.resolve({ code: 255, stderr: why }) };
  }
  // Only ever through the master: a command that signed in on its own would
  // ask for the key once more. ssh falls back to signing in when the master
  // has just gone, so a command is given nothing to sign in with, and fails
  // instead; its retry starts a new master.
  const ssh = spawn("ssh", ["-T", "-o", "ControlMaster=no", "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", "BatchMode=yes", "-o", "IdentityAgent=none", "-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    host, bridgeCommand(repo)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  ssh.stderr.on("data", (d) => (stderr += d));
  const decoder = new Decoder(onFrame);
  ssh.stdout.on("data", (chunk) => decoder.push(chunk));
  ssh.stdin.write(encode(TYPES.request, request));
  ssh.stdin.on("error", () => {});
  // The connections that stay open say they're alive (see DEAD_MS).
  const ping = (request.op === "attach" || request.op === "watch") &&
    setInterval(() => ssh.stdin.writable && ssh.stdin.write(encode(TYPES.ping, "")), PING_MS);
  return {
    ssh,
    done: new Promise((resolve) =>
      ssh.on("close", (code) => {
        if (ping) clearInterval(ping);
        // Your PowerShell profile's complaints aren't worth showing, only an
        // ssh that failed on its own.
        if (code === 255 && !quiet) process.stderr.write(stderr);
        resolve({ code, stderr });
      })),
  };
};

// What Claude on Windows copies reaches the Mac as OSC 52 (ESC ] 52 ; c ;
// <base64> BEL or ESC \), since it doesn't know it is in tmux. tmux's
// set-clipboard external ignores that from a program, so the client copies it
// itself, as local Claude does, with `tmux load-buffer -w`, which tmux passes on
// to the terminal's clipboard; outside tmux, with pbcopy. Only this session's
// own output is read, so nothing else gains a way to set the clipboard. A
// sequence split across frames is kept until its end arrives.
const OSC52 = /\x1b\]52;[a-z]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;
const OSC52_WHOLE = /^\x1b\]52;[a-z]*;[A-Za-z0-9+/=]*(?:\x07|\x1b\\)/;
const OSC52_START = "\x1b]52;";
const MAX_OSC52 = 1024 * 1024;
const toClipboard = (text) => {
  const [cmd, args] = process.env.TMUX ? ["tmux", ["load-buffer", "-w", "-"]] : ["pbcopy", []];
  const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stdin.end(text);
};
const copier = (copy = toClipboard) => {
  let carry = "";
  return (chunk) => {
    const text = carry + chunk.toString("latin1");
    carry = "";
    for (const m of text.matchAll(OSC52)) {
      const copied = Buffer.from(m[1], "base64").toString("utf8");
      if (copied) copy(copied);
    }
    // An unfinished sequence at the end waits for the next frame.
    const start = text.lastIndexOf(OSC52_START);
    if (start >= 0 && !OSC52_WHOLE.test(text.slice(start)) && text.length - start < MAX_OSC52) carry = text.slice(start);
  };
};

// A connection that drops is made again, as long as it takes, the way a local
// tab's session is just there when you come back: the session runs on in the
// meantime (only its program exiting, or kill, ends it), and the server draws
// its screen on the new attach. If it ended while the Mac was away (Windows or
// the server restarted), the reattach starts it again with `resume`, which
// picks up the folder's last conversation (RESUMED in config.js). Only the
// program exiting, or the request being refused, ends the attach.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;
const DIM = "\x1b[2m";
const PLAIN = "\x1b[0m";

// resume, from the start: a tab tmux-resurrect brings back
// (tmux/remote-tab.zsh restore), whose session may have ended with the Mac.
const attach = async (name, { cwd, program, resume: resumeFirst = false, session } = {}) => {
  const clipboard = copier();
  let current = null;
  const send = (type, body) => current?.stdin.writable && current.stdin.write(encode(type, body));
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  process.stdout.on("resize", () => send(TYPES.resize, size()));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  // Typed while there is no connection, it has nowhere to go, but it says
  // to reconnect now, asking for the key if need be.
  let wake = null;
  process.stdin.on("data", (d) => (current ? send(TYPES.input, d) : wake?.()));

  // Closing the tab ends its Claude, as closing a local tab does: tmux sends
  // the pane's program SIGHUP when the pane is closed (or the tmux server
  // stops), never when the network drops or the terminal window closes, so a
  // lost connection still only detaches.
  // The pane's terminal is gone by then, and opening it again, as Node does
  // the first time anything writes to stderr, blocks for good on macOS; so
  // nothing on the way out writes, and SIGKILL ends it if anything blocks
  // anyway, as process.exit can while it flushes to the terminal.
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 10_000).unref();
    current?.kill();
    await Promise.race([ask({ op: "kill", name }, { quiet: true }).catch(() => {}), new Promise((r) => setTimeout(r, 8_000))]);
    process.kill(process.pid, "SIGKILL");
  };
  process.on("SIGHUP", close);
  process.on("SIGTERM", close);
  // The pane's terminal is gone once it closes; writing to it mustn't stop the
  // session being ended.
  process.stdout.on("error", () => {});
  process.stdin.on("error", () => {});

  let retry = RETRY_MIN_MS;
  let attempt = 0;
  let resume = resumeFirst;
  let pressed = false;
  for (;;) {
    let exitCode = null;
    let refused = null;
    let notYet = null;
    let heard = false;
    const began = Date.now();
    // A reconnect is the background's unless you pressed a key for it.
    const { ssh, done } = await connect({ op: "attach", name, cwd, program, ...(resume && { resume }), ...(session && { session }) }, (type, body) => {
      heard = true;
      if (type === TYPES.output) {
        process.stdout.write(body);
        clipboard(body);
      } else if (type === TYPES.exit) exitCode = json(body).code;
      else if (type === TYPES.error) {
        // The server isn't running yet, as while it restarts: try again.
        const { message, retry: later } = json(body);
        if (later) notYet = message;
        else refused = message;
      }
    }, { quiet: true, background: attempt > 0 && !pressed });
    current = ssh;
    send(TYPES.resize, size());
    const { stderr } = await done;
    current = null;
    // Closed: close() ends the session and the process.
    if (closing) return new Promise(() => {});

    if (exitCode !== null || refused) {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(RESET);
      if (refused) console.error(`remote-winmux: ${refused}`);
      return refused ? 1 : exitCode;
    }
    // Lost. A connection that held a while starts the waits over.
    if (heard && Date.now() - began > 30_000) retry = RETRY_MIN_MS;
    attempt++;
    const why = notYet || (stderr || "").split("\n").map((l) => l.trim()).filter((l) => /ssh|denied|resolve|refused|timed out|closed/i.test(l)).pop();
    process.stdout.write(`\r\n${DIM}  remote-winmux: the connection to Windows was lost${why ? ` (${why})` : ""}; reconnecting in ${Math.round(retry / 1000)}s (attempt ${attempt}), or press a key…${PLAIN}\r\n`);
    pressed = await new Promise((r) => {
      const timer = setTimeout(() => r(false), retry);
      wake = () => {
        clearTimeout(timer);
        r(true);
      };
    });
    wake = null;
    retry = Math.min(retry * 2, RETRY_MAX_MS);
    // If the session is gone by then, it is started again where it left off.
    resume = true;
  }
};

// ls and kill: one reply, or an error. quiet leaves ssh's complaints unsaid.
const ask = async (request, { quiet = false } = {}) => {
  let reply = null;
  let refused = null;
  const { ssh, done } = await connect(request, (type, body) => {
    if (type === TYPES.reply) reply = json(body);
    else if (type === TYPES.error) refused = json(body).message;
  }, { quiet });
  ssh?.stdin.end();
  const { code } = await done;
  if (code === 255) throw new Error(`can't reach ${loadConfig().host} (ssh failed; is the machine awake and on Tailscale?)`);
  if (refused) throw new Error(refused);
  if (reply === null) throw new Error("no answer from the server");
  return reply;
};

module.exports = { attach, ask, connect, ensureMaster, bridgeCommand, copier };
