---
"@executor-js/utils": patch
"@executor-js/hosted-self-host": patch
"@executor-js/local-server": patch
---

Accept exact HTTPS origins in EXECUTOR_URL_ALLOW_HTTP_ORIGINS so self-host and local operators can opt in to private HTTPS MCP discovery and OAuth requests without changing the default network restrictions.
