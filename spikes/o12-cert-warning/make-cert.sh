#!/bin/bash
# Makes a self-signed certificate for this machine's home-network address, valid 30 days.
set -e
cd "$(dirname "$0")"
IP=${1:-$(ipconfig getifaddr en0)}
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout key.pem -out cert.pem -days 30 \
  -subj "/CN=home-security-next test hub" -addext "subjectAltName=IP:$IP,DNS:localhost,IP:127.0.0.1" 2>/dev/null
echo "certificate made for $IP"
