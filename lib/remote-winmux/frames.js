// Part of bin/remote-winmux; see the comment at the top of that file.
//
// Everything between the Mac and the server travels as frames: one byte for
// the type, four for the length (big-endian), then the body. The bridge on
// Windows passes them through unchanged, after its own hello.

const TYPES = {
  input: 0, // Mac -> server: keys, as typed
  resize: 1, // Mac -> server: {"cols", "rows"}
  request: 2, // Mac -> bridge: what to do (see config.js's checkRequest)
  hello: 3, // bridge -> server: the request plus the token
  output: 4, // server -> Mac: what the program drew
  exit: 5, // server -> Mac: {"code"}, the program ended
  reply: 6, // server -> Mac: the answer to ls or kill
  error: 7, // server -> Mac: {"message"}, the request was refused
  event: 8, // server -> Mac (watch): {"name", "kind", "state", "payload"}, a Claude hook
  ping: 9, // Mac -> server, every PING_MS while attached or watching
};

// A connection that died without closing (the Mac slept, the network moved)
// leaves its bridge running on Windows, since sshd doesn't end a session's
// processes; the server drops a client it hasn't heard from in DEAD_MS, and
// the bridge exits with it.
const PING_MS = 30_000;
const DEAD_MS = 90_000;

// Larger than any paste, small enough that a bad length can't exhaust memory.
const MAX_FRAME = 4 * 1024 * 1024;

const encode = (type, body) => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
};

// Feed it chunks as they arrive; it calls onFrame(type, body) for each whole
// frame, and throws on a frame over MAX_FRAME or of no known type.
class Decoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
    this.stopped = false;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.stopped && this.buf.length >= 5) {
      const type = this.buf[0];
      const len = this.buf.readUInt32BE(1);
      if (!Object.values(TYPES).includes(type)) throw new Error(`unknown frame type ${type}`);
      if (len > MAX_FRAME) throw new Error(`frame of ${len} bytes is over the limit`);
      if (this.buf.length < 5 + len) return;
      const body = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      this.onFrame(type, body);
    }
  }

  // For the bridge, which stops decoding after the request and passes what
  // came after it through as it is.
  stop() {
    this.stopped = true;
  }

  rest() {
    return this.buf;
  }
}

const json = (body) => JSON.parse(body.toString("utf8"));

module.exports = { TYPES, MAX_FRAME, PING_MS, DEAD_MS, encode, Decoder, json };
