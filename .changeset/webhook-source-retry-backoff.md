---
"@executor-js/sdk": patch
---

A webhook source that keeps failing backs off: its retries wait 30 seconds,
then twice as long after each failure in a row, up to an hour. A source whose
account's OAuth renewal the service keeps refusing no longer renews it every
30 seconds. Linking, configuring or unlinking the source runs it at once and
starts the count again. Storage version 4.0.15 adds the count.
