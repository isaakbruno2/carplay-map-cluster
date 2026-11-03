# CarPlay map → instrument cluster (capture-based) — iDrive7 MGU

Puts the **CarPlay map** (Waze / Google Maps / Apple Maps) onto the **instrument
cluster** of a BMW iDrive7 MGU, on CarPlay builds that the
[`waze-on-cluster`](https://github.com/robertnisipeanu/idrive-apps) patch refuses —
e.g. CarPlay **`0.20.20`**, firmware `G_20w28.3`, MainApp 7.1.2, `carplay` sha
`8ae226…`. **No patch, no firmware update, no modified BMW binaries.**

> It's a pragmatic *mirror*, not a second video stream. Read **"What it is (and isn't)"**
> and **"Limitations"** before expecting it to behave like the real thing.

---

## What it is (and isn't)

The `waze-on-cluster` patch asks CarPlay for a **second, independent video stream** for
the cluster. That machinery (`AlternateDisplays`, `requestStream`, …) **isn't present in
CarPlay 0.20.20** — confirmed from the `carplay` binary *and* its SOME/IP interface — so
no patch can unlock it on this build.

This takes a different route: it **captures the central display** (where CarPlay is
already drawing the map), crops the map region, and paints it into the cluster map slot
via robertn's **`cluster-render`**, ~6 fps. It's a live **copy** of the map you're already
looking at on the big screen.

- **Format gate:** it only mirrors when CarPlay is in the **Dashboard** layout (map on the
  left + the two side cards). It does **not** mirror a fullscreen map, and not non-map
  screens (home / music / phone). It decides this from the frame itself (colour + layout
  structure), so it keeps working regardless of music, album art, or map zoom.
- **In-car on/off app** ("Mapa no Cluster") toggles it without SSH.
- **Auto-starts on boot** (packaged as an `mgu-deploy` tool).
- **Reversible & non-invasive:** kill the process → the stock cluster returns. Touches no
  BMW binary and no HDCP.

## Who this is for

iDrive7 **MGU** (high cluster, `kombi/high_4_1`), rooted, with **MGU Store** working.
Tested on a BMW G20 320i (2020, `G_20w28.3`, CarPlay `0.20.20`). Same unit as the one in
[idrive-apps#8](https://github.com/robertnisipeanu/idrive-apps/issues/8).

## Prerequisites (on the unit)

1. **`cluster-render`** installed and running (from **MGU Store**) — the DCSM2/RAMSES
   engine that owns the cluster map slot (`0x100`, 1088×480). **This does the hard part.**
2. **`app-privacy`** (from MGU Store) — only needed for the in-car on/off app.
3. **Node** (`/usr/bin/node`), **`winston-grabber`**, **`someip.node`** — already on the MGU.
4. **root SSH** on the unit.

`cluster_render_client.js` is part of `cluster-render` (robertn's, GPL-3.0) and is **not**
redistributed here — the installer takes it from your `cluster-render` package.

## Install (turnkey)

On your PC, copy this repo to the unit (or `git clone` it there), then run the installer
on the unit as root:

```sh
# on the unit, repo root:
chmod +x install/install.sh
# point it at cluster_render_client.js from your cluster-render package
# (tar xzf cluster-render@*.tgz  -> files/cluster_render_client.js):
./install/install.sh /path/to/cluster_render_client.js
```

The installer checks prereqs, builds the `mgu-deploy` tool package (recomputing checksums),
installs the **producer** + the **on/off app**, and starts it. Open CarPlay on a map
(Dashboard layout) and the cluster lights up.

## Manual run (quick test, no install)

```sh
# as root, on the unit, in producer/ (with cluster_render_client.js alongside):
WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/wayland \
  node carplay-map-cluster.js --fps 6 --gate-initial menu --verbose
```

## Options / tuning

- `--calibrate` — grab one frame, print the format numbers + verdict (to tune the gate on
  your unit).
- `--no-require-format` — disable the format gate (mirror any CarPlay screen).
- `--fmt-th SAT,TMAP,TCELLS`, `--fmt-map x0,y0,x1,y1`, `--fmt-right x0,y0,x1,y1` — gate
  thresholds / regions (fractions 0..1).
- `--crop X,Y,W,H` — map region of the 1920×720 capture (default `160,0,1020,720`).
- `--fps N`, `--mode video|image`, `--no-gate`, `--once`, `--infile X.png` (offline test).
  See the header of [`producer/carplay-map-cluster.js`](producer/carplay-map-cluster.js)
  for the full list.

## How the format gate works

The Dashboard is the only CarPlay screen with a **colourful map on the left** and a
**column of UI cards on the right**. The detector measures: (1) the middle is colourful
(= a map), and (2) the colour on the right is **concentrated** (an album-art thumbnail),
not **spread** (a map filling the right). A fullscreen map spreads colour across the whole
right; a no-map screen has no colour in the middle. Tunable via `--fmt-th`.

## Limitations (honest)

- **CarPlay minimized** (BMW menu in front): nothing to capture — the phone stops
  projecting and the only readable surface becomes the BMW UI, so the map can't show then.
  The 2nd-stream / virtual-display path that would fix this isn't in `0.20.20` (verified
  from the binary + its SOME/IP interface — a single projected screen only).
- **Fullscreen map**: intentionally not mirrored. A fullscreen view whose right side is
  very dark/empty can occasionally slip through the gate; tune `--fmt-th` or toggle off.
- **fps**: ~6 (the cluster link's upload budget is ~6 MB/s; 8 fps flashed the cluster
  black). Continuous capture could reach ~8 — not implemented here.

## Repo layout

```
producer/   carplay-map-cluster.js   the capture→cluster producer (Node, MPL-2.0)
app/        carplay_map_toggle/      in-car on/off app (OAP app, needs app-privacy)
packages/   carplay-map-tool/        mgu-deploy tool template (component.json + unit)
install/    install.sh               builds the tool package and installs everything
```

## Credits & license

The heavy lifting — DCSM2, RAMSES, the cluster slot — is **robertn's
[`cluster-render`](https://github.com/robertnisipeanu/idrive-apps)** (MGU Store). This repo
is glue around it. Huge thanks to robertn and the idrive-apps / mgu-store community.

Our code (the producer and the app) is **MPL-2.0**. `cluster-render` and its
`cluster_render_client.js` are **GPL-3.0-or-later** (robertn's) and are **not** included
here — install them from MGU Store. See [`LICENSE`](LICENSE).
