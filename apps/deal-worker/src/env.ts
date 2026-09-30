export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** RB2: the IO email goes out through notifications-worker (deal-worker is on its allow-list). */
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
