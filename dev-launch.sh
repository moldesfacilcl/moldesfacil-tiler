#!/bin/bash
# Lanzar Electron como app macOS nativa (necesario en macOS 14+)
# Los logs van a /tmp/moldesfacil-dev.log
PROJECT="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$PROJECT/node_modules/electron/dist/Electron.app"

export NODE_ENV=development

open -n "$ELECTRON" --args "$PROJECT" > /tmp/moldesfacil-dev.log 2>&1 &
echo "App lanzada. Logs en: /tmp/moldesfacil-dev.log"
echo "Para ver logs en tiempo real: tail -f /tmp/moldesfacil-dev.log"
