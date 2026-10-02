#!/usr/bin/env bash
# Builds the signed release APK and copies it to Downloads/NFLPicks.apk.
set -e
cd "$(dirname "$0")"
export JAVA_HOME="$LOCALAPPDATA/tvremote/jdk-17.0.20.1+1"
# Windows sometimes holds a lock on the dex output; a stale daemon is the usual cause.
./gradlew --stop -q >/dev/null 2>&1 || true
for attempt in 1 2 3; do
  ./gradlew assembleRelease --console=plain -q "$@" && break
  [ $attempt = 3 ] && exit 1
  echo "Build locked, retrying ($attempt)..."; sleep 5
done
cp "$LOCALAPPDATA/nflpicks-build/app/outputs/apk/release/app-release.apk" "$USERPROFILE/Downloads/NFLPicks.apk"
echo "Built: $USERPROFILE/Downloads/NFLPicks.apk"
