#!/bin/bash
# Install AiBrowser 148 as the default independent kernel for macOS x86.
# Default source: in-repo kernels/macos-x64 (AiBrowser 148).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_KERNEL="${SCRIPT_DIR}/../kernels/macos-x64"
if [[ ! -x "$REPO_KERNEL/chrome_148/aibrowser_148/AiBrowser.app/Contents/MacOS/AiBrowser" ]]; then
  REPO_KERNEL="${SCRIPT_DIR}/../kernels/aibrowser"
fi
SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  if [[ -x "$REPO_KERNEL/chrome_148/aibrowser_148/AiBrowser.app/Contents/MacOS/AiBrowser" ]]; then
    SRC="$REPO_KERNEL"
  else
    SRC="$HOME/Desktop/AiBrowser-kernel-macx86"
  fi
fi
UD="${OPENBROWSER_USER_DATA:-$HOME/Library/Application Support/aibrowser}"
DEST="$UD/kernels/macos-x64"
BIN_REL="chrome_148/aibrowser_148/AiBrowser.app/Contents/MacOS/AiBrowser"

if [[ ! -d "$SRC" ]]; then
  echo "source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"

# Layout A: full aibrowser tree (repo / installed style)
if [[ -x "$SRC/chrome_148/aibrowser_148/AiBrowser.app/Contents/MacOS/AiBrowser" ]]; then
  rsync -a \
    --exclude '.DS_Store' \
    --exclude '*.bak' \
    --exclude 'README.txt' \
    --exclude 'STANDALONE_FOR_OTHERS.txt' \
    --exclude 'patch_no_encrypt.py' \
    --exclude 'analysis' \
    "$SRC/" "$DEST/"
# Layout B: only chrome_148 subtree passed as SRC
elif [[ -x "$SRC/aibrowser_148/AiBrowser.app/Contents/MacOS/AiBrowser" ]]; then
  rsync -a \
    --exclude '.DS_Store' \
    --exclude '*.bak' \
    --exclude 'README.txt' \
    --exclude 'STANDALONE_FOR_OTHERS.txt' \
    --exclude 'patch_no_encrypt.py' \
    --exclude 'analysis' \
    "$SRC/" "$DEST/chrome_148/"
elif [[ -d "$SRC/chrome_64_148" ]]; then
  EXIST="$UD/kernels/macos-x64/chrome_148/aibrowser_148"
  if [[ -x "$EXIST/AiBrowser.app/Contents/MacOS/AiBrowser" ]]; then
    echo "Keeping existing wrapped AiBrowser.app at $EXIST"
  else
    echo "ERROR: raw chrome_64_148 needs wrapped aibrowser layout."
    echo "Use: $REPO_KERNEL  or pass kernels/macos-x64 path."
    exit 1
  fi
else
  echo "unrecognized kernel package layout under $SRC" >&2
  exit 1
fi

# templates / skit
if [[ -f "$SRC/init_template.json" ]]; then
  cp -f "$SRC/init_template.json" "$DEST/init_template.json"
elif [[ -f "$SRC/init_clean_standalone.json" ]]; then
  cp -f "$SRC/init_clean_standalone.json" "$DEST/init_template.json"
elif [[ -f "$SRC/chrome_148/init_clean_standalone.json" ]]; then
  cp -f "$SRC/chrome_148/init_clean_standalone.json" "$DEST/init_template.json"
fi
if [[ -f "$SRC/libskit.dylib" ]]; then
  cp -f "$SRC/libskit.dylib" "$DEST/libskit.dylib"
elif [[ -f "$SRC/chrome_148/libskit.dylib" ]]; then
  cp -f "$SRC/chrome_148/libskit.dylib" "$DEST/libskit.dylib"
fi
# Standalone IPC stub (prevents platform start failed / exit 18 without companion IPC endpoints)
if [[ -f "$SRC/ipc-stub.py" ]]; then
  cp -f "$SRC/ipc-stub.py" "$DEST/ipc-stub.py"
  chmod +x "$DEST/ipc-stub.py" 2>/dev/null || true
elif [[ -f "${REPO_KERNEL:-}/ipc-stub.py" ]]; then
  cp -f "$REPO_KERNEL/ipc-stub.py" "$DEST/ipc-stub.py"
  chmod +x "$DEST/ipc-stub.py" 2>/dev/null || true
fi
MACOS="$DEST/chrome_148/aibrowser_148/AiBrowser.app/Contents/MacOS"
if [[ -f "$DEST/libskit.dylib" && -d "$MACOS" ]]; then
  cp -f "$DEST/libskit.dylib" "$MACOS/libskit.dylib"
fi

BIN="$DEST/$BIN_REL"
test -f "$BIN"
chmod +x "$BIN" 2>/dev/null || true
chmod +x "$MACOS/AiBrowser" 2>/dev/null || true
chmod +x "$MACOS/AiBrowser.bin" 2>/dev/null || true

python3 - "$BIN" "$UD" <<'PY'
import json, sys
from pathlib import Path
from datetime import datetime, timezone
bin_path = Path(sys.argv[1]).resolve()
ud = Path(sys.argv[2])
meta = ud / "kernels" / "kernel-meta.json"
meta.parent.mkdir(parents=True, exist_ok=True)
meta.write_text(json.dumps({
  "version": "148.0.7778.165",
  "platform": "macos-x64",
  "binary": str(bin_path),
  "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
  "source": "aibrowser-148",
  "remoteVersion": "148.0.7778.165",
  "downloadUrl": None,
  "note": "AiBrowser macOS x86 default kernel",
}, indent=2, ensure_ascii=False) + "\n")
custom = ud / "kernels" / "custom"
custom.mkdir(parents=True, exist_ok=True)
chrome = custom / "chrome"
chrome.write_text(f'#!/bin/bash\nexec "{bin_path}" "$@"\n')
chrome.chmod(0o755)
print("OK binary=", bin_path)
print("OK meta=", meta)
PY

echo "Done. Restart AiBrowser — default kernel is AiBrowser 148 (aibrowser-148)."
echo "Installed from: $SRC"
