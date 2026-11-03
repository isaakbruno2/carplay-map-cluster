// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Isaak
'use strict';
/**
 * Builds the app's source package (carplay_map_toggle@<version>.src.tgz) using
 * the idrive-apps repo's tools/oap_link.js, and the OAP tgz too when an
 * oap-sdk donor is given. The catalog publishes the app with "build": "unit",
 * so the head unit links it against its own oap-sdk at install; a local OAP
 * tgz is only for experiments and needs a donor.
 *
 *   node tools/build.js [--sdk <donor .tgz|.js>]     (or MGU_SDK_DONOR)
 *
 * oap_link.js lives in the idrive-apps repo, not in this folder. Resolve it
 * with MGU_OAP_LINK=/path/to/idrive-apps/src/tools/oap_link.js, or drop this
 * app folder under the repo's apps/<id>/ so the repo-relative path resolves.
 * To just produce the source artifact without the repo, tar the folder:
 *
 *   tar -czf carplay_map_toggle@0.1.0.src.tgz \
 *       mgu-app.json src/app.js src/control.js carplay_map_toggle@0.1.0
 */
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const LINK = process.env.MGU_OAP_LINK || path.join(HERE, '..', '..', 'tools', 'oap_link.js');

let link;
try {
    link = require(LINK);
} catch (e) {
    console.error(`build: cannot load oap_link.js at ${LINK}`);
    console.error('       set MGU_OAP_LINK, place this folder under the repo apps/<id>/,');
    console.error('       or tar the source package by hand (see the header of this file).');
    process.exit(1);
}

function donorArg(argv) {
    const i = argv.indexOf('--sdk');
    if (i >= 0) {
        if (!argv[i + 1]) {
            throw new Error('--sdk needs a donor .tgz or .js');
        }
        return path.resolve(argv[i + 1]);
    }
    return process.env.MGU_SDK_DONOR ? path.resolve(process.env.MGU_SDK_DONOR) : null;
}

function main() {
    const donor = donorArg(process.argv.slice(2));
    const m = link.readManifest(HERE);
    const src = path.join(HERE, `${m.id}@${m.version}.src.tgz`);
    const out = { source: path.basename(src), sourceMembers: link.packSource(HERE, src).length };
    if (donor) {
        const r = link.build(HERE, path.join(HERE, `${m.id}@${m.version}.tgz`),
            { donors: [donor], epoch: process.env.SOURCE_DATE_EPOCH });
        Object.assign(out, { tgz: path.basename(r.file), donor: r.donor, entry: r.entry,
            bundleModules: r.moduleCount, bundleBytes: r.bytes });
    }
    console.log(JSON.stringify(out, null, 2));
}

try {
    main();
} catch (e) {
    console.error(`build: ${e.message}`);
    process.exitCode = 1;
}
