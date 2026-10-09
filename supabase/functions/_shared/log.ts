// Logging helpers shared by the Edge Functions.
// Logs must never contain a participant email. Database errors can echo the value that
// failed (for example, a unique-key error for an email), so we log only the message text.

// Hides anything that looks like an email address.
export function hideEmails(text: string): string {
  return text.replace(/[^\s@]+@[^\s@]+/g, "[email hidden]");
}

// Logs a server-side error message with a short label. Never send this text to the browser.
export function logError(context: string, message: string): void {
  console.error(context, hideEmails(message));
}
