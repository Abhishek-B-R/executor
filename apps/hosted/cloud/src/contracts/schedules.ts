/** A native minute heartbeat repairs coordinator alarms after a failed event or isolate restart. */
export const scheduleRecoveryMilliseconds = 60_000;

/**
 * How far past its time a stored alarm must be, while nothing explains the wait, before the
 * coordinators treat it as held by the runtime and write it again. Delivery is normally well
 * under a second late; held alarms waited 10 to 60 seconds.
 */
export const heldAlarmMilliseconds = 5_000;
