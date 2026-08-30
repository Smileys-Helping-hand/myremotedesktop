#!/usr/bin/env bash
# =============================================================================
# RemoteDesk Linux readiness check.
#
# RemoteDesk needs two things from the desktop it runs on:
#
#   1. Screen capture — provided by xdg-desktop-portal + PipeWire, which the
#      webview calls through getDisplayMedia().
#   2. Input injection — XTest on X11, or, on Wayland, either the RemoteDesktop
#      portal (GNOME, KDE) or the wlroots virtual-input protocols (Sway,
#      Hyprland). All three backends are compiled in and chosen at runtime.
#
# Nothing here needs root, and nothing writes to your system: this reports what
# is present and prints the install command for whatever is missing.
# =============================================================================

set -uo pipefail

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
bad()  { echo -e "  ${RED}✗${NC} $1"; }

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}  RemoteDesk — Linux readiness check                  ${NC}"
echo -e "${CYAN}=====================================================${NC}"

# --- Display server -----------------------------------------------------------
SESSION="${XDG_SESSION_TYPE:-unknown}"
DESKTOP="${XDG_CURRENT_DESKTOP:-${DESKTOP_SESSION:-unknown}}"
echo -e "\n${CYAN}Session${NC}"
echo -e "  type:    ${SESSION}"
echo -e "  desktop: ${DESKTOP}"

IS_WAYLAND=0
if [ "$SESSION" = "wayland" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  IS_WAYLAND=1
fi

# --- Package manager ----------------------------------------------------------
if command -v apt-get >/dev/null 2>&1;  then PM="apt";    INSTALL="sudo apt-get install -y"
elif command -v dnf   >/dev/null 2>&1;  then PM="dnf";    INSTALL="sudo dnf install -y"
elif command -v pacman >/dev/null 2>&1; then PM="pacman"; INSTALL="sudo pacman -S --needed"
elif command -v zypper >/dev/null 2>&1; then PM="zypper"; INSTALL="sudo zypper install -y"
else PM="unknown"; INSTALL="(install with your package manager)"
fi

# Maps a role to this distro's package name.
pkg() {
  case "$1:$PM" in
    portal:apt)          echo "xdg-desktop-portal" ;;
    portal:dnf)          echo "xdg-desktop-portal" ;;
    portal:pacman)       echo "xdg-desktop-portal" ;;
    portal:zypper)       echo "xdg-desktop-portal" ;;
    portal-gnome:apt)    echo "xdg-desktop-portal-gnome" ;;
    portal-gnome:*)      echo "xdg-desktop-portal-gnome" ;;
    portal-kde:apt)      echo "xdg-desktop-portal-kde" ;;
    portal-kde:*)        echo "xdg-desktop-portal-kde" ;;
    portal-wlr:apt)      echo "xdg-desktop-portal-wlr" ;;
    portal-wlr:*)        echo "xdg-desktop-portal-wlr" ;;
    pipewire:*)          echo "pipewire" ;;
    webkit:apt)          echo "libwebkit2gtk-4.1-0" ;;
    webkit:dnf)          echo "webkit2gtk4.1" ;;
    webkit:pacman)       echo "webkit2gtk-4.1" ;;
    webkit:zypper)       echo "webkit2gtk3-soup2" ;;
    *)                   echo "$1" ;;
  esac
}

MISSING=()

# --- Screen capture -----------------------------------------------------------
echo -e "\n${CYAN}Screen capture${NC}"
if ls /usr/share/dbus-1/services/org.freedesktop.portal.Desktop.service \
      /usr/local/share/dbus-1/services/org.freedesktop.portal.Desktop.service \
      >/dev/null 2>&1 || [ -x /usr/libexec/xdg-desktop-portal ]; then
  ok "xdg-desktop-portal is installed"
else
  bad "xdg-desktop-portal is missing — sharing a screen will fail"
  MISSING+=("$(pkg portal)")
fi

# The generic portal needs a desktop-specific backend to actually show a picker.
BACKEND_FOUND=0
for b in gnome kde wlr gtk lxqt hyprland; do
  if ls /usr/share/xdg-desktop-portal/portals/*"$b"*.portal >/dev/null 2>&1; then
    ok "portal backend present: $b"
    BACKEND_FOUND=1
  fi
done
if [ "$BACKEND_FOUND" -eq 0 ]; then
  bad "no portal backend found — the screen picker will not appear"
  case "${DESKTOP,,}" in
    *gnome*)          MISSING+=("$(pkg portal-gnome)") ;;
    *kde*|*plasma*)   MISSING+=("$(pkg portal-kde)") ;;
    *sway*|*hypr*|*wlroots*) MISSING+=("$(pkg portal-wlr)") ;;
    *) warn "pick the backend for your desktop: -gnome, -kde or -wlr" ;;
  esac
fi

if command -v pipewire >/dev/null 2>&1 || pgrep -x pipewire >/dev/null 2>&1; then
  ok "PipeWire is available"
else
  bad "PipeWire not found — portal screen capture depends on it"
  MISSING+=("$(pkg pipewire)")
fi

# --- Input injection ----------------------------------------------------------
echo -e "\n${CYAN}Input injection${NC}"
if [ "$IS_WAYLAND" -eq 1 ]; then
  echo -e "  Wayland session: no XTest, so RemoteDesk uses a Wayland path."
  case "${DESKTOP,,}" in
    *gnome*|*kde*|*plasma*)
      ok "GNOME/KDE detected — the RemoteDesktop portal will be used"
      warn "your desktop will ask you to approve remote control on first use"
      ;;
    *sway*|*hypr*|*wlroots*|*river*)
      ok "wlroots compositor detected — virtual-input protocols will be used"
      ;;
    *)
      warn "unrecognised compositor: RemoteDesk will try the RemoteDesktop portal,"
      warn "then the wlroots virtual-input protocols. One of them usually works."
      ;;
  esac
else
  ok "X11 session — XTest injection works with no extra permission"
fi

# --- Webview ------------------------------------------------------------------
echo -e "\n${CYAN}Webview${NC}"
if ldconfig -p 2>/dev/null | grep -q "libwebkit2gtk-4.1"; then
  ok "webkit2gtk 4.1 is installed"
else
  bad "webkit2gtk 4.1 is missing — the app window will not open"
  MISSING+=("$(pkg webkit)")
fi

# --- Summary ------------------------------------------------------------------
echo -e "\n${CYAN}=====================================================${NC}"
if [ ${#MISSING[@]} -eq 0 ]; then
  echo -e "${GREEN}  This machine is ready to host and to connect.       ${NC}"
  echo -e "${CYAN}=====================================================${NC}"
  exit 0
fi

echo -e "${YELLOW}  Missing pieces — install them with:                 ${NC}"
echo -e "${CYAN}=====================================================${NC}"
echo -e "\n  ${INSTALL} ${MISSING[*]}\n"
echo -e "Then log out and back in so the portal picks up the change."
exit 1
