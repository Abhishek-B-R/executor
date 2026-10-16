---
"apps": patch
"@executor-js/sdk": patch
---

`accountRouter` describes each distinct schema once. Accounts whose input
schemas are the same share one branch whose `accountId` is an `enum` of those
accounts, and identical output schemas appear once. A tool's schemas no longer
grow with every account linked to it, so a large API linked through several
accounts stays loadable. Calls still take `{ accountId, input }`, and each
account's input is still checked against its own schema.

A failed app call between the host and its runner Worker now names its kind,
such as a value over Workers RPC's size limit (`too-large`), instead of failing
without a reason.
