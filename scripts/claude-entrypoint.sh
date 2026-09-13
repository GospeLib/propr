#!/bin/bash
# Entrypoint script for Claude Code execution container
# Handles initialization and executes Claude Code CLI with proper security

set -e

PROPR_EZER_MARKER_DIR='/run/propr'
PROPR_EZER_MARKER_PATH="$PROPR_EZER_MARKER_DIR/ezer-admission.json"

# The app supplies this payload only after consuming a signed, single-use admission receipt. Create
# the capability marker while still root, make both it and its directory non-writable, then remove
# the transport environment variable before the unprivileged model starts. The model can forge an
# environment variable; it cannot replace this root-owned file under Docker's no-new-privileges
# boundary.
if [ -n "${PROPR_EZER_ADMISSION_MARKER_B64:-}" ]; then
    if [ "$(id -u)" != '0' ]; then
        echo 'Refusing Ezer admission marker creation outside the root entrypoint' >&2
        exit 1
    fi
    mkdir -p "$PROPR_EZER_MARKER_DIR"
    chmod 0700 "$PROPR_EZER_MARKER_DIR"
    printf '%s' "$PROPR_EZER_ADMISSION_MARKER_B64" | base64 -d > "$PROPR_EZER_MARKER_PATH"
    chown root:root "$PROPR_EZER_MARKER_DIR" "$PROPR_EZER_MARKER_PATH"
    chmod 0444 "$PROPR_EZER_MARKER_PATH"
    chmod 0555 "$PROPR_EZER_MARKER_DIR"
    unset PROPR_EZER_ADMISSION_MARKER_B64
fi

# Skip firewall initialization for now (requires privileged container)
echo "Skipping firewall setup (would require --privileged Docker flag)"

# Ensure GitHub token is available
if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set"
    echo "GitHub operations may fail"
else
    echo "GitHub token detected (using environment variable)"
    echo "GitHub CLI will use GH_TOKEN environment variable for authentication"
fi

# Use the mounted config's unprivileged owner instead of recursively rewriting a
# host directory. Large session histories and symlinks must never delay startup
# or have their ownership changed by an analysis request.
PROPR_CLAUDE_CONFIG_DIR='/home/node/.claude'
PROPR_CLAUDE_RUN_USER='node'
if [ -d "$PROPR_CLAUDE_CONFIG_DIR" ]; then
    echo "Claude config directory mounted"
    if [ "$(id -u)" = "0" ]; then
        config_uid=$(stat -c %u "$PROPR_CLAUDE_CONFIG_DIR")
        config_gid=$(stat -c %g "$PROPR_CLAUDE_CONFIG_DIR")
        if [ "$config_uid" != "0" ]; then
            PROPR_CLAUDE_RUN_USER="$config_uid:$config_gid"
        else
            # Docker may create an empty named volume as root. Repair only its
            # root and known credential file, never existing history recursively.
            chown node:node "$PROPR_CLAUDE_CONFIG_DIR"
            credentials_path="$PROPR_CLAUDE_CONFIG_DIR/.credentials.json"
            if [ -f "$credentials_path" ] && [ "$(stat -c %u "$credentials_path")" = "0" ]; then
                chown node:node "$credentials_path"
            fi
        fi
        # This is the container home itself, not the mounted config tree.
        chown "$PROPR_CLAUDE_RUN_USER" /home/node
        su-exec "$PROPR_CLAUDE_RUN_USER" mkdir -p \
            "$PROPR_CLAUDE_CONFIG_DIR/todos" \
            "$PROPR_CLAUDE_CONFIG_DIR/projects" \
            "$PROPR_CLAUDE_CONFIG_DIR/shell-snapshots" \
            "$PROPR_CLAUDE_CONFIG_DIR/statsig"
    fi
else
    echo "WARNING: Claude config directory not mounted at $PROPR_CLAUDE_CONFIG_DIR"
fi

# Ensure Claude config is accessible
if [ ! -f "/home/node/.claude/.credentials.json" ]; then
    echo "Warning: Claude credentials not found"
    echo "Ensure Claude config directory is properly mounted"
    echo "Expected path: /home/node/.claude/.credentials.json"
else
    echo "Claude authentication configuration found"
fi

# Configure Git to trust all directories (security: container environment)
git config --global --add safe.directory '*' 2>/dev/null || echo "Git safe directory config already set"

# Set up gh wrapper to filter propr bot comments
# This ensures Claude doesn't see operational bot comments when analyzing issues
if [ -x "/usr/local/bin/gh-wrapper" ]; then
    echo "Setting up GitHub CLI wrapper to filter operational comments"
    # Create a directory for our wrapper in PATH
    mkdir -p /home/node/bin
    ln -sf /usr/local/bin/gh-wrapper /home/node/bin/gh
    export PATH="/home/node/bin:$PATH"
fi

# Set proper permissions for workspace
if [ -d "/home/node/workspace" ]; then
    # Check if we're running as the correct user (should be UID 1000)
    current_uid=$(id -u)
    if [ "$current_uid" = "1000" ]; then
        echo "Running as correct user (UID 1000)"
        # Check if files are already owned by us
        if [ -O "/home/node/workspace" ]; then
            echo "Workspace ownership is correct"
        else
            echo "Warning: Workspace files not owned by container user"
            echo "This may cause permission issues during execution"
        fi
    else
        echo "Warning: Running as UID $current_uid instead of expected 1000"
        echo "Skipping workspace chown to avoid mutating host bind-mount ownership"
    fi
fi

# If arguments are provided, execute them
if [ $# -gt 0 ]; then
    echo "Executing command: $@"
    # If running as root, switch to node user after setup
    if [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..."
        cd /home/node/workspace
        exec su-exec "$PROPR_CLAUDE_RUN_USER" env HOME="${PROPR_CLAUDE_HOME:-/home/node}" USER=node LOGNAME=node "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell"
    exec /bin/bash
fi
