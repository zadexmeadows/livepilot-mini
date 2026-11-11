export const MAX_TRANSIENT_RETRIES = 5;

export function retryDelaySeconds(consecutiveFailures: number, intervalSeconds: number) {
  // Back off without ever shortening the user's interval. No rapid resend loop.
  return Math.max(intervalSeconds, Math.min(900, 60 * 2 ** Math.max(0, consecutiveFailures - 1)));
}

export function isTransientBrowserError(error: unknown) {
  if (!(error instanceof Error)) return false;
  // Never retry known authentication, challenge, enforcement or configuration errors.
  if (/captcha|unusual traffic|verify (?:your|you)|sign.in|profile.*lock|executable|sandbox|permission|access denied|ERR_CERT|ERR_SSL/i.test(error.message)) return false;
  return error.name === "TimeoutError" || /Timeout \d+ms exceeded|net::ERR_(?:CONNECTION|NETWORK|INTERNET|TIMED_OUT|NAME_NOT_RESOLVED|EMPTY_RESPONSE)|page.*closed|browser.*closed|context.*closed|Target closed|frame.*detached|Execution context was destroyed|page crashed/i.test(error.message);
}
