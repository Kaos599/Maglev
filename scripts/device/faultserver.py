#!/usr/bin/env python3
"""Fault-injecting LAN server for Maglev link-download tests (used by test-link-faults.sh).

    python3 faultserver.py [--port 8766] [--log faultserver.log]

Bytes are generated: byte at offset i == i % 256, so any downloaded file can be checked by SHA-256.
GET /ctl/sha/<MB> returns the expected SHA-256 of an <MB>-MiB file.

URL: /t/<mods>/<n>MB.bin   mods joined by '-', or 'none'. Each mod:
  plain        no Accept-Ranges/ETag, ignore Range, always 200 (forces one connection)
  cap<N>       each connection limited to N MB/s
  limit<N>     at most N concurrent body connections per client IP; extras get 429 Retry-After: 10
  tarpit<S>    after a 429, every new connection from that IP hangs for S s before answering (OVH-like)
  drop<P>      the FIRST response for each distinct range start is cut after P% of its bytes (connection reset)
  stall<S>     the FIRST response for each distinct range start sends 1 MB then goes silent S s, then continues
  short        the FIRST response for each range start closes cleanly after half its bytes (body shorter than C-L)
  etag         ETag/Last-Modified come from the control value (change it: GET /ctl/etag/<value>)
  noheadrange  answer the bytes=0-0 probe with 200 + full length (server that ignores tiny ranges)
Control: GET /ctl/reset  clears per-range 'first time' memory, tarpits and counters. GET /ctl/state prints JSON.
Every body response is logged as a JSON line.
"""
import argparse, hashlib, json, os, re, socket, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

BLOCK = bytes(range(256)) * 256
LOCK = threading.Lock()
STATE = {'seen': set(), 'active': {}, 'tarpit_until': {}, 'etag': 'v1', 'n': 0}
LOG = None  # opened in main()


def log(rec):
    with LOCK:
        LOG.write(json.dumps(rec) + '\n')


def expected_sha256(size):
    h = hashlib.sha256(); left = size
    while left:
        n = min(left, len(BLOCK)); h.update(BLOCK[:n]); left -= n
    return h.hexdigest()


def parse(path):
    m = re.fullmatch(r'/t/([a-z0-9-]+)/(\d+)MB\.bin', path.split('?')[0])
    if not m:
        return None, None
    mods = {}
    for tok in m.group(1).split('-'):
        mm = re.fullmatch(r'([a-z]+)(\d*)', tok)
        if mm:
            mods[mm.group(1)] = int(mm.group(2)) if mm.group(2) else True
    return mods, int(m.group(2)) * 1024 * 1024


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_HEAD(self):
        self.serve(True)

    def do_GET(self):
        if self.path.startswith('/ctl/'):
            return self.ctl()
        self.serve(False)

    def ctl(self):
        with LOCK:
            if self.path == '/ctl/reset':
                STATE['seen'].clear(); STATE['tarpit_until'].clear(); STATE['active'].clear(); STATE['etag'] = 'v1'
            elif self.path.startswith('/ctl/etag/'):
                STATE['etag'] = self.path.rsplit('/', 1)[1]
            elif self.path.startswith('/ctl/sha/'):
                pass
            body = json.dumps({'etag': STATE['etag'], 'active': STATE['active'], 'seen': len(STATE['seen']),
                               'tarpit_until': STATE['tarpit_until']}).encode()
        if self.path.startswith('/ctl/sha/'):
            body = expected_sha256(int(self.path.rsplit('/', 1)[1]) * 1024 * 1024).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)

    def serve(self, head):
        mods, total = parse(self.path)
        if mods is None:
            self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers(); return
        ip = self.client_address[0]
        ranged = 'plain' not in mods
        etag = '"%s"' % (STATE['etag'] if 'etag' in mods else 'fixed1')
        lm = 'Wed, 18 Nov 2026 00:00:00 GMT' if not ('etag' in mods) else 'Thu, 19 Nov 2026 %02d:00:00 GMT' % (abs(hash(STATE['etag'])) % 24)
        rng = self.headers.get('Range'); if_range = self.headers.get('If-Range')
        start, end, status = 0, total - 1, 200
        if ranged and rng:
            m = re.fullmatch(r'bytes=(\d*)-(\d*)', rng.strip())
            valid = if_range is None or if_range in (etag, lm)
            if m and valid:
                s, e = m.group(1), m.group(2)
                if s == '':
                    start = total - int(e)
                else:
                    start = int(s); end = min(int(e), total - 1) if e else total - 1
                status = 206
                if 'noheadrange' in mods and start == 0 and end == 0:
                    start, end, status = 0, total - 1, 200
        probe = (end - start) < 1024
        # Tarpit: hang new connections from an IP that was refused recently.
        if 'tarpit' in mods and not probe:
            until = STATE['tarpit_until'].get(ip, 0)
            if time.time() < until:
                time.sleep(until - time.time())
        with LOCK:
            cur = STATE['active'].get(ip, 0)
            refuse = 'limit' in mods and not probe and not head and cur >= mods['limit']
            if refuse and 'tarpit' in mods:
                STATE['tarpit_until'][ip] = time.time() + mods['tarpit']
            if not refuse and not head and not probe:
                STATE['active'][ip] = cur + 1
            first = (self.path, start) not in STATE['seen']
            STATE['seen'].add((self.path, start))
        if refuse:
            self.send_response(429); self.send_header('Retry-After', '10'); self.send_header('Content-Length', '0')
            self.end_headers()
            log({'t': round(time.time(), 2), 'path': self.path, 'range': rng, 'status': 429})
            return
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(end - start + 1))
            if ranged:
                self.send_header('Accept-Ranges', 'bytes'); self.send_header('ETag', etag); self.send_header('Last-Modified', lm)
                if status == 206:
                    self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, total))
            self.end_headers()
            if head:
                return
            self.body(mods, start, end, first, rng, status)
        finally:
            if not head and not probe:
                with LOCK:
                    STATE['active'][ip] = max(0, STATE['active'].get(ip, 1) - 1)

    def body(self, mods, start, end, first, rng, status):
        t0 = time.time(); sent = 0; pos = start; length = end - start + 1
        cap = mods.get('cap', 0) * 1048576
        cut = length * mods['drop'] // 100 if ('drop' in mods and first) else None
        short = length // 2 if ('short' in mods and first) else None
        stall_at = min(1048576, length // 2) if ('stall' in mods and first) else None
        outcome = 'ok'
        try:
            while pos <= end:
                if cap and sent > cap * (time.time() - t0):
                    time.sleep(0.005); continue
                if stall_at is not None and sent >= stall_at:
                    time.sleep(mods['stall']); stall_at = None
                if cut is not None and sent >= cut:
                    self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b'\x01\x00\x00\x00\x00\x00\x00\x00')
                    self.wfile.flush(); os.close(self.connection.detach()); self.close_connection = True
                    outcome = 'dropped'; break
                if short is not None and sent >= short:
                    self.wfile.flush(); self.connection.shutdown(socket.SHUT_RDWR); self.close_connection = True
                    outcome = 'short'; break
                off = pos % len(BLOCK)
                n = min(len(BLOCK) - off, end - pos + 1, 16384)
                self.wfile.write(BLOCK[off:off + n]); pos += n; sent += n
        except (BrokenPipeError, ConnectionResetError, OSError):
            outcome = 'client-closed'
        dt = max(time.time() - t0, 1e-6)
        log({'t': round(t0, 2), 'path': self.path, 'range': rng, 'status': status, 'bytes': sent, 'sec': round(dt, 2),
             'MBps': round(sent / dt / 1048576, 2), 'outcome': outcome, 'port': self.client_address[1]})


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Fault-injecting HTTP server for Maglev link-download tests')
    ap.add_argument('--port', type=int, default=8766)
    ap.add_argument('--log', default='faultserver.log', help='JSON-lines log, appended to')
    args = ap.parse_args()
    LOG = open(args.log, 'a', buffering=1)
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(('0.0.0.0', args.port), H).serve_forever()
