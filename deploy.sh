#!/bin/bash
set -e

echo "🚀 Deploying CIIIC Relaybot..."

# Clone or update repo
if [ -d "/opt/relaybot" ]; then
  echo "📥 Updating existing installation..."
  cd /opt/relaybot
  git pull
else
  echo "📥 Cloning repository..."
  git clone https://github.com/CIIICnl/ciiic-automator.git /opt/relaybot
  cd /opt/relaybot
fi

# Create .env if it doesn't exist
if [ ! -f ".env" ]; then
  echo "📝 No .env file found. Please create one:"
  echo "   cp .env.example .env"
  echo "   nano .env"
  echo "   # Add your API keys, then run: docker compose up -d --build"
  exit 1
fi

# Build and start container
echo "🔨 Building and starting container..."
docker compose up -d --build

# Add to Caddyfile if not already there
if ! grep -q "bot.ciiic.nl" /opt/slidecreator/Caddyfile; then
  echo "🌐 Adding bot.ciiic.nl to Caddyfile..."
  echo -e '\nbot.ciiic.nl {\n  encode gzip\n  reverse_proxy ciiic-automator:3000\n}' >> /opt/slidecreator/Caddyfile
  docker restart slidecreator-caddy
fi

echo ""
echo "✅ Done! Testing health endpoint..."
sleep 2
curl -s http://localhost:3000/health | head -c 200
echo ""
echo ""
echo "🎉 Relaybot deployed at https://bot.ciiic.nl"
