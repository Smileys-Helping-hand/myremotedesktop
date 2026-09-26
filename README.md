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
| Linux `.deb` / `.rpm` | No — your package manager owns those files. Use `sudo apt install --only-upgrade remote-desk` or `sudo dnf upgrade remote-desk`, or switch to the AppImage. |

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

Each installation has a **Desk ID** that never changes, a name, and a rule for who may
connect. They live in the app's config directory, not in the page, so the ID you give someone
keeps working after a restart.

### The short way: save the machine once

On the machine you want to reach, open **Host**, choose **Saved password** under *Who can
connect*, type a password, and press **Save**. Then press **Copy Link**.

On the other machine, open **My Devices**, paste that link, and press **Add** then **Save
Device**. From then on it is one click — or a double-click on the card.

The link carries every address the host knows, LAN first and a public tunnel last, so the same
saved device works from either side of the internet: connecting tries each in turn.

If you would rather not paste anything, **Find On My Network** sweeps this network and lists
the machines running RemoteDesk, with a **Save As Device** button on each.

### The long way, by hand

On the **host**: open the **Host** tab, click **Start Real Screen Share**, pick the display or
window to share, and read off the 6-digit **Desk ID** and the `http://<ip>:4000` address under
it.

On the **client**: switch to the **Client** tab *(on Linux the UI opens in your browser — that
is expected; see *Linux: how it runs*)*, put the host's address in the server field, enter the
Desk ID, and click **Connect**.

Both machines must be able to reach that address. On the same LAN they can. On different
networks you do not need an address at all — see *Connecting across networks* below.

> **Windows firewall:** the installer adds an inbound rule (`RemoteDesk Signaling`, TCP
> 4000-4009) for **private and domain networks only**, since without it other machines cannot
> reach the host and neither side reports an error. It is removed on uninstall. If you would
> rather not have it, delete `installerHooks` from `src-tauri/tauri.conf.json` and rebuild —
> you can then allow RemoteDesk manually when Windows prompts.

### Access control

*Who can connect*, on the Host tab, is one of four:

- **Ask me first** (default) — nobody gets in until someone at the host presses **Allow** on
  the prompt. Note that this is a flag on the room, not an empty PIN: a room with no PIN admits
  everyone, so "ask" had to be made explicit.
- **Saved password** — a fixed password admits a client with no prompt. This is what the other
  machine saves, and what makes reconnecting one click. A client with the wrong password still
  raises the prompt.
- **Rotating PIN** — a PIN that changes every minute, read off the host's screen. Good for a
  one-off; useless for saving, by design.
- **Anyone with ID** — no secret at all. Trusted networks only.
- Remote input is refused entirely until the host grants control, and it is suspended for
  2.5 seconds whenever someone physically moves the mouse at the host — so the person sitting
  at the machine always wins.
- `Ctrl+Alt+Shift+K` revokes remote control immediately, from anywhere.

### Connecting across networks

**Type the Desk ID and press Connect. That is all.** Every host registers its Desk ID in two
places: its own embedded server, for the LAN, and the **public relay**, for everywhere else. A
client asks its own network first and, if the desk is not there, asks the relay — by itself,
with nothing to configure. The Host tab says **Reachable from anywhere** when this is working.

The relay (`relay/`, a Cloudflare Worker) only introduces the two machines: it carries the few
kilobytes of the WebRTC handshake. The screen, the mouse and the keyboard still travel directly
between the two machines, encrypted end to end by WebRTC.

Being on the open internet changes a few rules, and the relay enforces them:

- **A Desk ID belongs to the machine that first registered it.** Each installation has a secret
  relay key (in its profile, never shown on the network); the relay keeps only its hash and
  refuses anyone else who tries to register the same ID. Without this, someone who learned your
  Desk ID could sit in your room and receive your password when you connected. An ID unused for
  30 days can be claimed again, so a reinstall that lost its key is not locked out forever.
- **"Anyone with ID" desks stay on their own network.** A six-digit ID is a million guesses
  from open; the relay refuses such a desk and the Host tab says why. Use *Saved password*,
  *Ask me first* or *Rotating PIN* to be reachable from other networks.
- **Nothing is listed.** The relay never reveals which Desk IDs exist, and an address that keeps
  guessing IDs is throttled.

To run your own relay instead, deploy `relay/` to your Cloudflare account (`cd relay && npm
install && npx wrangler deploy`) and point the app at it, or turn the relay off, from the
browser console:

```js
localStorage.setItem('remotedesk_relay_url', 'https://your-relay.example'); // or 'off'
```

`npx tsx scripts/check-relay.ts <relay-url>` checks a relay end to end.

Two older routes still work, and are useful for a browser with nothing installed:

- **Quick tunnel** — **Need a web link for a browser with nothing installed?** on the Host tab
  gives an `https://…trycloudflare.com` address a phone browser can open. This requires
  [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  on the host's PATH; it is not bundled.
- **Tailscale** — with both machines on the same tailnet, the host's `100.x.y.z` address works
  like a LAN address from anywhere.

Signaling is only half of it. Once the peers have found each other, the **media** still has to
get through, and that depends on your NAT:

| Situation | Works? |
|---|---|
| Both peers on ordinary home routers | Yes — STUN discovers each peer's public address and they hole-punch a direct path. This is the common case and needs no extra setup. |
| Either peer behind symmetric NAT or a mobile carrier (CGNAT), e.g. a laptop on a phone hotspot | Only with TURN. Hole punching cannot work there. |

**TURN comes from the relay, when it is switched on.** TURN carries the actual video, so it
costs bandwidth: Cloudflare bills standalone TURN at $0.05 per GB. The relay hands out
short-lived Cloudflare TURN credentials — only inside the handshake, to a host that proved its
Desk ID or a client its host admitted — once both secrets are set:

```bash
cd relay
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Without them, sessions between ordinary home and office networks still work; only the
symmetric-NAT case above does not.

To use a TURN server of your own instead, run [coturn](https://github.com/coturn/coturn) on any
VPS, or use a hosted provider, then set it in the browser console on both peers:

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

## Updating

**In the app:** *Get the App* → **Check for updates** → **Download and install**. The app
fetches the package, verifies it, replaces itself and restarts. There is nothing to download by
hand and nothing to uninstall first.

It asks three kinds of place, nearest first:

1. **Machines in My Devices** — every saved address.
2. **Machines on this network** — anything answering a sweep.
3. **The release endpoint** compiled into the app.

The first two are what make a pair of machines with no internet able to keep each other
current. Any machine running RemoteDesk publishes `/updates/latest.json` describing whatever
packages sit in its library folder, and serves them over the same HTTP server the session uses.
The Updates panel names that folder: drop the Windows `.exe` and the Linux `.AppImage` (each
with its `.sig`) in there and the other machine can update from this one.

Peer manifests are fetched over plain HTTP — machines on a LAN have no
certificates — which the updater refuses by default, so `dangerousInsecureTransportProtocol`
is enabled in `src-tauri/tauri.conf.json`. Read that flag precisely: it affects the *transport*,
not the verification. A machine on your network that intercepted the manifest could withhold an
update or point at a different package, but a package that is not signed with the project key is
refused, and the updater only ever moves to a higher version — so the worst available attack is
to delay an update, not to install anything. The release endpoint remains `https`.

**Serving an update does not mean being trusted to supply one.** Every package is verified
against the signing key compiled into the running binary before anything is written, so a
machine on your network can offer an update but cannot forge one. A package without a matching
`.sig` is skipped when the manifest is built rather than offered and refused after the
download.

Two things cannot update in place, and say so instead of showing a button that would fail: a
`.deb` or `.rpm`, which the system package manager owns, and a development build.

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
| `relay/` | The public relay that lets machines on different networks meet by Desk ID |
| `src/utils/publicRelay.ts` | Which relay the app uses, and when a client falls back to it |
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
