export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  ENVIRONMENT: string;
  /**
   * STAGE-ONLY test override of the 30-day opt-in age (design §6.3), so stage
   * can reach k = 5 eligible contributors on the day it ships. Set ONLY in the
   * stage vars. Ignored whenever ENVIRONMENT is "prod", whatever it says.
   */
  BENCH_MIN_OPTIN_DAYS?: string;
}
