#!/bin/sh

if [ -z "${AGENTNEST_SSH_PASSWORD:-}" ]; then
  exit 1
fi

printf '%s\n' "$AGENTNEST_SSH_PASSWORD"
