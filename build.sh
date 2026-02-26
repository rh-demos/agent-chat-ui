#!/usr/bin/env bash

podman build --arch amd64 --os linux -t quay.io/jonkey/agent-chat-ui:1.0.2 -f Dockerfile .
podman push quay.io/jonkey/agent-chat-ui:1.0.2
