// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Isaak
/**
 * Offline unit test of src/control.js: the state -> phrase mapping, the toggle
 * label, and which command toggle() sends for each producer state. Pure logic,
 * no sockets, so it runs on any platform (including Windows):
 *
 *   node tools/test_control.js
 *
 * The socket/reconnect machinery (LineSocket) is exercised separately against
 * tools/fakes.js on a POSIX box; here we drive the control object directly by
 * recording ctl.send and setting ctl.link/status.
 */
'use strict';

const assert = require('assert');
const { MapToggleControl } = require('../src/control.js');

function makeControl() {
    const c = new MapToggleControl({ log: { info() {}, warn() {} } });
    const sent = [];
    c.ctl.send = (obj) => sent.push(obj);   // record, do not open a socket
    c._sent = sent;
    return c;
}

/* status phrases follow link + the producer's state */
(function statusPhrases() {
    const c = makeControl();

    c.ctl.link = 'down';
    assert.strictEqual(c.statusText(), 'Conectando…', 'down -> Conectando');

    c.ctl.link = 'absent';   // socket file missing (producer not running)
    assert.strictEqual(c.statusText(), 'Produtor offline', 'absent -> Produtor offline');

    c.ctl.link = 'refused';
    assert.strictEqual(c.statusText(), 'Produtor offline', 'refused -> Produtor offline');

    c.ctl.link = 'up';
    c.status = null;
    assert.strictEqual(c.statusText(), 'Conectando…', 'up, no status yet -> Conectando');

    c._onMessage({ ev: 'status', state: 'on', enabled: true, carplay: true });
    assert.strictEqual(c.statusText(), 'Ligado (espelhando)', 'on');

    c._onMessage({ ev: 'status', state: 'standby', enabled: true, carplay: false });
    assert.strictEqual(c.statusText(), 'Ligado — aguardando CarPlay', 'standby');

    c._onMessage({ ev: 'status', state: 'off', enabled: false, carplay: false });
    assert.strictEqual(c.statusText(), 'Desligado', 'off');
})();

/* button label follows isOn() */
(function toggleLabel() {
    const c = makeControl();
    c.ctl.link = 'up';

    c._onMessage({ ev: 'status', state: 'off', enabled: false, carplay: false });
    assert.strictEqual(c.isOn(), false, 'off -> not on');
    assert.strictEqual(c.toggleLabel(), 'Ligar mapa no cluster', 'off -> Ligar label');

    c._onMessage({ ev: 'status', state: 'on', enabled: true, carplay: true });
    assert.strictEqual(c.isOn(), true, 'on -> on');
    assert.strictEqual(c.toggleLabel(), 'Desligar', 'on -> Desligar label');

    c._onMessage({ ev: 'status', state: 'standby', enabled: true, carplay: false });
    assert.strictEqual(c.isOn(), true, 'standby -> on (enabled)');
    assert.strictEqual(c.toggleLabel(), 'Desligar', 'standby -> Desligar label');
})();

/* toggle() sends enable when off, disable when on/standby */
(function toggleCommands() {
    const c = makeControl();
    c.ctl.link = 'up';

    c._onMessage({ ev: 'status', state: 'off', enabled: false, carplay: false });
    c.toggle();
    assert.deepStrictEqual(c._sent.pop(), { cmd: 'enable' }, 'off -> enable');

    c._onMessage({ ev: 'status', state: 'on', enabled: true, carplay: true });
    c.toggle();
    assert.deepStrictEqual(c._sent.pop(), { cmd: 'disable' }, 'on -> disable');

    c._onMessage({ ev: 'status', state: 'standby', enabled: true, carplay: false });
    c.toggle();
    assert.deepStrictEqual(c._sent.pop(), { cmd: 'disable' }, 'standby -> disable');
})();

/* a dropped connection clears the status and reports offline again */
(function reconnectResets() {
    const c = makeControl();
    c.ctl.link = 'up';
    c._onMessage({ ev: 'status', state: 'on', enabled: true, carplay: true });
    assert.strictEqual(c.isOn(), true);
    c.ctl.emit('close');            // LineSocket drops -> control clears status
    assert.strictEqual(c.status, null, 'close clears status');
    c.ctl.link = 'absent';
    assert.strictEqual(c.statusText(), 'Produtor offline', 'offline after close');
    assert.strictEqual(c.toggleLabel(), 'Ligar mapa no cluster', 'label resets when offline');
})();

console.log('test_control.js: all assertions passed');
