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
  git clone https://github.com/CIIICnl/relaybot.git /opt/relaybot
  cd /opt/relaybot
fi

# Create .env if it doesn't exist
if [ ! -f ".env" ]; then
  echo "📝 Creating .env file..."
  cat > .env << 'ENVEOF'
OPENAI_API_KEY=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
OPENAI_MODEL=gpt-4o
NOTION_EVENTS_DATABASE_ID=20611fb08c9e80a8af3fd734241bd980
NOTION_SECRET=ntn_r4826631326aE1H6x3o7cmgM8WL4wbfJuwge48Zwojj5ch
BREVO_API_KEY=xsmtpsib-00c4d91fb32882475d3c0470630ebdcfab03619ca25e9d6b5b6198250b1468ab-QEqK0W4zdzJEIK9U
BREVO_API_KEY2=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
ENVEOF
  chmod 600 .env
fi

# Build and start container
echo "🔨 Building and starting container..."
docker compose up -d --build

# Add to Caddyfile if not already there
if ! grep -q "bot.ciiic.nl" /opt/slidecreator/Caddyfile; then
  echo "🌐 Adding bot.ciiic.nl to Caddyfile..."
  cat >> /opt/slidecreator/Caddyfile << 'CADDYEOF'

bot.ciiic.nl {
  encode gzip
  reverse_proxy ciiic-automator:3000
}
CADDYEOF
  docker restart slidecreator-caddy
fi

echo ""
echo "✅ Done! Testing health endpoint..."
sleep 2
curl -s http://localhost:3000/health | head -c 200
echo ""
echo ""
echo "🎉 Relaybot deployed! Once DNS is set up, it will be available at https://bot.ciiic.nl"
