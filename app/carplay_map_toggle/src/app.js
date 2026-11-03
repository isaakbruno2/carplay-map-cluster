// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Isaak
/**
 * carplay_map_toggle - a minimal iDrive 7 (ID7) control panel for the external
 * CarPlay->cluster producer. It drives the producer entirely from the HMI, so
 * no shell is needed.
 *
 * One LT_State_Wide page: a title, a status line and a single toggle button.
 *   - producer off          -> button "Ligar mapa no cluster"; a press enables
 *   - producer on/standby    -> button "Desligar";             a press disables
 *   - no producer connection -> status "Produtor offline", button disabled
 *
 * The app connects the control socket while its page is visible and closes it
 * when the page is hidden or the app shuts down; the producer keeps running.
 * control.js holds the protocol. Based on robertn_waze_cluster.js.
 *
 * NOTE (ID7 caveat, from robertn_waze_cluster.js:342-345): hiding a component
 * at run time leaves the page without its other rows on this HMI, so the
 * toggle changes TEXT and ENABLED state only (setValue/setEnabled), never
 * visibility.
 */
'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { MapToggleControl } = require('./control.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_CarplayMapToggle';
const STATUS_NAME = 'cmStatus';
const TOGGLE_NAME = 'cmToggle';
const PRESS_DEDUPE_MS = 400;

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class CarplayMapToggleApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._control = new MapToggleControl({ log: logger });
        this._control.on('change', () => this._render());

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error(`carplay_map_toggle init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._setVisible(false);
            }
        });
    }

    _appInitialized() {
        logger.info(`carplay_map_toggle ${this.getAppId()} v${this._packageJson.version} starting`);
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
                // A foreground start declares itself ACTIVE before initialized()
                // reports the first app status, so the manager keeps it running.
                if (foregroundStart) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid &&
                    this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK',
            'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.includes(reason);
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE_NAME);
        if (!this._state) {
            return Promise.reject(new Error(`uiDescription has no ${STATE_NAME}`));
        }
        const names = [STATUS_NAME, TOGGLE_NAME];
        names.forEach((name) => { this._components[name] = rhmi.getByName(name); });
        const missing = names.filter((name) => !this._components[name]);
        if (missing.length) {
            return Promise.reject(new Error(`uiDescription lacks ${missing.join(', ')}`));
        }
        this._bind(TOGGLE_NAME, () => this._control.toggle());
        // Presses also arrive as the application's raw 'userEvent'; both paths
        // land in _press, which drops a press delivered twice to one.
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler);
            }
        });
        rhmi.on('applicationStackChanged', (stack) => {
            // The app holds the foreground while the stack has a ROOT_APP slot;
            // the empty stack seen during startup is ignored.
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._written = {};
            this._render();
        });
        this._state.on('visible', (event) => {
            const visible = isTrue(event && event.visible);
            if (visible) {
                this._sawForeground = true;
            }
            this._setVisible(visible);
        });
        return Promise.resolve(this._state.updateResources()).then(() => {
            logger.info(`page ready: ${names.length} components found`);
            this._render();
        });
    }

    _bind(name, handler) {
        const comp = this._components[name];
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null) {
            this._actionById[Number(id)] = { name, handler };
        }
        logger.info(`BIND OK: ${name} (id ${id})`);
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[name] = now;
        logger.info(`BUTTON ACTION ${name}`);
        try {
            handler();
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    /* The app manager inserts the public tile from application.json and hands
     * it to the app at start; the SDK emits 'entryPointExecute' on a tap. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription &&
            this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn(`entry point text/icon: ${err && err.message}`)))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._sawForeground = true;
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* ---- visibility ---- */
    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        logger.info(`page ${visible ? 'visible' : 'hidden'}`);
        this._reportVisibilityStatus(visible);
        if (visible) {
            this._control.open();
        } else {
            this._control.close();
        }
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        const reports = visible ?
            [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report).catch((err) =>
            logger.warn(`app status report failed: ${err && err.message}`)));
    }

    /* ---- rendering ---- */
    /* Writes text into a component's row unless it already shows it. */
    _write(name, text) {
        if (this._written[name] !== text) {
            this._written[name] = text;
            Promise.resolve(this._components[name].setValue(0, 'Text', text, 'Text'))
                .catch((err) => logger.warn(`${name} render failed: ${err && err.message}`));
        }
    }

    /* Enables a button unless it already holds that state. */
    _setEnabled(name, enabled) {
        const key = `enabled:${name}`;
        if (this._written[key] !== enabled) {
            this._written[key] = enabled;
            Promise.resolve(this._components[name].setEnabled(enabled))
                .catch((err) => logger.warn(`${name} enable failed: ${err && err.message}`));
        }
    }

    _render() {
        if (!this._state || this._shutdownPromise) {
            return;
        }
        this._write(STATUS_NAME, this._control.statusText());
        this._write(TOGGLE_NAME, this._control.toggleLabel());
        /* Never hide the button (ID7 caveat); disable it while the producer is
         * unreachable so a press cannot be lost silently. */
        this._setEnabled(TOGGLE_NAME, this._control.connected());
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`carplay_map_toggle shutdown: ${JSON.stringify(reason)}`);
        this._control.close();
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new CarplayMapToggleApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`carplay_map_toggle failed to start: ${err && err.message}`);
});
