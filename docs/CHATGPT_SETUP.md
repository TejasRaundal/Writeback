# ChatGPT setup

Writeback currently supports ChatGPT as a desktop-local plugin, not as a hosted remote MCP integration.

## Skills-only archive

Upload `dist/writeback-chatgpt-plugin.zip` through the plugin ZIP flow. It contains the portable manifest, skills, documentation, license, and existing icon. It is marked `requires_local_executor` because its workflows operate on a local project.

## Desktop-local MCP archive

`dist/writeback-local-mcp-plugin.zip` additionally bundles the stdio adapter and portable/Codex MCP configurations. OpenAI's documentation states that local MCP directory submissions are limited to approved partners and require organization allowlisting.

## Remote blocker

Hosted ChatGPT cannot call `127.0.0.1` or launch this repository's stdio process. Public remote submission requires a production HTTPS Streamable HTTP endpoint, authentication, project authorization, domain verification, current tool scans, legal/support URLs, and review materials. None are fabricated here.

Official references:

- <https://developers.openai.com/plugins/build/plugins>
- <https://developers.openai.com/plugins/deploy/desktop-only>
- <https://developers.openai.com/plugins/deploy/submission-errors>
