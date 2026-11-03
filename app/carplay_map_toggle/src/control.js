// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Isaak
/**
 * control - the toggle app's client of the external producer's control socket.
 *
 * One Unix stream socket (CTL_PATH), newline-delimited JSON, one object per
 * line, reconnecting every second while the page is visible. The producer
 * (/var/opt/carplay-map/carplay-map-cluster.js) keeps running when the app
 * closes it.
 *
 *   app      -> producer   {"cmd":"status"} | {"cmd":"enable"} | {"cmd":"disable"}
 *   producer -> app        {"ev":"status","state":"on"|"off"|"standby",
 *                           "enabled":true|false,"carplay":true|false}
 *                          (sent on connect, after each command, and when
 *                           CarPlay enters/leaves the foreground)
 *
 *   state "on"      = mirroring the centre screen onto the cluster
 *   state "standby" = enabled by the user, but CarPlay is not in front
 *   state "off"     = turned off by the user
 *   no connection   = producer offline
 *
 * LineSocket is the generic connection helper, taken unchanged from
 * robertn_waze_cluster/src/waze_cluster_control.js. MapToggleControl drives
 * one of them and renders statusText(), toggleLabel() and the toggle command.
 */
'use strict';

const EventEmitter = require('events');
const net = require('net');

const CTL_PATH = '/dev/shm/carplay-map/ctl.sock';
const RETRY_MS = 1000;

/* One newline-delimited-JSON stream socket, reconnecting while open.
 * link: 'down' | 'up' | 'absent' (ENOENT) | 'refused' (ECONNREFUSED) | 'failed'.
 * Emits 'connect' and 'close'; each parsed object goes to onMessage(msg). */
class LineSocket extends EventEmitter {
    constructor(options) {
        super();
        const o = options || {};
        this.path = o.path;
        this.retryMs = o.retryMs || RETRY_MS;
        this._log = o.log || { info() {}, warn() {} };
        this._onMessage = o.onMessage || function () {};
        this.link = 'down';
        this.linkCode = null;
        this._open = false;
        this._socket = null;
        this._buf = '';
        this._retryTimer = null;
    }

    open() {
        if (!this._open) {
            this._open = true;
            this._connect();
        }
    }

    close() {
        this._open = false;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        if (this._socket) {
            /* forgotten here, so its late events cannot touch a new connection */
            this._socket.end();
            this._socket = null;
        }
        this.link = 'down';
    }

    connected() {
        return this.link === 'up';
    }

    send(obj) {
        if (this._socket && this.link === 'up') {
            this._socket.write(JSON.stringify(obj) + '\n');
        }
    }

    _connect() {
        if (!this._open || this._socket) {
            return;
        }
        const socket = net.connect(this.path);
        this._socket = socket;
        this._buf = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            if (this._socket === socket) {
                this._log.info(`connected to ${this.path}`);
                this.link = 'up';
                this.linkCode = null;
                this.emit('connect');
            }
        });
        socket.on('data', (chunk) => {
            if (this._socket === socket) {
                this._onData(chunk);
            }
        });
        socket.on('error', (err) => {
            if (this._socket !== socket) {
                return;
            }
            const code = (err && err.code) || 'ERROR';
            this.link = code === 'ENOENT' ? 'absent' : code === 'ECONNREFUSED' ? 'refused' : 'failed';
            this.linkCode = code;
            this._log.warn(`${this.path}: ${code}`);
        });
        socket.on('close', () => {
            if (this._socket !== socket) {
                return;
            }
            this._socket = null;
            if (this.link === 'up') {
                this._log.info(`${this.path}: connection closed`);
                this.link = 'refused';
            }
            this.emit('close');
            this._retryTimer = setTimeout(() => {
                this._retryTimer = null;
                this._connect();
            }, this.retryMs);
        });
    }

    _onData(chunk) {
        this._buf += chunk;
        let nl;
        while ((nl = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, nl).trim();
            this._buf = this._buf.slice(nl + 1);
            if (!line) {
                continue;
            }
            let msg = null;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                this._log.warn(`bad line from ${this.path}: ${line.slice(0, 80)}`);
            }
            if (msg) {
                this._onMessage(msg, line);
            }
        }
    }
}

class MapToggleControl extends EventEmitter {
    /* options: ctlPath, retryMs, log ({info, warn}). Emits 'change' whenever
     * statusText(), toggleLabel() or connected() may have changed. */
    constructor(options) {
        super();
        const o = options || {};
        this._log = o.log || { info() {}, warn() {} };
        this.status = null;   /* last {ev:'status',...} while connected */

        this.ctl = new LineSocket({
            path: o.ctlPath || CTL_PATH,
            retryMs: o.retryMs,
            log: this._log,
            onMessage: (msg) => this._onMessage(msg)
        });
        /* On (re)connect the producer resends its status, so drop the stale one. */
        this.ctl.on('connect', () => { this.status = null; this.emit('change'); });
        this.ctl.on('close', () => { this.status = null; this.emit('change'); });
    }

    /* Open the socket, reconnecting while open. */
    open() {
        this.ctl.open();
    }

    /* Close it; the producer keeps running. */
    close() {
        this.ctl.close();
        this.status = null;
        this.emit('change');
    }

    connected() {
        return this.ctl.connected();
    }

    /* ---- controls ---- */
    enable() {
        this.ctl.send({ cmd: 'enable' });
    }

    disable() {
        this.ctl.send({ cmd: 'disable' });
    }

    /* Off -> enable; on or standby -> disable. */
    toggle() {
        if (this.isOn()) {
            this.disable();
        } else {
            this.enable();
        }
    }

    /* True while the map is enabled by the user (on or standby). The producer's
     * explicit "enabled" flag wins; the state is the fallback. */
    isOn() {
        const s = this.status;
        if (!s) {
            return false;
        }
        if (typeof s.enabled === 'boolean') {
            return s.enabled;
        }
        return s.state === 'on' || s.state === 'standby';
    }

    /* ---- rendering ---- */
    toggleLabel() {
        return this.isOn() ? 'Desligar' : 'Ligar mapa no cluster';
    }

    statusText() {
        if (this.ctl.link === 'down') {
            return 'Conectando…';
        }
        if (!this.connected()) {
            return 'Produtor offline';
        }
        const s = this.status;
        if (!s) {
            return 'Conectando…';
        }
        switch (s.state) {
        case 'on':
            return 'Ligado (espelhando)';
        case 'standby':
            return 'Ligado — aguardando CarPlay';
        case 'off':
            return 'Desligado';
        default:
            return s.state ? `Estado: ${s.state}` : 'Conectando…';
        }
    }

    /* ---- internals ---- */
    _onMessage(msg) {
        if (msg && msg.ev === 'status') {
            this.status = msg;
            this.emit('change');
        }
        /* {"ev":"log",...} and anything else are ignored by the minimal UI. */
    }
}

module.exports = { MapToggleControl, LineSocket, CTL_PATH };
