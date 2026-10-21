# REFERENCES — Fontes da pesquisa (out/2026)

Reverifique as fontes marcadas com ⚠️ antes de implementar: mudam com frequência.

## Claude Code (cérebro)
- ⚠️ CLI reference (flags de `-p`, `--system-prompt-file`, `--mcp-config`, `--strict-mcp-config`, `--tools`, `--permission-mode`, `--no-session-persistence`, `--bare`): https://code.claude.com/docs/en/cli-reference
- Permission modes (`dontAsk` para execuções sem supervisão): https://code.claude.com/docs/en/permission-modes
- Channels, research preview (Telegram, Discord, iMessage; custom só com flag de desenvolvimento, ignorada com `-p`): https://code.claude.com/docs/en/channels · https://code.claude.com/docs/en/channels-reference
- `claude setup-token` em servidor headless: https://gist.github.com/coenjacobs/d37adc34149d8c30034cd1f20a89cce9
- Relato de 401 do setup-token em sessões `--channels` longas: https://claudeissues.com/issue/78181-setup-token-claude-code-oauth-token-fails-with-401-in-long-running-claude-channe
- Relato de credencial salva tendo precedência sobre o token do ambiente: https://github.com/anthropics/claude-code/issues/80091
- ⚠️ Cobrança do uso programático: anúncio de pool separado (mai/2026) https://www.theregister.com/ai-ml/2026/05/14/anthropic-tosses-agents-into-the-api-billing-pool/5240748 · suspensão (jun/2026) https://wmedia.es/en/tips/claude-code-agent-sdk-credit · status em ago/2026 https://aicatchup.com/news/claude-code-weekly-limits-permanent-25-percent-september-2026

## WhatsApp
- ⚠️ Preços da Cloud API e mudança de out/2026 (1.000 mensagens de serviço grátis por número): https://respond.io/blog/whatsapp-pricing-change-2026 · https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Proibição de assistentes de IA de propósito geral na Business API (desde 15/01/2026): https://mobileecosystemforum.com/2025/12/01/metas-whatsapp-ai-chatbot-ban/ · escopo da regra: https://whapi.cloud/blog/meta-ai-bot-ban-whatsapp-automation-2026
- Bibliotecas não oficiais (Baileys, whatsapp-web.js etc.) e risco de ToS: https://whatsapp.checkleaked.cc/blog/best-open-source-whatsapp-libraries
- Alerta de malware em pacote "anti-ban" do ecossistema Baileys (abr/2026), citado no README de: https://github.com/kobie3717/baileys-antiban
- Baileys: https://github.com/WhiskeySockets/Baileys

## Projetos de referência
- my-fitness-claw / Clawdino (plugin Claude Code + Telegram; memória em markdown, base de evidências, personas; D-033): https://github.com/pablo-aa/my-fitness-claw
- ai-fitness-coach (Claude Code + WhatsApp + SQLite; CLI de domínio): https://github.com/Rich627/ai-fitness-coach
- Tracker de progressão de carga com OpenClaw (log por Telegram ou WhatsApp, regra de progressão): https://www.hostinger.com/ph/tutorials/build-progressive-overload-tracker-openclaw/

## Saúde e wearable
- HC Webhook (Health Connect → webhook; Play Store; headers customizados): https://github.com/mcnaveen/health-connect-webhook · schema do payload: https://github.com/mcnaveen/health-connect-webhook/blob/main/docs/webhook.md
- Mi Fitness → Health Connect (Redmi Watch 3/4/5: passos, FC, sono, calorias): https://www.fitmesh.fit/en/blog/xiaomi-amazfit-health-connect-data-dashboard
- Fitbit Web API → Google Health API (contexto; não usado): https://developers.google.com/health/about

## Nutrição
- TACO (NEPA/Unicamp) e dados estruturados: https://github.com/raulfdm/taco-api
- IBGE — Tabela de Medidas Referidas para os Alimentos Consumidos no Brasil (POF 2008–2009), em ibge.gov.br
- Open Food Facts API: https://openfoodfacts.github.io/openfoodfacts-server/api/
- Avaliação de ChatGPT, Claude e Gemini estimando peso e energia por foto (erro médio ~36%): https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12513282/
- Decomposição em duas etapas melhora a estimativa (MetaFood, CVPR 2025): https://cvpr.thecvf.com/virtual/2025/35662
- Contexto e tabela de composição como aterramento (refeitório, Finlândia): https://www.utupub.fi/items/f68fff63-4599-447d-a92b-9ed9e823277f/full
- Como apps pagos fazem: SnapCalorie (LiDAR, base USDA, revisores humanos) https://apps.apple.com/us/app/-/id1574239307 · teardown do Cal AI https://www.raftlabs.com/blog/cal-ai-product-teardown

## Exercícios
- free-exercise-db (domínio público, ~870 exercícios em JSON): https://github.com/yuhonas/free-exercise-db

## Infraestrutura
- ⚠️ Corte do Always Free A1 para 2 OCPU / 12 GB (2026): https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/ · https://terminalbytes.com/oracle-cloud-free-tier-changes-2026

## Contexto (descartados)
- Hevy: API pública só para assinantes Pro: https://api.hevyapp.com/docs/
