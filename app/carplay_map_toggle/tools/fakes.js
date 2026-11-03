// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Isaak
/**
 * A fake of the external producer's control socket, for driving the app or
 * control.js by hand on a POSIX box (Unix domain sockets). It mirrors the
 * real protocol:
 *
 *   app  -> producer   {"cmd":"status"|"enable"|"disable"}
 *   fake -> app        {"ev":"status","state":"on"|"off"|"standby",
 *                       "enabled":bool,"carplay":bool}   // on connect + on change
 *
 *   node tools/fakes.js [/dev/shm/carplay-map/ctl.sock]
 *   Enter toggles a fake CarPlay-in-foreground; the state follows enabled+carplay.
 */
'use strict';

const net = require('net');
const fs = require('fs');

class FakeProducer {
    constructor(sockPath) {
        this.path = sockPath;
        this.enabled = false;
        this.carplay = false;
        this.clients = [];
        this.server = null;
    }

    state() {
        if (!this.enabled) {
            return 'off';
        }
        return this.carplay ? 'on' : 'standby';
    }

    msg() {
        return { ev: 'status', state: this.state(), enabled: this.enabled, carplay: this.carplay };
    }

    start(cb) {
        try { fs.unlinkSync(this.path); } catch (e) { /* ignore */ }
        this.server = net.createServer((sock) => this._accept(sock));
        this.server.listen(this.path, cb);
    }

    stop(cb) {
        this.clients.forEach((c) => { try { c.destroy(); } catch (e) { /* ignore */ } });
        this.clients = [];
        if (this.server) {
            this.server.close(() => { try { fs.unlinkSync(this.path); } catch (e) { /* ignore */ } cb && cb(); });
        } else if (cb) {
            cb();
        }
    }

    setCarplay(present) {
        this.carplay = !!present;
        this._broadcast();
    }

    _accept(sock) {
        this.clients.push(sock);
        sock.setEncoding('utf8');
        let buf = '';
        sock.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (line) { this._handle(line, sock); }
            }
        });
        sock.on('error', () => {});
        sock.on('close', () => { this.clients = this.clients.filter((c) => c !== sock); });
        this._write(sock);   // status on connect
    }

    _handle(line, sock) {
        let msg = null;
        try { msg = JSON.parse(line); } catch (e) { return; }
        if (!msg || !msg.cmd) { return; }
        if (msg.cmd === 'enable') { this.enabled = true; }
        else if (msg.cmd === 'disable') { this.enabled = false; }
        // 'status' and anything else: just (re)send the current status.
        this._broadcast();
    }

    _write(sock) {
        try { sock.write(JSON.stringify(this.msg()) + '\n'); } catch (e) { /* ignore */ }
    }

    _broadcast() {
        const s = JSON.stringify(this.msg()) + '\n';
        this.clients.forEach((c) => { try { c.write(s); } catch (e) { /* ignore */ } });
    }
}

module.exports = { FakeProducer };

if (require.main === module) {
    const sock = process.argv[2] || '/dev/shm/carplay-map/ctl.sock';
    const fake = new FakeProducer(sock);
    fake.start(() => {
        process.stdout.write(`fake producer on ${sock}; state=${fake.state()}\n`);
        process.stdout.write('Enter: toggle fake CarPlay foreground; Ctrl-C to quit\n');
    });
    process.stdin.on('data', () => {
        fake.setCarplay(!fake.carplay);
        process.stdout.write(`carplay=${fake.carplay} state=${fake.state()}\n`);
    });
}
