#!/bin/sh
# mongotui installer — curl -fsSL https://raw.githubusercontent.com/<owner>/mongotui/main/install.sh | sh
#
# Detects your OS + CPU, downloads the matching prebuilt binary from the GitHub
# release, decompresses it, and installs it to a bin dir on your PATH.
# Works on Linux (x64/arm64) and macOS (Intel/Apple Silicon).
#
# Override targets with env vars:
#   MONGOTUI_REPO     owner/repo         (default below)
#   MONGOTUI_VERSION  vX.Y.Z or "latest" (default latest)
#   MONGOTUI_BIN_DIR  install directory  (default: /usr/local/bin if writable, else ~/.local/bin)
set -eu

# --- the one line to change once your GitHub repo exists -------------------
REPO="${MONGOTUI_REPO:-hadijaveed/mongotui}"
# ---------------------------------------------------------------------------
VERSION="${MONGOTUI_VERSION:-latest}"
BIN_NAME="mongotui"

err()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$1"; }

# --- detect platform -------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS '$os' (this build targets Linux and macOS)" ;;
esac

case "$arch" in
  x86_64|amd64)  arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) err "unsupported CPU '$arch' (expected x86_64 or arm64)" ;;
esac

# Prefer the smaller .xz asset when we can decompress it; otherwise .gz
# (gunzip is on every macOS/Linux). Both are published per release.
if command -v xz >/dev/null 2>&1 || command -v unxz >/dev/null 2>&1; then
  ext=xz
  decompress() { xz -d -c "$1"; }
else
  ext=gz
  decompress() { gzip -d -c "$1"; }
fi
asset="${BIN_NAME}-${os}-${arch}.${ext}"

# --- resolve download URL --------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

# --- pick a fetch tool -----------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fSL --progress-bar "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --show-progress -O "$2" "$1"; }
else
  err "need curl or wget to download"
fi

# --- choose install dir ----------------------------------------------------
if [ -n "${MONGOTUI_BIN_DIR:-}" ]; then
  bindir="$MONGOTUI_BIN_DIR"
elif [ -w /usr/local/bin ] 2>/dev/null; then
  bindir="/usr/local/bin"
else
  bindir="$HOME/.local/bin"
fi
mkdir -p "$bindir" || err "cannot create install dir $bindir"

# --- download + decompress + install --------------------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

info "downloading ${BIN_NAME} (${os}-${arch}, ${VERSION}) from ${REPO}"
fetch "$url" "$tmp/${asset}" || err "download failed: $url
(check that release ${VERSION} exists and has asset ${asset}; or set MONGOTUI_REPO)"

info "unpacking"
decompress "$tmp/${asset}" > "$tmp/${BIN_NAME}" || err "decompress (${ext}) failed"
chmod +x "$tmp/${BIN_NAME}"

dest="$bindir/${BIN_NAME}"
mv "$tmp/${BIN_NAME}" "$dest" 2>/dev/null || err "cannot write $dest (try: MONGOTUI_BIN_DIR=\$HOME/.local/bin)"

info "installed to $dest"

# --- PATH hint -------------------------------------------------------------
case ":$PATH:" in
  *":$bindir:"*) : ;;
  *) printf '\033[33mnote:\033[0m %s is not on your PATH — add:\n  export PATH="%s:$PATH"\n' "$bindir" "$bindir" ;;
esac

printf '\033[32mdone.\033[0m run: %s localhost:27017\n' "$BIN_NAME"
