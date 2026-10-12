/**
 * The Worker's bindings, in their own module because the Durable Objects need
 * them too: a group sets an alarm for its reveal and has to reach the account
 * objects and the mailer when it fires. Importing this from `index.ts` would
 * make every object depend on the router that constructs it.
 */
export type Env = {
  GROUPS: DurableObjectNamespace;
  USERS: DurableObjectNamespace;
  RATE_LIMIT: DurableObjectNamespace;
  /** Set with `wrangler secret put AUTH_SECRET`; locally via .dev.vars. */
  AUTH_SECRET?: string;
  RATE_LIMIT_AUTH?: string;
  RATE_LIMIT_AUTH_ACCOUNT?: string;
  RATE_LIMIT_AUTH_ACCOUNT_WIDE?: string;
  RATE_LIMIT_WRITE?: string;
  RATE_LIMIT_READ?: string;
  /** PBKDF2 rounds; see `DEFAULT_PBKDF2_ITERATIONS` for the free-plan trade-off. */
  PBKDF2_ITERATIONS?: string;
  /** Brevo, for password-reset mail. Absent means reset is simply not offered. */
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  /**
   * Where links in scheduled mail point. A request-time handler takes the
   * origin from the request it is serving, but an alarm has no request — so
   * this is the one place the host has to be stated rather than observed.
   */
  APP_ORIGIN?: string;
};

