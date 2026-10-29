// Part of bin/remote-winmux; see the comment at the top of that file.
//
// The bridge, on Windows: what `ssh -T` runs for the Mac. It reads the Mac's
// request from stdin, checks it, sends it to the server with the token, and
// from then on passes bytes between stdio and the pipe unchanged. The Mac never
// names the token or builds a command line, so nothing it sends is run.

const fs = require("node:fs");
const net = require("node:net");
const { TYPES, encode, Decoder, json } = require("./frames");
const { TOKEN_FILE, PIPE, checkRequest } = require("./config");

// `retry` says it is no refusal, only "not now": the server isn't running, as
// while it restarts, so a tab reconnecting keeps trying (client.js's attach).
const fail = (message, retry = false) => {
  process.stdout.write(encode(TYPES.error, { message, ...(retry && { retry }) }));
  process.exit(1);
};

const bridge = () => {
  let token;
  try {
    token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    fail("the server isn't running (no token)", true);
  }

  let started = false;
  const decoder = new Decoder((type, body) => {
    started = true;
    decoder.stop();
    if (type !== TYPES.request) fail("the first frame must be the request");
    let request;
    try {
      request = checkRequest(json(body));
    } catch (err) {
      fail(err.message);
    }
    // Events come from Claude's hooks on this machine (hook.js), never over SSH.
    if (request.op === "event" || request.op === "context") fail("events can't come from another machine");
    process.stdin.removeListener("data", onData);
    process.stdin.pause();

    const pipe = net.connect(PIPE);
    pipe.on("error", (err) => fail(err.code === "ENOENT" ? "the server isn't running" : err.message, err.code === "ENOENT"));
    pipe.on("connect", () => {
      pipe.write(encode(TYPES.hello, { token, request }));
      const rest = decoder.rest();
      if (rest.length) pipe.write(rest);
      // When the Mac hangs up, the pipe's end follows stdin's, and the bridge
      // waits for the server's answer (ls, kill) before it exits. When sshd
      // doesn't pass the hang-up on, the server's DEAD_MS ends it.
      process.stdin.pipe(pipe);
      pipe.pipe(process.stdout);
    });
    pipe.on("close", () => process.exit(0));
  });
  const onData = (chunk) => {
    try {
      decoder.push(chunk);
    } catch (err) {
      fail(err.message);
    }
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", () => started || process.exit(0));
};

module.exports = { bridge };
