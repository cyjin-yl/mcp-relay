#!/bin/sh
set -eu
# Run only in a bounded .NET 10 SDK build container. No user-machine installation.
ANODE_COMMIT=cbed84ff7465c0bd0310a3eec20c68046322fb53
ANODE_RUNTIME=10.0.14
ANODE_BUILD_ROOT=${1:-/workspace/.tmp/windows-workspace-runtime}
ANODE_RELAY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$ANODE_BUILD_ROOT"
ANODE_SOURCE="$ANODE_BUILD_ROOT/source-$ANODE_COMMIT"
if [ ! -d "$ANODE_SOURCE/.git" ]; then
  git init "$ANODE_SOURCE"
  git -C "$ANODE_SOURCE" remote add origin https://github.com/skulitom/Anode.git
  git -C "$ANODE_SOURCE" fetch --depth 1 origin "$ANODE_COMMIT"
  git -C "$ANODE_SOURCE" checkout --detach FETCH_HEAD
fi
[ "$(git -C "$ANODE_SOURCE" rev-parse HEAD)" = "$ANODE_COMMIT" ]
[ -z "$(git -C "$ANODE_SOURCE" status --porcelain)" ]
ANODE_PUBLISH="$ANODE_BUILD_ROOT/publish"
if [ -e "$ANODE_PUBLISH/anode.exe" ]; then
  echo 'Refusing to overwrite an existing frozen runtime.' >&2
  exit 1
fi
DOTNET_CLI_TELEMETRY_OPTOUT=1 dotnet publish "$ANODE_SOURCE/src/Anode/Anode.csproj" \
  -c Release -r win-x64 --self-contained true -p:EnableWindowsTargeting=true \
  -p:RuntimeFrameworkVersion="$ANODE_RUNTIME" -p:ContinuousIntegrationBuild=true \
  -p:RestorePackagesWithLockFile=true -o "$ANODE_PUBLISH"
cp "$ANODE_SOURCE/LICENSE" "$ANODE_PUBLISH/LICENSE.Anodelibrary.txt"
cp "$ANODE_RELAY_ROOT/packages/device/NOTICE.windows-workspace.txt" "$ANODE_PUBLISH/THIRD-PARTY-NOTICES.txt"
ANODE_EXE_SHA=$(sha256sum "$ANODE_PUBLISH/anode.exe" | cut -d' ' -f1)
ANODE_EXE_BYTES=$(wc -c < "$ANODE_PUBLISH/anode.exe" | tr -d ' ')
ANODE_LICENSE_SHA=$(sha256sum "$ANODE_PUBLISH/LICENSE.Anodelibrary.txt" | cut -d' ' -f1)
ANODE_NOTICES_SHA=$(sha256sum "$ANODE_PUBLISH/THIRD-PARTY-NOTICES.txt" | cut -d' ' -f1)
ANODE_NOTICES_BYTES=$(wc -c < "$ANODE_PUBLISH/THIRD-PARTY-NOTICES.txt" | tr -d ' ')
printf '{"schema":1,"provider":"windows-anode-child-session","version":"0.11.5","sourceCommit":"%s","sourceRepository":"https://github.com/skulitom/Anode","dotnetRuntime":"%s","executable":"anode.exe","sha256":"%s","bytes":%s,"licenseSha256":"%s","noticesFile":"THIRD-PARTY-NOTICES.txt","noticesSha256":"%s","noticesBytes":%s}\n' "$ANODE_COMMIT" "$ANODE_RUNTIME" "$ANODE_EXE_SHA" "$ANODE_EXE_BYTES" "$ANODE_LICENSE_SHA" "$ANODE_NOTICES_SHA" "$ANODE_NOTICES_BYTES" > "$ANODE_PUBLISH/runtime.json"
cat "$ANODE_PUBLISH/runtime.json"
