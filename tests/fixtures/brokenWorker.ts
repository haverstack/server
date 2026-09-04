/**
 * Stand-in for a worker that cannot boot at all — the shape of a fatal
 * misconfiguration (an unreadable or missing DB_PATH). Pins the pool's
 * respawn backoff: without one, a worker failing this way would respawn as
 * fast as the loop allows, forever.
 */
throw new Error('__fixture_boot_failure__');
