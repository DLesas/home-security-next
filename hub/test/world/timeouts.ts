/**
 * The timeouts of tests that simulate a day or more on the whole hub (the loop, the real store,
 * scripted devices): one place, so none relies on Bun's default of 5 s. A day of home B takes
 * about 5 s alone on the development Mac and more on a loaded machine (the whole suite, or three
 * runs at once); these leave ten times that.
 */

/** A test that simulates up to one day of a home. */
export const DAY_TEST_TIMEOUT_MS = 60_000;

/** A test that simulates several days, or a day of the largest home. */
export const DAYS_TEST_TIMEOUT_MS = 180_000;
