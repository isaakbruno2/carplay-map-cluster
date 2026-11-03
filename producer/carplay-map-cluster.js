#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 — produtor "CarPlay no cluster" (idrive7 / BMW G20, high_4_1)
'use strict';
/**
 * carplay-map-cluster.js (v2) — põe o MAPA do CarPlay no cluster, via cluster-render.
 * Roda NO CARRO, como root. Node 8+.
 *
 * v2:
 *  - Captura RAW com winston-grabber (RGBA direto, ~3x mais rápido que PNG).
 *  - GATE: assina CarPlayManager.onScreenChange (SOME/IP). Mostra o mapa só quando
 *    screenOwner = PROJECTED (CarPlay na frente); em NATIVE (menu BMW) esconde o
 *    layer e o mapa stock do BMW volta. (--no-gate = sempre ligado, como v1.)
 *
 * v3:
 *  - GATE DE FORMATO: só espelha quando o CarPlay está no layout "Dashboard"
 *    (mapa à esquerda + coluna de cards à direita). Dois testes: (1) meio colorido = mapa;
 *    (2) cor na direita CONCENTRADA, não espalhada (grade de células) = cards, não mapa.
 *    Rejeita mapa em tela cheia (cor espalhada na direita) e telas sem mapa (meio sem cor).
 *    Robusto a música/capa e a mapa sem rota. --no-require-format desliga. --calibrate afere.
 *
 * Fluxo por quadro (quando CarPlay na frente):
 *   winston-grabber -s center -n1 <tmp>.rgb  -> RGBA 1920x720
 *     -> crop da região do mapa -> escala p/ 1088x480 -> cr.pixels() no target 'map'
 *
 * Uso:
 *   node carplay-map-cluster.js [opções]
 *   --socket PATH     socket do cluster-render (padrão /dev/shm/cluster-render/render.sock)
 *   --target NAME     map | panel | hud (padrão map)
 *   --fps N           quadros/s (padrão 3; imagem inteira ~2MB enche o orçamento de 6MB/s)
 *   --crop X,Y,W,H    região do 1920x720 a usar (padrão 160,0,1020,720)
 *   --fit MODE        cover | contain | fill (padrão cover)
 *   --scale MODE      nearest | bilinear (padrão nearest; mais rápido)
 *   --order ORD       rgba | bgra (ordem de canais do winston-grabber; padrão bgra)
 *   --capture BACK    raw | png (padrão raw=winston-grabber; png=ivi-screenshot-control)
 *   --no-gate         não usa o gate do CarPlay (sempre espelha)
 *   --gate-initial    front | menu (estado assumido antes do 1º evento; padrão front)
 *   --wayland DISP    WAYLAND_DISPLAY da captura (padrão wayland-0)
 *   --xdg DIR         XDG_RUNTIME_DIR da captura (padrão /run/wayland)
 *   --tmp PATH        arquivo bruto temporário (padrão /dev/shm/carplay_map_cap.rgb)
 *   --cap-size WxH    tamanho da captura (padrão 1920x720)
 *   --no-contend      não disputar o slot do mapa stock
 *   --once            1 quadro e sai (debug no carro)
 *   --no-require-format  não checar o formato (espelha qualquer tela do CarPlay)
 *   --fmt-map X0,Y0,X1,Y1   região "mapa" em frações 0..1 (padrão .10,.12,.58,.88)
 *   --fmt-right X0,Y0,X1,Y1 região "cards" em frações 0..1 (padrão .645,.06,.985,.95)
 *   --fmt-th SAT,TMAP,TCELLS limiares: sat/pixel, meio>=TMAP%, nº células dir<=TCELLS (padrão 40,5,7)
 *   --fmt-cells COLS,ROWS,CELLTH grade da direita e limiar de célula colorida (padrão 4,4,15)
 *   --calibrate       captura 1 quadro, imprime sat meio/dir + veredito e sai
 *   --infile PATH     OFFLINE: lê PNG (ou .rgb c/ --cap-size), processa e sai
 *   --save PATH       grava o RGBA processado como PNG (debug/preview)
 *   --verbose
 */

const fs = require('fs');
const zlib = require('zlib');
const { execFile } = require('child_process');
const path = require('path');

const SIZES = { panel: [1920, 720], map: [1088, 480], hud: [800, 480] };
const SOMEIP_NODE = '/usr/lib/someip.node';

/* ---------------------------------------------------------------- PNG decode (só p/ --infile .png) */
function decodePNG(buf) {
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('não é um PNG');
    let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.slice(off + 8, off + 8 + len);
        off += 12 + len;
        if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
    }
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) throw new Error('PNG não suportado (só 8-bit RGB/RGBA não-interlaçado)');
    const ch = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * ch;
    const out = Buffer.alloc(height * stride);
    let prev = Buffer.alloc(stride), p = 0;
    for (let y = 0; y < height; y++) {
        const ft = raw[p++], cur = Buffer.alloc(stride);
        for (let i = 0; i < stride; i++) {
            const x = raw[p + i], a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
            let v;
            if (ft === 0) v = x; else if (ft === 1) v = x + a; else if (ft === 2) v = x + b;
            else if (ft === 3) v = x + ((a + b) >> 1);
            else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
            else throw new Error('filtro PNG inválido');
            cur[i] = v & 0xff;
        }
        cur.copy(out, y * stride); prev = cur; p += stride;
    }
    return { width: width, height: height, channels: ch, data: out, bgr: false };
}

/* ---------------------------------------------------------------- RGBA cru (winston-grabber) */
function readRaw(buf, w, h, order) {
    if (buf.length < w * h * 4) throw new Error('raw curto: ' + buf.length + ' < ' + (w * h * 4) + ' (tamanho de captura errado?)');
    return { width: w, height: h, channels: 4, data: buf, bgr: order === 'bgra' };
}

/* ---------------------------------------------------------------- PNG encode (p/ preview/--save) */
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (~c) >>> 0; }
function encodePNG(rgba, w, h) {
    const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
    for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
    const idat = zlib.deflateSync(raw);
    const chunk = (t, d) => { const c = Buffer.alloc(12 + d.length); c.writeUInt32BE(d.length, 0); c.write(t, 4, 'ascii'); d.copy(c, 8); c.writeUInt32BE(crc32(c.slice(4, 8 + d.length)), 8 + d.length); return c; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------------------------------------------------------- crop + escala */
function clampCrop(c, w, h) {
    const x = Math.max(0, Math.min(w - 1, c.x | 0)), y = Math.max(0, Math.min(h - 1, c.y | 0));
    return { x: x, y: y, w: Math.max(1, Math.min(w - x, c.w | 0)), h: Math.max(1, Math.min(h - y, c.h | 0)) };
}
function sourceRect(crop, outW, outH, fit) {
    if (fit === 'fill') return { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    const outA = outW / outH, cropA = crop.w / crop.h;
    if (cropA > outA) { const nw = crop.h * outA; return { x: crop.x + (crop.w - nw) / 2, y: crop.y, w: nw, h: crop.h }; }
    const nh = crop.w / outA; return { x: crop.x, y: crop.y + (crop.h - nh) / 2, w: crop.w, h: nh };
}
/* lê R,G,B de um pixel (x,y) respeitando bgr; escreve em px[0..2] */
function readRGB(img, x, y, px) {
    const i = (y * img.width + x) * img.channels;
    if (img.bgr) { px[0] = img.data[i + 2]; px[1] = img.data[i + 1]; px[2] = img.data[i]; }
    else { px[0] = img.data[i]; px[1] = img.data[i + 1]; px[2] = img.data[i + 2]; }
}
function processImage(img, opts) {
    const outW = opts.outW, outH = opts.outH, fit = opts.fit || 'cover', nearest = opts.scale !== 'bilinear';
    const crop = clampCrop(opts.crop, img.width, img.height);
    const out = Buffer.alloc(outW * outH * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    let dest, src;
    if (fit === 'contain') {
        const cropA = crop.w / crop.h, outA = outW / outH;
        if (cropA > outA) { const dh = Math.round(outW / cropA); dest = { x: 0, y: Math.round((outH - dh) / 2), w: outW, h: dh }; }
        else { const dw = Math.round(outH * cropA); dest = { x: Math.round((outW - dw) / 2), y: 0, w: dw, h: outH }; }
        src = crop;
    } else { dest = { x: 0, y: 0, w: outW, h: outH }; src = sourceRect(crop, outW, outH, fit); }
    const W = img.width, H = img.height, p00 = [0, 0, 0], p10 = [0, 0, 0], p01 = [0, 0, 0], p11 = [0, 0, 0];
    for (let oy = 0; oy < dest.h; oy++) {
        const fy = src.y + (oy + 0.5) / dest.h * src.h - 0.5;
        let di = ((dest.y + oy) * outW + dest.x) * 4;
        for (let ox = 0; ox < dest.w; ox++, di += 4) {
            const fx = src.x + (ox + 0.5) / dest.w * src.w - 0.5;
            if (nearest) {
                let sx = Math.round(fx), sy = Math.round(fy);
                sx = sx < 0 ? 0 : sx > W - 1 ? W - 1 : sx; sy = sy < 0 ? 0 : sy > H - 1 ? H - 1 : sy;
                readRGB(img, sx, sy, p00); out[di] = p00[0]; out[di + 1] = p00[1]; out[di + 2] = p00[2];
            } else {
                let cx = fx < 0 ? 0 : fx > W - 1 ? W - 1 : fx, cy = fy < 0 ? 0 : fy > H - 1 ? H - 1 : fy;
                const x0 = cx | 0, y0 = cy | 0, x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0, ax = cx - x0, ay = cy - y0;
                readRGB(img, x0, y0, p00); readRGB(img, x1, y0, p10); readRGB(img, x0, y1, p01); readRGB(img, x1, y1, p11);
                for (let k = 0; k < 3; k++) { const top = p00[k] + (p10[k] - p00[k]) * ax, bot = p01[k] + (p11[k] - p01[k]) * ax; out[di + k] = (top + (bot - top) * ay) | 0; }
            }
            out[di + 3] = 255;
        }
    }
    return { width: outW, height: outH, rgba: out };
}

/* ---------------------------------------------------------------- detector de formato (Dashboard do CarPlay) */
/* Dashboard = mapa COLORIDO à esquerda + coluna de cards à direita. Dois testes:
 *  1) MEIO (mapa) colorido: % de pixels saturados (|max-min|>satTh) >= tMap.
 *  2) DIREITA não é mapa: a cor na direita tem que estar CONCENTRADA, não espalhada.
 *     Divide a coluna direita numa grade cols×rows; conta células "coloridas"
 *     (sat% > cellTh). Mapa em tela cheia espalha cor por ~todas as células (12-13/16);
 *     card de música concentra a capa em 1-2 células. Exige nº de células <= tCells.
 * Medido no carro: Dash 0-2 células, tela cheia 12-13 (margem grande). Robusto a
 * música/capa, mapa sem rota e zoom. Ordem de canais (rgba/bgra) não importa p/ max-min. */
function satPct(img, x0, y0, x1, y1, satTh, step) {
    const X0 = (x0 * img.width) | 0, Y0 = (y0 * img.height) | 0, X1 = (x1 * img.width) | 0, Y1 = (y1 * img.height) | 0;
    const sx = Math.max(1, ((X1 - X0) / step) | 0), sy = Math.max(1, ((Y1 - Y0) / step) | 0);
    const px = [0, 0, 0]; let sat = 0, n = 0;
    for (let y = Y0; y < Y1; y += sy) for (let x = X0; x < X1; x += sx) {
        readRGB(img, x, y, px);
        const mx = px[0] > px[1] ? (px[0] > px[2] ? px[0] : px[2]) : (px[1] > px[2] ? px[1] : px[2]);
        const mn = px[0] < px[1] ? (px[0] < px[2] ? px[0] : px[2]) : (px[1] < px[2] ? px[1] : px[2]);
        if (mx - mn > satTh) sat++;
        n++;
    }
    return n ? 100 * sat / n : 0;
}
/* nº de células da coluna direita (grade cols×rows) com sat% acima de cellTh */
function rightCells(img, f) {
    let nc = 0;
    for (let cx = 0; cx < f.cols; cx++) for (let cy = 0; cy < f.rows; cy++) {
        const ax = f.rX0 + (f.rX1 - f.rX0) * cx / f.cols, bx = f.rX0 + (f.rX1 - f.rX0) * (cx + 1) / f.cols;
        const ay = f.rY0 + (f.rY1 - f.rY0) * cy / f.rows, by = f.rY0 + (f.rY1 - f.rY0) * (cy + 1) / f.rows;
        if (satPct(img, ax, ay, bx, by, f.satTh, f.step) > f.cellTh) nc++;
    }
    return nc;
}
function detectDashboard(img, f) {
    const satMap = satPct(img, f.mapX0, f.mapY0, f.mapX1, f.mapY1, f.satTh, f.step);
    const cells = rightCells(img, f);
    return { dashboard: satMap >= f.tMap && cells <= f.tCells, satMap: satMap, cells: cells, ncells: f.cols * f.rows };
}
/* img (rgb/rgba/bgra) -> RGBA reto (p/ salvar com encodePNG em --calibrate/debug) */
function toRGBA(img) {
    const out = Buffer.alloc(img.width * img.height * 4), px = [0, 0, 0];
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        readRGB(img, x, y, px); const di = (y * img.width + x) * 4;
        out[di] = px[0]; out[di + 1] = px[1]; out[di + 2] = px[2]; out[di + 3] = 255;
    }
    return out;
}

/* ---------------------------------------------------------------- vídeo YUV 4:2:0 */
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
function sampleRGB(img, fx, fy, nearest, px) {
    const W = img.width, H = img.height;
    if (nearest) {
        let sx = Math.round(fx), sy = Math.round(fy);
        sx = sx < 0 ? 0 : sx > W - 1 ? W - 1 : sx; sy = sy < 0 ? 0 : sy > H - 1 ? H - 1 : sy;
        readRGB(img, sx, sy, px);
    } else {
        const cx = fx < 0 ? 0 : fx > W - 1 ? W - 1 : fx, cy = fy < 0 ? 0 : fy > H - 1 ? H - 1 : fy;
        const x0 = cx | 0, y0 = cy | 0, x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0, ax = cx - x0, ay = cy - y0;
        const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0];
        readRGB(img, x0, y0, a); readRGB(img, x1, y0, b); readRGB(img, x0, y1, c); readRGB(img, x1, y1, d);
        for (let k = 0; k < 3; k++) { const top = a[k] + (b[k] - a[k]) * ax, bot = c[k] + (d[k] - c[k]) * ax; px[k] = (top + (bot - top) * ay) | 0; }
    }
}
/* RGBA -> atlas YUV 4:2:0 (full-range BT.601): Y(vw×vh) + U|V nas vh/2 linhas de baixo */
function processToYUV(img, opts) {
    const vw = opts.outW, vh = opts.outH, nearest = opts.scale !== 'bilinear';
    const crop = clampCrop(opts.crop, img.width, img.height);
    const src = sourceRect(crop, vw, vh, opts.fit === 'fill' ? 'fill' : 'cover');
    const atlas = Buffer.alloc(vw * vh + vw * (vh >> 1));
    const px = [0, 0, 0];
    for (let oy = 0; oy < vh; oy++) {
        const fy = src.y + (oy + 0.5) / vh * src.h - 0.5;
        let yi = oy * vw;
        for (let ox = 0; ox < vw; ox++, yi++) {
            sampleRGB(img, src.x + (ox + 0.5) / vw * src.w - 0.5, fy, nearest, px);
            atlas[yi] = clamp8(0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]);
        }
    }
    const base = vw * vh, half = vw >> 1;
    for (let cy = 0; cy < (vh >> 1); cy++) {
        const fy = src.y + (2 * cy + 1) / vh * src.h - 0.5, row = base + cy * vw;
        for (let cx = 0; cx < half; cx++) {
            sampleRGB(img, src.x + (2 * cx + 1) / vw * src.w - 0.5, fy, nearest, px);
            const r = px[0], g = px[1], b = px[2];
            atlas[row + cx] = clamp8(-0.168736 * r - 0.331264 * g + 0.5 * b + 128);
            atlas[row + half + cx] = clamp8(0.5 * r - 0.418688 * g - 0.081312 * b + 128);
        }
    }
    return atlas;
}
/* atlas YUV -> RGBA (só p/ --save/preview offline; inverso full-range BT.601) */
function yuvAtlasToRGBA(atlas, vw, vh) {
    const out = Buffer.alloc(vw * vh * 4), base = vw * vh, half = vw >> 1;
    for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
        const Y = atlas[y * vw + x], row = base + (y >> 1) * vw, cx = x >> 1;
        const U = atlas[row + cx] - 128, V = atlas[row + half + cx] - 128, di = (y * vw + x) * 4;
        out[di] = clamp8(Y + 1.402 * V); out[di + 1] = clamp8(Y - 0.344136 * U - 0.714136 * V); out[di + 2] = clamp8(Y + 1.772 * U); out[di + 3] = 255;
    }
    return out;
}

/* ---------------------------------------------------------------- gate CarPlay (SOME/IP) */
function startGate(initialFront, log, onChange) {
    const state = { front: initialFront, guidance: null, ok: false };
    let someip;
    try { someip = require(SOMEIP_NODE); } catch (e) { log('gate OFF (sem someip.node): ' + e.message); return state; }
    const CPM = {
        name: 'CarPlayManager', serviceId: 64353, version: { major: 0, minor: 5 },
        instances: { CarPlayManagerInst1: 128 }, methods: {},
        fields: { projectedGuidanceActive: { schema: { t: 'Bool' }, getter: { id: 2 }, event: { id: 32770, groups: [2] } } },
        events: { onScreenChange: { id: 32773, groups: [5], schema: { t: 'Enum', e: { PROJECTED: 0, NATIVE: 1 } } } },
        eventGroups: { fields: { '32770': [2] }, events: { '32773': [5] } }
    };
    /* guidance: true/false/null(desconhecido). null = ainda não soubemos -> não bloqueia. */
    const setGuidance = (v) => {
        const g = (v === true || v === 1 || v === 'true');
        if (g !== state.guidance) { state.guidance = g; onChange(state.front, 'guidance=' + g); }
    };
    someip.buildProxy(CPM, 'CarPlayManagerInst1').then((p) => p.init().then(() => {
        state.ok = true; log('gate ON: CarPlayManager (onScreenChange + projectedGuidanceActive)');
        p.subscribe({ name: 'onScreenChange', onReceive: (v) => {
            const o = (v && typeof v === 'object') ? v.screenOwner : v;
            const front = (o === 'PROJECTED' || o === 0);
            if (front !== state.front) { state.front = front; onChange(front, o); }
        }});
        p.subscribe({ name: 'projectedGuidanceActive', onReceive: (v) => setGuidance((v && typeof v === 'object') ? v.projectedGuidanceActive : v) });
        if (p.getValue) { p.getValue('projectedGuidanceActive').then((v) => setGuidance(v)).catch(() => {}); }
    })).catch((e) => log('gate falhou (seguindo sem gate): ' + (e && e.message || e)));
    return state;
}

/* ---------------------------------------------------------------- socket de controle (o app liga/desliga) */
function groupGid(name) {
    try { const l = fs.readFileSync('/etc/group', 'utf8').split('\n').find((x) => x.indexOf(name + ':') === 0); if (l) return parseInt(l.split(':')[2], 10) || -1; } catch (e) {}
    return -1;
}
function startControl(sockPath, status, onCmd, log) {
    const net = require('net');
    const clients = new Set();
    try { fs.mkdirSync(path.dirname(sockPath)); } catch (e) {}
    try { fs.unlinkSync(sockPath); } catch (e) {}
    const send = (sock, obj) => { try { sock.write(JSON.stringify(obj) + '\n'); } catch (e) {} };
    const srv = net.createServer((sock) => {
        clients.add(sock);
        sock.on('error', () => {}); sock.on('close', () => clients.delete(sock));
        let buf = '';
        sock.on('data', (d) => {
            buf += d.toString('utf8'); let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                if (!line) continue;
                let m; try { m = JSON.parse(line); } catch (e) { continue; }
                if (m.cmd && m.cmd !== 'status') onCmd(m.cmd);
                clients.forEach((c) => send(c, status()));
            }
        });
        send(sock, status());
    });
    srv.on('error', (e) => log('control: ' + (e && e.message || e)));
    srv.listen(sockPath, () => {
        try { const g = groupGid('tm_oap_app'); if (g >= 0) fs.chownSync(sockPath, 0, g); fs.chmodSync(sockPath, parseInt('660', 8)); } catch (e) { log('control perm: ' + (e && e.message || e)); }
        log('socket de controle em ' + sockPath + ' (enable/disable/status)');
    });
    return { status: () => clients.forEach((c) => send(c, status())) };
}

/* ---------------------------------------------------------------- captura */
function grab(a, cb) {
    const env = Object.assign({}, process.env, { WAYLAND_DISPLAY: a.wayland, XDG_RUNTIME_DIR: a.xdg });
    if (a.capture === 'png') {
        execFile(a.capTool || 'ivi-screenshot-control', ['--screenshot', a.screen, '-f', a.tmp], { env: env, timeout: 6000 }, (err) => {
            if (err) return cb(err);
            try { cb(null, decodePNG(fs.readFileSync(a.tmp))); } catch (e) { cb(e); }
        });
    } else {
        execFile(a.capTool || 'winston-grabber', ['-s', a.screen, '-n', '1', a.tmp], { env: env, timeout: 6000 }, (err) => {
            if (err) return cb(err);
            try { cb(null, readRaw(fs.readFileSync(a.tmp), a.capW, a.capH, a.order)); } catch (e) { cb(e); }
        });
    }
}

/* ---------------------------------------------------------------- args */
function parseArgs(argv) {
    const a = { socket: '/dev/shm/cluster-render/render.sock', target: 'map', fps: 3,
        crop: { x: 160, y: 0, w: 1020, h: 720 }, fit: 'cover', scale: 'nearest', order: 'bgra',
        capture: 'raw', mode: 'video', gate: true, gateInitial: 'front', wayland: 'wayland-0', xdg: '/run/wayland',
        capTool: '', screen: 'center', tmp: '', capW: 1920, capH: 720,
        control: true, ctlSock: '/dev/shm/carplay-map/ctl.sock', requireGuidance: false,
        requireFormat: true, calibrate: false,
        fmt: { mapX0: 0.10, mapY0: 0.12, mapX1: 0.58, mapY1: 0.88, rX0: 0.645, rY0: 0.06, rX1: 0.985, rY1: 0.95, satTh: 40, tMap: 5, tCells: 7, cellTh: 15, cols: 4, rows: 4, step: 70 },
        contend: true, once: false, infile: '', save: '', verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--socket') a.socket = argv[++i];
        else if (k === '--target') a.target = argv[++i];
        else if (k === '--fps') a.fps = Math.max(0.2, parseFloat(argv[++i]) || 3);
        else if (k === '--crop') { const m = (argv[++i] || '').split(','); a.crop = { x: +m[0], y: +m[1], w: +m[2], h: +m[3] }; }
        else if (k === '--fit') a.fit = argv[++i];
        else if (k === '--scale') a.scale = argv[++i];
        else if (k === '--order') a.order = argv[++i];
        else if (k === '--capture') a.capture = argv[++i];
        else if (k === '--mode') a.mode = argv[++i];
        else if (k === '--no-gate') a.gate = false;
        else if (k === '--gate-initial') a.gateInitial = argv[++i];
        else if (k === '--wayland') a.wayland = argv[++i];
        else if (k === '--xdg') a.xdg = argv[++i];
        else if (k === '--cap-tool') a.capTool = argv[++i];
        else if (k === '--screen') a.screen = argv[++i];
        else if (k === '--tmp') a.tmp = argv[++i];
        else if (k === '--cap-size') { const m = (argv[++i] || '').split('x'); a.capW = +m[0]; a.capH = +m[1]; }
        else if (k === '--no-contend') a.contend = false;
        else if (k === '--no-control') a.control = false;
        else if (k === '--ctl-sock') a.ctlSock = argv[++i];
        else if (k === '--require-guidance') a.requireGuidance = true;
        else if (k === '--no-require-guidance') a.requireGuidance = false;
        else if (k === '--require-format') a.requireFormat = true;
        else if (k === '--no-require-format') a.requireFormat = false;
        else if (k === '--fmt-map') { const m = (argv[++i] || '').split(','); a.fmt.mapX0 = +m[0]; a.fmt.mapY0 = +m[1]; a.fmt.mapX1 = +m[2]; a.fmt.mapY1 = +m[3]; }
        else if (k === '--fmt-right') { const m = (argv[++i] || '').split(','); a.fmt.rX0 = +m[0]; a.fmt.rY0 = +m[1]; a.fmt.rX1 = +m[2]; a.fmt.rY1 = +m[3]; }
        else if (k === '--fmt-th') { const m = (argv[++i] || '').split(','); a.fmt.satTh = +m[0]; a.fmt.tMap = +m[1]; a.fmt.tCells = +m[2]; }
        else if (k === '--fmt-cells') { const m = (argv[++i] || '').split(','); a.fmt.cols = +m[0]; a.fmt.rows = +m[1]; a.fmt.cellTh = +m[2]; }
        else if (k === '--calibrate') a.calibrate = true;
        else if (k === '--once') a.once = true;
        else if (k === '--infile') a.infile = argv[++i];
        else if (k === '--save') a.save = argv[++i];
        else if (k === '--verbose') a.verbose = true;
        else if (k === '-h' || k === '--help') { console.log('ver cabeçalho do arquivo'); process.exit(0); }
        else { console.error('opção desconhecida: ' + k); process.exit(2); }
    }
    if (!SIZES[a.target]) { console.error('target inválido'); process.exit(2); }
    if (!a.tmp) a.tmp = a.capture === 'png' ? '/dev/shm/carplay_map_cap.png' : '/dev/shm/carplay_map_cap.rgb';
    return a;
}

function log(s) { console.log(new Date().toISOString() + ' ' + s); }

function runOffline(a, outW, outH) {
    const buf = fs.readFileSync(a.infile);
    const img = /\.png$/i.test(a.infile) ? decodePNG(buf) : readRaw(buf, a.capW, a.capH, a.order);
    log('offline: ' + img.width + 'x' + img.height + ' (' + (img.bgr ? 'bgra' : 'rgb/rgba') + ', modo ' + a.mode + ') de ' + a.infile);
    const df = detectDashboard(img, a.fmt);
    log('offline formato: satMeio=' + df.satMap.toFixed(1) + '% células=' + df.cells + '/' + df.ncells + ' (satTh=' + a.fmt.satTh + ', tMap=' + a.fmt.tMap + ' tCells=' + a.fmt.tCells + ') -> ' + (df.dashboard ? 'DASHBOARD (espelha)' : 'NÃO-dashboard (esconde)'));
    let rgba;
    if (a.mode === 'video') rgba = yuvAtlasToRGBA(processToYUV(img, { outW: outW, outH: outH, crop: a.crop, fit: a.fit, scale: a.scale }), outW, outH);
    else rgba = processImage(img, { outW: outW, outH: outH, crop: a.crop, fit: a.fit, scale: a.scale }).rgba;
    fs.writeFileSync(a.save || 'preview.png', encodePNG(rgba, outW, outH));
    log('offline: gravado ' + outW + 'x' + outH + ' -> ' + (a.save || 'preview.png'));
}

function main() {
    const a = parseArgs(process.argv.slice(2));
    const [outW, outH] = SIZES[a.target];
    a.interval = Math.round(1000 / a.fps);
    a.fmtInterval = 350; /* CarPlay na frente mas formato errado: sonda ~3x/s até voltar */
    if (a.infile) { runOffline(a, outW, outH); return; }

    if (a.calibrate) {
        grab(a, (err, img) => {
            if (err) { console.error('captura falhou: ' + (err.message || err)); process.exit(1); }
            const d = detectDashboard(img, a.fmt);
            log('CALIBRAÇÃO ' + img.width + 'x' + img.height + ': satMeio=' + d.satMap.toFixed(1) + '% células=' + d.cells + '/' + d.ncells + ' (satTh=' + a.fmt.satTh + ', cellTh=' + a.fmt.cellTh + ')');
            log('limiares: meio>=' + a.fmt.tMap + '%  células<=' + a.fmt.tCells + '  ->  ' + (d.dashboard ? 'DASHBOARD (espelharia)' : 'NÃO-dashboard (esconderia)'));
            if (a.save) { try { fs.writeFileSync(a.save, encodePNG(toRGBA(img), img.width, img.height)); log('frame salvo em ' + a.save); } catch (e) { log('save falhou: ' + e.message); } }
            process.exit(0);
        });
        return;
    }

    const { ClusterRender } = require('./cluster_render_client.js');
    const cr = new ClusterRender('carplay_map_shot', a.socket);
    cr.on('ready', () => log('cluster-render ready: backend ' + cr.backend + ', targets ' + cr.targets));
    cr.on('disconnected', () => log('desconectado do cluster-render'));
    cr.on('layer', (ref, st, why) => log('layer ' + st + (why ? ': ' + why : '')));
    cr.on('target', (t, st, h, why) => log('target ' + t + ' ' + st + (h && h !== 'none' ? ' (holder ' + h + ')' : '') + (why ? ': ' + why : '')));
    cr.on('budget', (c, m, why) => log('budget ' + c + '/' + m + ' KB/s' + (why ? ': ' + why : '')));
    cr.on('refused', (op, ref, why) => log('RECUSADO ' + op + (why ? ': ' + why : '')));

    const ref = a.mode === 'video'
        ? cr.video({ target: a.target, x: 0, y: 0, w: outW, h: outH, vw: outW, vh: outH, fps: Math.max(1, Math.round(a.fps)), contend: a.contend })
        : cr.image({ target: a.target, x: 0, y: 0, w: outW, h: outH, iw: outW, ih: outH, contend: a.contend, sampling: 'bilinear' });
    if (!ref) { console.error(a.mode + ' layer recusado'); process.exit(1); }
    log('alvo ' + a.target + ' ' + outW + 'x' + outH + ' (' + a.mode + '), crop ' + [a.crop.x, a.crop.y, a.crop.w, a.crop.h].join(',') +
        ', fit ' + a.fit + '/' + a.scale + ', captura ' + a.capture + '(' + a.order + '), ' + a.fps + ' fps, gate ' + (a.gate ? 'on' : 'OFF') + (a.requireGuidance ? ' (só navegando)' : '') +
        ', formato ' + (a.requireFormat ? 'Dashboard (meio>=' + a.fmt.tMap + '% células<=' + a.fmt.tCells + ')' : 'OFF'));
    cr.connect();

    const ctlState = { masterEnabled: true };
    let hub = null;
    const gate = a.gate ? startGate(a.gateInitial !== 'menu', log, (front, o) => { log('>> screenOwner=' + o + ' -> ' + (front ? 'MOSTRAR mapa' : 'ESCONDER (mapa stock volta)')); if (hub) hub.status(); })
        : { front: true, ok: false };
    let fmtState = null; /* null = ainda não capturou; true = Dashboard; false = outro formato */
    function ctlStatus() {
        const fmtOk = !a.requireFormat || fmtState === true;
        const mirror = ctlState.masterEnabled && gate.front && (!a.requireGuidance || gate.guidance !== false) && fmtOk;
        return { ev: 'status', state: !ctlState.masterEnabled ? 'off' : (mirror ? 'on' : 'standby'),
            enabled: ctlState.masterEnabled, carplay: !!gate.front, guidance: gate.guidance, format: fmtState };
    }
    hub = a.control ? startControl(a.ctlSock, ctlStatus, (cmd) => { if (cmd === 'enable') ctlState.masterEnabled = true; else if (cmd === 'disable') ctlState.masterEnabled = false; log('>> controle: ' + cmd); }, log) : null;

    let stopped = false, frames = 0, t0 = Date.now(), shownState = null;
    function apply(want) {
        if (want && shownState !== true) { cr.set(ref, { visible: true }); shownState = true; }
        else if (!want && shownState !== false) { cr.set(ref, { visible: false }); shownState = false; }
    }
    const endOnce = () => { stopped = true; cr.close(); process.exit(0); };
    function tick() {
        if (stopped) return;
        /* base: ligado + CarPlay na frente (+ navegando, se exigido). Sem isso, nem captura. */
        const base = ctlState.masterEnabled && gate.front && (!a.requireGuidance || gate.guidance !== false);
        if (!base) { apply(false); setTimeout(tick, 400); return; }
        const t = Date.now();
        grab(a, (err, img) => {
            if (err) { log('captura falhou: ' + (err.message || err)); apply(false); if (a.once) return endOnce(); return setTimeout(tick, 500); }
            /* gate de formato: só mostra no layout Dashboard (mapa à esq + cards cinza à dir) */
            if (a.requireFormat) {
                const d = detectDashboard(img, a.fmt);
                if (d.dashboard !== fmtState) {
                    fmtState = d.dashboard;
                    log('>> formato ' + (d.dashboard ? 'Dashboard' : 'outro') + ' (meio ' + d.satMap.toFixed(1) + '% / células ' + d.cells + '/' + d.ncells + ') -> ' + (d.dashboard ? 'MOSTRAR mapa' : 'ESCONDER (mapa stock volta)'));
                    if (hub) hub.status();
                }
                if (!d.dashboard) { apply(false); if (a.once) return endOnce(); return setTimeout(tick, a.fmtInterval); }
            }
            apply(true);
            try {
                if (a.mode === 'video') {
                    const atlas = processToYUV(img, { outW: outW, outH: outH, crop: a.crop, fit: a.fit, scale: a.scale });
                    cr.frame(ref, atlas, frames); frames++;
                    if (a.save && frames === 1) fs.writeFileSync(a.save, encodePNG(yuvAtlasToRGBA(atlas, outW, outH), outW, outH));
                } else {
                    const o = processImage(img, { outW: outW, outH: outH, crop: a.crop, fit: a.fit, scale: a.scale });
                    cr.pixels(ref, null, o.rgba); frames++;
                    if (a.save && frames === 1) fs.writeFileSync(a.save, encodePNG(o.rgba, outW, outH));
                }
                if (a.verbose || frames % Math.max(1, Math.round(a.fps * 10)) === 0)
                    log('frame ' + frames + ' (' + img.width + 'x' + img.height + '->' + outW + 'x' + outH + ', ' + (Date.now() - t) + ' ms, ' + (frames / ((Date.now() - t0) / 1000)).toFixed(1) + ' fps)');
            } catch (e) { log('processamento falhou: ' + e.message); }
            if (a.once) return endOnce();
            setTimeout(tick, Math.max(0, a.interval - (Date.now() - t)));
        });
    }
    tick();

    const end = () => { stopped = true; try { cr.set(ref, { visible: false }); } catch (e) {} cr.close(); setTimeout(() => process.exit(0), 150); };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
}

if (require.main === module) main();
module.exports = { decodePNG, encodePNG, readRaw, processImage, detectDashboard, satPct };
