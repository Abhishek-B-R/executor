---
"@executor-js/sdk": patch
"apps": patch
"@executor-js/local-server": patch
"@executor-js/ui": patch
"@executor-js/app-templates": patch
---

Deployments are now called versions. The API serves `GET /v1/apps/:app/versions` and
`GET /v1/apps/:app/version`, and fields are named `version`, `activeVersion`,
`expectedVersion` and `versionOwner`. The former paths and field names still work:
requests may use either, and responses include both. Error codes are now
`VersionNotFound`, `VersionBuildFailed` and `AppVersionChanged`.
