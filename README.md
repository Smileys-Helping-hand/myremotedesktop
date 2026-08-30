# RemoteDesk

Low-latency WebRTC remote desktop built with React + Tauri, with
native OS input injection in Rust.

A host shares a display; a client sees it and drives the host's real mouse and keyboard.
Video and input travel peer-to-peer over WebRTC — they never pass through a server.

**The installed app is self-contained.** It embeds its own signaling server, so hosting needs
no Node process, no account, and no cloud service. Install it on two machines on the same
network and they can find each other immediately.

Windows and Linux can each host or connect, in either direction, with full mouse, keyboard and
clipboard control. On Linux the session UI runs in your browser rather than the app window —
the app opens it for you, and *Linux: how it runs* below explains why.

---

## Install

Grab the installer for your platform from the
[Releases](../../releases) page.

| Platform | File | Install |
|---|---|---|
| Windows 10/11 (x64) | `RemoteDesk_<version>_x64-setup.exe` | Run it (installs per-machine, so it prompts for admin). Requires the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/), preinstalled on Windows 11 and current Windows 10. |
| Debian / Ubuntu | `remote-desk_<version>_amd64.deb` | `sudo apt install ./remote-desk_<version>_amd64.deb` |
| Fedora / RHEL | `remote-desk-<version>.x86_64.rpm` | `sudo dnf install ./remote-desk-<version>.x86_64.rpm` |
| Any Linux | `remote-desk_<version>_amd64.AppImage` | `chmod +x` it, then run it. |

### Staying up to date

**The app updates itself.** When a new version is published, RemoteDesk offers it in a banner
at the top of the window; one click downloads and installs it in place and reopens on the new
version. There is no uninstall-download-reinstall step.

Every update is verified before it is applied: each package is signed with a minisign key, and
the app checks that signature against the public key compiled into it. A package that does not
verify is refused, so a compromised download host cannot push a modified build.

| How you installed it | In-app updates |
|---|---|
| Windows `.exe` | Yes |
| Linux `.AppImage` | Yes |
| Linux `.deb` / `.rpm` | No — your package manager owns those files. Use `sudo apt install --only-upgrade remotedesk` or `sudo dnf upgrade remotedesk`, or switch to the AppImage. |

The app knows which of these it is and says so rather than offering a button that cannot work.

> **One-time catch:** self-updating arrived in this build. Any copy installed from an earlier
> one has no updater in it at all and cannot pull itself forward — replace it manually once,
> and every version after that updates in place.

### Getting the app from a machine already running it

Any browser pointed at a running host — `http://<host-ip>:4000` on the LAN, or the tunnel URL
from anywhere — has a **Get the App** tab listing the installers that host is offering, with
the one matching your operating system first.

That list is whatever is really on disk: nothing is shown unless it can actually be downloaded,
and a server holding no installers links to the releases page instead. A packaged RemoteDesk
ships no installers (it would have to contain itself), so to use a machine as your office
download point, put the files in an `installers` directory beside the executable — or point
`REMOTEDESK_INSTALLERS_DIR` at wherever they live. The standalone relay does the same, reading
`installers/` at the repository root by default.

### Linux: how it runs

On Linux the app **opens the session UI in your default browser** instead of drawing it in the
app window, and serves it from its own embedded server at `http://127.0.0.1:4000/`. The app
window stays open running the signaling server and, when hosting, the input injection.

This is not a workaround for a bug in RemoteDesk — it is the only way to get WebRTC on Linux
today. Tauri renders in the system webview, which on Linux is WebKitGTK, and WebRTC lives in
that webview. Measured directly on three distributions:

| Distribution | WebKitGTK | `getDisplayMedia` | `RTCPeerConnection` |
|---|---|---|---|
| Ubuntu 22.04 | 2.50.4 | available | **missing** |
| Ubuntu 24.04 | 2.52.3 | available | **missing** |
| Fedora 44 | 2.52.5 | available | **missing** |

These distributions compile WebKitGTK with `ENABLE_WEB_RTC=OFF`. The app switches on
`enable-media-stream`, `enable-mediasource` and `enable-webrtc` at startup (they default to off,
and neither Tauri nor wry enables them) and reads the values back to confirm they applied —
screen capture appears, `RTCPeerConnection` does not, because no application setting can add a
backend that was never compiled in. Firefox and Chromium have full WebRTC, so the session runs
there instead.

#### How the browser page still controls the machine

A browser page cannot call Tauri IPC, so the host process exposes the same commands — input
injection, display selection, clipboard — over a **local control channel** on the embedded
server. Two independent gates protect it, because whatever is on the other end can move your
mouse and type on your machine:

- **Loopback only.** The server binds `0.0.0.0` so peers can reach signaling, but the control
  endpoint refuses anything that is not a loopback connection.
- **A per-run key.** 256 bits from the OS random source, minted at startup and never reused.
  The app puts it in the link it opens; the page takes it out of the address bar immediately so
  it does not linger in history or in a screenshot of the session. A page without it can watch,
  but cannot control.

Injection still passes the same gate as the desktop path: nothing is injected until you grant
control, the kill switch suspends it when you touch the machine yourself, and
`Ctrl+Alt+Shift+K` revokes it.

The app prints that link at startup. If no browser opens — a headless box, or no default
browser — open it yourself from the app's output. Treat it like a password.

#### Input backends

Injection uses X11/XTest wherever an X display exists, including XWayland on a Wayland desktop.
That is asked for explicitly rather than left to chance: enigo keeps whichever backend connects
first, and libwayland connects even when `WAYLAND_DISPLAY` is unset, so on GNOME, KDE or WSLg
the Wayland backend would win and then silently do nothing — injection reporting success while
the cursor never moves. Wayland is used only when there is no X11 connection at all, which needs
the wlroots virtual-input protocols (Sway, Hyprland).

At startup the app moves the cursor a few pixels and checks it landed, and says so in its log:

```
[remotedesk] input backend: X11/XTest — verified, cursor responds
```

If that line carries a warning instead, remote control will not work on that session — run it
under Xorg or XWayland.

If your distribution ever ships a WebKitGTK built with `ENABLE_WEB_RTC=ON`, the app window will
run the session itself and the browser handoff stops happening — the check is made at runtime.

### Linux prerequisites

Needs WebKitGTK 2.38 or newer (`libwebkit2gtk-4.1`), which every current distro ships.

Screen capture goes through `xdg-desktop-portal`; the `.deb` and `.rpm` declare it as a
dependency, but the AppImage cannot. To check a machine before you rely on it:

```bash
bash linux/setup-linux.sh
```

It reports what is present and prints the exact install command for anything missing. It needs
no root and changes nothing.

Input injection has no setup step, and the app tells you at startup whether it works on your
session — see *Input backends* above.

---

## Connecting two machines

On the **host**:

1. Open RemoteDesk and stay on the **Host** tab.
2. Click **Start Real Screen Share** and pick the display to share.
3. Note the 6-digit **Desk ID**, and the `http://<ip>:4000` address shown under it.

On the **client**:

1. Open RemoteDesk and switch to the **Client** tab. *(On Linux the UI opens in your browser —
   that is expected; see *Linux: how it runs*.)*
2. Put the host's `http://<ip>:4000` address in the server field.
3. Enter the Desk ID and click **Connect**.

Both machines must be able to reach that address. On the same LAN they can. Across the
internet, see *Connecting across networks* below.

> **Windows firewall:** the installer adds an inbound rule (`RemoteDesk Signaling`, TCP
> 4000-4009) for **private and domain networks only**, since without it other machines cannot
> reach the host and neither side reports an error. It is removed on uninstall. If you would
> rather not have it, delete `installerHooks` from `src-tauri/tauri.conf.json` and rebuild —
> you can then allow RemoteDesk manually when Windows prompts.

### Access control

- **Unattended access** (default) admits any client that knows the Desk ID — convenient for
  your own machines, and the setting to turn off for anything else.
- With unattended access off, a **rotating PIN** is required, and a client whose PIN does not
  match has to be approved by the operator at the host.
- Remote input is refused entirely until the host grants control, and it is suspended for
  2.5 seconds whenever someone physically moves the mouse at the host — so the person sitting
  at the machine always wins.
- `Ctrl+Alt+Shift+K` revokes remote control immediately, from anywhere.

### Connecting across networks

Two peers behind different routers cannot dial each other's private addresses, so the host
needs a publicly reachable address for signaling:

- **Quick tunnel** — click **Generate Public Cloudflare URL** on the host. This requires
  [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  on the host's PATH; it is not bundled. The client then uses the printed `https://…` URL as
  its server address.
- **A shared relay** — run the standalone signaling relay (below) somewhere both peers can
  reach, and point both at it.

Signaling is only half of it. Once the peers have found each other, the **media** still has to
get through, and that depends on your NAT:

| Situation | Works? |
|---|---|
| Both peers on ordinary home routers | Yes — STUN discovers each peer's public address and they hole-punch a direct path. This is the common case and needs no extra setup. |
| Either peer behind symmetric NAT or a mobile carrier (CGNAT) | Not without a TURN relay. Hole punching cannot work, and there is no relay configured by default. |

**There is no TURN server bundled**, deliberately. TURN relays the actual video, so it needs a
machine with a public IP and real bandwidth. The free public relays that projects like this one
used to hard-code no longer accept anonymous allocations — shipping credentials that fail is
worse than shipping none, because it looks like relay coverage exists when it does not.

To add your own, run [coturn](https://github.com/coturn/coturn) on any VPS, or use a hosted
provider, then set it in the browser console on both peers:

```js
localStorage.setItem('remotedesk_ice_servers', JSON.stringify([
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:your-server.example:3478', username: 'user', credential: 'secret' },
]));
```

`src/utils/iceProbe.ts` reports what your configuration actually achieves — whether a public
address was discovered, and whether a relay candidate is really obtainable — so you find out
before a session rather than during one.

> **If your quick tunnel serves 404s:** RemoteDesk starts `cloudflared` with an empty
> `--config` on purpose. Without it, `cloudflared` inherits `~/.cloudflared/config.yml`, and if
> you already run a named tunnel for something else, that file's `ingress:` rules take over and
> `--url` is silently ignored — you get a working-looking public URL where every request is
> answered by the other tunnel's catch-all rule. If you invoke `cloudflared` by hand, pass
> `--config` yourself.

### What each device can do

The browser rule that decides this is the **secure context**: `getDisplayMedia` and WebCrypto
exist only on `https`, on `localhost`, or in the desktop app. `RTCPeerConnection` carries no
such restriction, which is why joining works in more places than hosting does.

| How you reach it | Connect to a host | Host a session |
|---|---|---|
| The installed desktop app | Yes | Yes |
| `http://<lan-ip>:4000` from a phone, tablet or laptop browser | Yes | No — the browser withholds screen capture on a plain-http LAN address |
| The `https://…` quick-tunnel URL, from anywhere | Yes | Yes — it is https, so capture is allowed |
| `http://localhost:4000` on the host machine itself | Yes | Yes |

So a phone on the sofa can drive a desktop over Wi-Fi with nothing installed; and if you want
that phone to *share its own* screen, reach it through the tunnel URL rather than the LAN one.

---

## Building from source

Prerequisites: [Node.js 20+](https://nodejs.org/) and a [Rust toolchain](https://rustup.rs/).

```bash
npm install
```

On Debian/Ubuntu, the Rust build also needs:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxkbcommon-dev libwayland-dev libdbus-1-dev libssl-dev build-essential
```

Then:

```bash
npm run dev
```

to develop, or:

```bash
npm run package
```

to produce installers in `src-tauri/target/release/bundle/`. Tauri builds for the machine it
runs on — Windows installers on Windows, Linux packages on Linux. The GitHub Actions workflow
in `.github/workflows/build.yml` builds both.

### Checks

```bash
npm run lint            # TypeScript + clippy
npm test                # frontend unit tests
npm run test:rust       # Rust unit tests
npm run check:signaling # signaling protocol conformance against a running server
```

---

## Releasing

Tagging `v*` builds installers for Windows and Linux and drafts a GitHub release.

For **in-app updates to reach anyone**, two things must be true:

1. **The CI secrets are set.** `TAURI_SIGNING_PRIVATE_KEY` holds the contents of the private
   key, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` its password. Without them the installers
   still build, but no signatures and no `latest.json` are produced, and existing installs
   never see the release. Generate a keypair once with:

   ```bash
   npm run tauri signer generate -- -w ~/.remotedesk-keys/remotedesk-updater.key
   ```

   The public half belongs in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`; the
   private half must never be committed. **If it is lost, no existing installation can ever be
   updated again** — they will refuse every future build, since nothing will match the key they
   were compiled with.

2. **The draft release is published.** Builds are drafted deliberately, so a bad one cannot
   reach users by accident. The updater polls `releases/latest`, which ignores drafts — until
   you press Publish, nothing is offered to anyone.

Bump the version in `src-tauri/tauri.conf.json` and `package.json` together before tagging;
the version in the manifest is what an installed copy compares itself against.

## How it fits together

```
   HOST                                             CLIENT
┌────────────────────────┐                   ┌────────────────────────┐
│ webview (React)        │                   │ webview (React)        │
│  getDisplayMedia ──────┼──── WebRTC ───────┼──> <video>             │
│  inject ◀──────────────┼─ data channels ───┼─── mouse / keyboard    │
├────────────────────────┤                   └────────────────────────┘
│ Rust host process      │                                │
│  • input injection     │      offer / answer / ICE      │
│  • kill switch         │◀───────────────────────────────┘
│  • signaling server ───┼── :4000
└────────────────────────┘
```

The Rust process does what a webview cannot: enumerate physical displays, inject input at the
OS level, and run the signaling server. Every injection passes a single gate in
`src-tauri/src/input.rs` that the renderer cannot reach — so a compromised webview still
cannot move the host's mouse without the operator's grant.

| Path | What lives there |
|---|---|
| `src/` | React UI, WebRTC hook, signaling client |
| `src/utils/signaling.ts` | The wire protocol, and the client both servers speak to |
| `src-tauri/src/input.rs` | Input injection and the authorization gate |
| `src-tauri/src/signaling.rs` | The embedded signaling server |
| `src-tauri/src/platform.rs` | Per-OS capability reporting |
| `server/index.ts` | Optional standalone relay (also serves the web client) |

### The optional standalone relay

Not needed for normal use. Run it when peers cannot reach each other directly, or to let
someone join from a browser with nothing installed:

```bash
npm run build
npm run start:signal
```

It serves the built web client and speaks exactly the protocol in `src/utils/signaling.ts`.
`npm run check:signaling` runs the same conformance suite against either server, which is what
keeps the two implementations interchangeable.
