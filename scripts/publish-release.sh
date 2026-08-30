#!/usr/bin/env bash
# =============================================================================
# Ships a RemoteDesk release that existing installs can actually update to.
#
# Two things have to be true for an update to reach anyone, and both are easy to
# get wrong silently:
#
#   1. The signing secrets exist in the repository, or CI builds installers with
#      no signatures and no `latest.json` — the release looks fine and no
#      installed copy ever sees it.
#   2. The drafted release is published, because the updater polls
#      `releases/latest`, which ignores drafts.
#
# This script does both, plus the pushing and tagging in between. It is safe to
# re-run: every step checks whether it has already been done.
#
# Usage:
#   bash scripts/publish-release.sh            # version from tauri.conf.json
#   bash scripts/publish-release.sh 1.2.0      # or an explicit one
#
# Each destructive step asks first. That is deliberate: this pushes your source
# to GitHub and offers a build to every installed copy, and neither is easy to
# take back.
# =============================================================================

set -euo pipefail

REPO="Smileys-Helping-hand/myremotedesktop"
KEY_FILE="${TAURI_KEY_FILE:-$HOME/.remotedesk-keys/remotedesk-updater.key}"
BRANCH="${RELEASE_BRANCH:-main}"

cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
step() { echo -e "\n${BOLD}==> $1${NC}"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
die()  { echo -e "  ${RED}✗${NC} $1" >&2; exit 1; }

confirm() {
  read -rp "  $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# --- 0. Preconditions --------------------------------------------------------

step "Checking prerequisites"

command -v gh >/dev/null || die "the GitHub CLI (gh) is not installed: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "not logged in. Run: gh auth login"
ok "gh is authenticated as $(gh api user --jq .login)"

gh repo view "$REPO" >/dev/null 2>&1 || die "cannot see $REPO. Check the name, and that your account has access."
ok "$REPO is reachable"

[ -f "$KEY_FILE" ] || die "no signing key at $KEY_FILE
     Generate one with:
       npm run tauri signer generate -- -w \"$KEY_FILE\"
     and put its .pub contents in plugins.updater.pubkey in src-tauri/tauri.conf.json."
ok "signing key found"

VERSION="${1:-$(node -p "require('./src-tauri/tauri.conf.json').version")}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version '$VERSION' is not major.minor.patch"

CONF_VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$CONF_VERSION" != "$VERSION" ] || [ "$PKG_VERSION" != "$VERSION" ]; then
  die "version mismatch — asked for $VERSION but tauri.conf.json is $CONF_VERSION and package.json is $PKG_VERSION.
     An installed copy compares itself against tauri.conf.json, so these must agree before tagging."
fi
ok "releasing v$VERSION"

# --- 1. Signing secrets ------------------------------------------------------
# This is the step whose absence is invisible: without it CI still produces
# installers, just ones no existing install will ever be offered.

step "Setting the signing secrets on $REPO"

# Piped from the file rather than passed as an argument, so the key never
# appears in the process list or the shell history.
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$REPO" < "$KEY_FILE"
ok "TAURI_SIGNING_PRIVATE_KEY set"

# The generated key has an empty password; the variable must still exist,
# because the CLI prompts interactively when it is unset and CI would hang.
printf '%s' "${TAURI_SIGNING_KEY_PASSWORD:-}" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$REPO"
ok "TAURI_SIGNING_PRIVATE_KEY_PASSWORD set"

# --- 2. Remote ---------------------------------------------------------------

step "Checking the git remote"

if ! git remote get-url origin >/dev/null 2>&1; then
  warn "no 'origin' remote configured"
  confirm "Add origin -> https://github.com/$REPO.git ?" || die "aborted"
  git remote add origin "https://github.com/$REPO.git"
fi
ok "origin -> $(git remote get-url origin)"

# --- 3. Commit ---------------------------------------------------------------

step "Committing work in progress"

if [ -n "$(git status --porcelain)" ]; then
  git status --short | head -20
  total=$(git status --porcelain | wc -l)
  echo "  ($total changed path(s))"
  confirm "Commit all of the above?" || die "aborted — commit manually, then re-run"
  git add -A
  git commit -q -m "Release v$VERSION

Signed in-app updates, installer downloads served by both signaling servers,
and the outside-network fixes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ok "committed"
else
  ok "working tree is clean"
fi

# --- 4. Push -----------------------------------------------------------------

step "Pushing $BRANCH"

current=$(git rev-parse --abbrev-ref HEAD)
if [ "$current" != "$BRANCH" ]; then
  warn "on branch '$current', not '$BRANCH'"
  confirm "Rename '$current' to '$BRANCH' and push that?" || die "aborted"
  git branch -M "$BRANCH"
fi

echo "  This publishes the full source to $REPO."
confirm "Push now?" || die "aborted"
git push -u origin "$BRANCH"
ok "pushed"

# --- 5. Tag ------------------------------------------------------------------

step "Tagging v$VERSION"

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  ok "tag v$VERSION already exists locally"
else
  git tag -a "v$VERSION" -m "RemoteDesk v$VERSION"
  ok "tag created"
fi

git push origin "v$VERSION"
ok "tag pushed — CI will now build and draft the release"

# --- 6. Wait for the build ---------------------------------------------------

step "Waiting for the build"

echo "  Installers for two platforms take a while; this follows the run."
sleep 10  # give GitHub a moment to register the workflow run for the tag
if ! gh run watch --repo "$REPO" --exit-status \
     "$(gh run list --repo "$REPO" --limit 1 --json databaseId --jq '.[0].databaseId')"; then
  die "the build failed — see: gh run list --repo $REPO"
fi
ok "build finished"

# --- 7. Publish --------------------------------------------------------------
# Until this happens the release is a draft, and `releases/latest` — which every
# installed copy polls — does not return drafts.

step "Publishing the release"

if ! gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  die "no release v$VERSION was created. Check the workflow output."
fi

echo "  Assets attached to the draft:"
gh release view "v$VERSION" --repo "$REPO" --json assets \
  --jq '.assets[] | "    \(.name)  (\(.size) bytes)"'

# Without these, installed copies cannot verify or even find the update.
assets=$(gh release view "v$VERSION" --repo "$REPO" --json assets --jq '.assets[].name')
if ! grep -q 'latest.json' <<< "$assets"; then
  die "the release has no latest.json — the signing secrets were probably not set when it built.
     Re-run this script to set them, then re-tag."
fi
if ! grep -q '\.sig$' <<< "$assets"; then
  die "the release has no .sig files — the build was not signed, so no install will accept it."
fi
ok "latest.json and signatures are present"

confirm "Publish v$VERSION? Existing installs will be offered it." || {
  warn "left as a draft. Publish later with:"
  echo "    gh release edit v$VERSION --repo $REPO --draft=false"
  exit 0
}

gh release edit "v$VERSION" --repo "$REPO" --draft=false --latest
ok "published"

echo -e "\n${GREEN}${BOLD}v$VERSION is live.${NC}"
echo "  Windows and AppImage installs will be offered it on next launch."
echo "  Verify the manifest is reachable:"
echo "    curl -sL https://github.com/$REPO/releases/latest/download/latest.json | head"
