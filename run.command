#!/bin/bash
# Double-clickable macOS launcher for Markdown Studio

cd "$(dirname "$0")"

# Prefer current active python3 or system python3
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
elif [ -f "/opt/anaconda3/bin/python3" ]; then
    PYTHON_CMD="/opt/anaconda3/bin/python3"
else
    PYTHON_CMD="python"
fi

echo "🚀 Starting Markdown Studio via $PYTHON_CMD..."
exec "$PYTHON_CMD" main.py "$@"
