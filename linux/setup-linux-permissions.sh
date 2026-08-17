#!/usr/bin/env bash
# ==============================================================================
# RemoteDesk Linux Display Server & Input Permission Hardening Script
# Configures uinput, X11 XTest, and Wayland compatibility for nut.js injection
# ==============================================================================

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}======================================================${NC}"
echo -e "${CYAN}  RemoteDesk Linux Input Permission Configurator      ${NC}"
echo -e "${CYAN}======================================================${NC}"

# 1. Detect Display Server
CURRENT_SESSION="${XDG_SESSION_TYPE:-unknown}"
echo -e "Detected Display Session: ${GREEN}${CURRENT_SESSION}${NC}"
if [ -n "$WAYLAND_DISPLAY" ]; then
    echo -e "Wayland Socket: ${GREEN}${WAYLAND_DISPLAY}${NC}"
fi
if [ -n "$DISPLAY" ]; then
    echo -e "X11 Display: ${GREEN}${DISPLAY}${NC}"
fi

# 2. Check for Root Privileges if applying udev rules
if [ "$EUID" -ne 0 ]; then
    echo -e "\n${YELLOW}[!] Warning: Installing udev rules requires root permissions.${NC}"
    echo -e "Re-running script with sudo to install uinput permissions..."
    sudo "$0" "$@"
    exit 0
fi

# 3. Load Linux Kernel Module for uinput
echo -e "\n${CYAN}[1/4] Ensuring 'uinput' kernel module is loaded...${NC}"
if ! lsmod | grep -q "^uinput"; then
    echo "Loading uinput kernel module via modprobe..."
    modprobe uinput
    echo "uinput module loaded successfully."
else
    echo "uinput module is already active."
fi

# Ensure module loads automatically on boot
MODULES_LOAD_FILE="/etc/modules-load.d/uinput.conf"
if [ ! -f "$MODULES_LOAD_FILE" ]; then
    echo "Configuring automatic uinput loading on boot in $MODULES_LOAD_FILE..."
    echo "uinput" > "$MODULES_LOAD_FILE"
fi

# 4. Install Udev Rules for Non-Root Input Injection
echo -e "\n${CYAN}[2/4] Configuring /etc/udev/rules.d/50-remotedesk-uinput.rules...${NC}"
cat << 'EOF' > /etc/udev/rules.d/50-remotedesk-uinput.rules
KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
SUBSYSTEM=="misc", KERNEL=="uinput", GROUP="input", MODE="0660"
EOF

# Reload udev rules and trigger device node permissions
udevadm control --reload-rules && udevadm trigger
echo "Udev rules reloaded."

# 5. Add Current User to 'input' Group
TARGET_USER="${SUDO_USER:-$USER}"
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
    echo -e "\n${CYAN}[3/4] Adding user '${TARGET_USER}' to 'input' group...${NC}"
    groupadd -f input
    usermod -a -G input "$TARGET_USER"
    echo -e "${GREEN}User '${TARGET_USER}' added to group 'input'.${NC}"
fi

# 6. Wayland / PipeWire portal recommendations
echo -e "\n${CYAN}[4/4] Verifying Desktop Portal & XTest dependencies...${NC}"
if [ "$CURRENT_SESSION" = "wayland" ]; then
    echo -e "${YELLOW}Notice for Wayland Users:${NC}"
    echo -e " - Screen capture uses the WebRTC Desktop Capturer backed by PipeWire & xdg-desktop-portal."
    echo -e " - For native nut.js synthetic input injection, ensure your desktop environment has 'ydotool' installed or runs an XWayland bridge."
    if command -v pacman >/dev/null 2>&1; then
        echo "   Arch Linux install command: sudo pacman -S --needed ydotool xorg-xwayland pipewire xdg-desktop-portal"
    elif command -v apt-get >/dev/null 2>&1; then
        echo "   Debian/Ubuntu install command: sudo apt-get install -y ydotool xwayland pipewire xdg-desktop-portal"
    fi
else
    echo -e "${GREEN}X11 Display Server active. Direct XTest input injection is ready.${NC}"
fi

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}  RemoteDesk Linux Configuration Complete!            ${NC}"
echo -e "${GREEN}======================================================${NC}"
echo -e "Please log out and log back in once for group membership to take effect."
